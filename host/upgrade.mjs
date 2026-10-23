import { writeFileSync } from 'node:fs';
import { exec, first, scratch, UsageError, VERSION, write } from './common.mjs';

export const RELEASE = 'https://github.com/ai-ecoverse/slicc-audio/releases/latest/download';

export const variable = (name) => `${name.toUpperCase()}_INSTALL_DIR`;

async function download(url) {
  try {
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(60000) });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    return { body: Buffer.from(await res.arrayBuffer()) };
  } catch (error) {
    return { error: error.cause?.message ?? error.message };
  }
}

export async function upgrade({ name, env, platform, fds, dir }) {
  if (!dir) {
    write(fds[1], 'npm install -g @ai-ecoverse/slicc-audio@latest\n');
    return 0;
  }
  const windows = platform === 'win32';
  const script = windows ? 'install.ps1' : 'install.sh';
  const url = `${(env.SLICC_INSTALL_BASE_URL || RELEASE).replace(/\/+$/, '')}/${script}`;
  const fetched = await download(url);
  if (fetched.error) {
    write(fds[2], `${name}: could not download ${url}: ${fetched.error}\n`);
    return 1;
  }
  const tmp = scratch();
  try {
    const file = tmp.file(script);
    writeFileSync(file, fetched.body);
    const tools = windows ? ['powershell.exe', 'pwsh.exe'] : ['sh'];
    const tool = first(tools, platform, env);
    if (!tool) {
      write(fds[2], `${name}: no shell found to run ${script} (tried ${tools.join(', ')})\n`);
      return 1;
    }
    const args = windows
      ? ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file, '-Dir', dir]
      : [file, '--dir', dir];
    const result = await exec(tool.path, args, { env, stderr: fds[2] });
    if (result.error) {
      write(fds[2], `${name}: ${tool.file}: ${result.error.message}\n`);
      return 1;
    }
    if (result.code !== 0) return 1;
    const installed = new RegExp(`^${name} (\\S+) installed to `, 'm').exec(
      result.stdout.toString()
    )?.[1];
    if (!installed) {
      write(fds[2], `${name}: ${script} did not say which version it installed\n`);
      return 1;
    }
    write(
      fds[1],
      installed === VERSION
        ? `${name}: already up to date (${VERSION})\n`
        : `${name}: ${VERSION} → ${installed}\n`
    );
    return 0;
  } finally {
    tmp.done();
  }
}

const META = ['--version', '--upgrade'];

export async function meta({ name, argv, env, platform, fds, version = [] }) {
  const dir = env[variable(name)];
  const clean = { ...env };
  for (const cmd of ['scsay', 'schear', 'scplay', 'scchime']) delete clean[variable(cmd)];
  if (argv.length === 1 && argv[0] === '--upgrade') {
    return { env: clean, code: await upgrade({ name, env: clean, platform, fds, dir }) };
  }
  if (argv.length === 1 && [...META, ...version].includes(argv[0])) {
    write(fds[1], `${VERSION}\n`);
    return { env: clean, code: 0 };
  }
  return { env: clean };
}

export function metaFlags(version = []) {
  return { flags: [...META, ...version], key: 'meta' };
}

export function noMeta(opts, order) {
  if (opts.meta)
    throw new UsageError(`${order.find((e) => e.key === 'meta').flag} takes no other arguments`);
}
