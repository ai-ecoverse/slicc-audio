import { spawn } from 'node:child_process';
import {
  accessSync,
  constants,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

export const root = new URL('..', import.meta.url);
export const VERSION = JSON.parse(readFileSync(new URL('package.json', root), 'utf8')).version;

export class UsageError extends Error {}

export class Failure extends Error {}

export function write(fd, data) {
  const buffer = typeof data === 'string' ? Buffer.from(data) : data;
  let at = 0;
  while (at < buffer.length) at += writeSync(fd, buffer, at);
}

export function runnable(path, platform) {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, platform === 'win32' ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function lookup(file, platform, env) {
  const path = (platform === 'win32' ? (env.PATH ?? env.Path) : env.PATH) ?? '';
  for (const dir of path.split(platform === 'win32' ? ';' : ':')) {
    if (dir && runnable(join(dir, file), platform)) return join(dir, file);
  }
  return undefined;
}

export function first(files, platform, env) {
  for (const file of files) {
    const path = lookup(file, platform, env);
    if (path) return { file, path };
  }
  return undefined;
}

export function unsupported(option, platform) {
  return new UsageError(
    `${option} isn't supported on ${platform === 'win32' ? 'windows' : platform}`
  );
}

export function exec(
  path,
  args,
  { env, stdin, stdout = 'pipe', stderr = 'pipe', input, seconds, onErr } = {}
) {
  return new Promise((resolve) => {
    const child = spawn(path, args, {
      env,
      stdio: [stdin ?? (input === undefined ? 'ignore' : 'pipe'), stdout, stderr],
      shell: false,
      windowsHide: true,
    });
    const out = [];
    const err = [];
    let timedOut = false;
    let timer;
    if (seconds !== undefined) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
      }, seconds * 1000);
    }
    child.stdout?.on('data', (chunk) => out.push(chunk));
    child.stderr?.on('data', (chunk) => {
      err.push(chunk);
      onErr?.(chunk, child);
    });
    if (input !== undefined) {
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    }
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: 1, error, stdout: Buffer.concat(out), stderr: Buffer.concat(err) });
    });
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({
        code: timedOut ? 0 : (status ?? 1),
        timedOut,
        stdout: Buffer.concat(out),
        stderr: Buffer.concat(err),
        child,
      });
    });
  });
}

export function failed(name, file, result) {
  if (result.error) return new Failure(`${file}: ${result.error.message}`);
  const text = result.stderr?.toString().trim();
  return new Failure(text || `${file} failed (exit ${result.code})`);
}

export function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'slicc-audio-'));
  return {
    dir,
    file: (name) => join(dir, name),
    done: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export function encoded(lines) {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false',
    'try {',
    ...lines.map((line) => `  ${line}`),
    '} catch {',
    '  [Console]::Error.WriteLine($_.Exception.Message)',
    '  exit 1',
    '}',
  ].join('\n');
  return [
    '-NoProfile',
    '-NonInteractive',
    '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64'),
  ];
}

export function cacheDir(platform, env) {
  if (env.SLICC_AUDIO_CACHE) return env.SLICC_AUDIO_CACHE;
  const home = env.HOME || env.USERPROFILE || homedir();
  if (platform === 'darwin') return join(home, 'Library', 'Caches', 'slicc-audio');
  if (platform === 'win32')
    return join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'slicc-audio', 'Cache');
  return join(env.XDG_CACHE_HOME || join(home, '.cache'), 'slicc-audio');
}

export function hubCache(env) {
  if (env.HF_HUB_CACHE) return env.HF_HUB_CACHE;
  if (env.HF_HOME) return join(env.HF_HOME, 'hub');
  if (env.XDG_CACHE_HOME) return join(env.XDG_CACHE_HOME, 'huggingface', 'hub');
  return join(env.HOME || env.USERPROFILE || homedir(), '.cache', 'huggingface', 'hub');
}

function optionValue(option, flag, arg, eq, argv, i) {
  if (option.value === 'optional') return { value: eq > 0 ? arg.slice(eq + 1) : true, used: 0 };
  if (!option.value) {
    if (eq > 0) throw new UsageError(`${flag} takes no value`);
    return { value: true, used: 0 };
  }
  if (eq > 0) return { value: arg.slice(eq + 1), used: 0 };
  if (i + 1 >= argv.length) throw new UsageError(`${flag} needs a value`);
  return { value: argv[i + 1], used: 1 };
}

export function parseArgs(argv, spec) {
  const byFlag = new Map();
  for (const option of spec) for (const flag of option.flags) byFlag.set(flag, option);
  const opts = {};
  const order = [];
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      rest.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith('-') || arg === '-') {
      rest.push(arg);
      continue;
    }
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
    const flag = eq > 0 ? arg.slice(0, eq) : arg;
    const option = byFlag.get(flag);
    if (!option) throw new UsageError(`unknown option: ${arg}`);
    const { value, used } = optionValue(option, flag, arg, eq, argv, i);
    const raw = argv.slice(i, i + 1 + used);
    i += used;
    opts[option.key] = value;
    order.push({ key: option.key, flag, value, raw });
  }
  return { opts, order, rest };
}

export function number(flag, value, min, max, { above = false } = {}) {
  const n = Number(value);
  if (
    value === '' ||
    typeof value !== 'string' ||
    !Number.isFinite(n) ||
    (above ? n <= min : n < min) ||
    n > max
  ) {
    throw new UsageError(
      `${flag} ${value}: ${above ? 'more than' : 'from'} ${min} ${above ? 'and at most' : 'to'} ${max}`
    );
  }
  return n;
}

export function words(command) {
  const out = [];
  let word = '';
  let quote = '';
  let has = false;
  for (const ch of command) {
    if (quote) {
      if (ch === quote) quote = '';
      else word += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (has || word) out.push(word);
      word = '';
      has = false;
    } else word += ch;
  }
  if (has || word) out.push(word);
  return out;
}

export function lang(value) {
  if (!/^[A-Za-z]{2,3}([-_][A-Za-z0-9]{2,8})*$/.test(value))
    throw new UsageError(`-l ${value}: not a language tag`);
  const parts = value.split(/[-_]/);
  return [
    parts[0].toLowerCase(),
    ...parts.slice(1).map((p) => (p.length === 2 ? p.toUpperCase() : p)),
  ].join('-');
}
