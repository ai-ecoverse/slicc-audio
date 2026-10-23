import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec, lookup, root, scratch, VERSION, write } from './common.mjs';

export const RELEASE = 'https://github.com/ai-ecoverse/slicc-audio/releases/latest/download';

export function installed(dir = realpathSync(fileURLToPath(root))) {
  try {
    const data = dirname(dir);
    const info = JSON.parse(readFileSync(join(data, 'install.json'), 'utf8'));
    if (basename(dir) !== info.version || typeof info.dir !== 'string') return undefined;
    return { data, dir: info.dir, version: info.version };
  } catch {
    return undefined;
  }
}

export async function upgrade({ name, env, platform, fds, install = installed() }) {
  if (!install) {
    write(fds[1], 'npm install -g @ai-ecoverse/slicc-audio@latest\n');
    return 0;
  }
  const windows = platform === 'win32';
  const script = windows ? 'install.ps1' : 'install.sh';
  const url = `${(env.SLICC_INSTALL_BASE_URL || RELEASE).replace(/\/+$/, '')}/${script}`;
  const tmp = scratch();
  try {
    let body;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      body = Buffer.from(await res.arrayBuffer());
    } catch (error) {
      write(fds[2], `${name}: cannot download ${url}: ${error.cause?.message ?? error.message}\n`);
      return 1;
    }
    const file = tmp.file(script);
    writeFileSync(file, body);
    const shell = windows ? 'powershell.exe' : 'sh';
    const path = lookup(shell, platform, env);
    if (!path) {
      write(fds[2], `${name}: ${shell} not found\n`);
      return 1;
    }
    const args = windows
      ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file, '-Dir', install.dir]
      : [file, '--dir', install.dir];
    const result = await exec(path, args, { env, stdout: 'ignore' });
    if (result.code !== 0) {
      if (result.stderr.length) write(fds[2], result.stderr);
      else write(fds[2], `${name}: the installer failed (exit ${result.code})\n`);
      return 1;
    }
    let next = VERSION;
    try {
      next = JSON.parse(readFileSync(join(install.data, 'install.json'), 'utf8')).version;
    } catch {}
    write(
      fds[1],
      next === VERSION
        ? `${name}: already up to date (${VERSION})\n`
        : `${name}: ${VERSION} → ${next}\n`
    );
    return 0;
  } finally {
    tmp.done();
  }
}

export async function meta({ name, argv, env, platform, fds, install, version = ['--version'] }) {
  if (argv.includes('--upgrade')) {
    if (argv.length !== 1) return { usage: '--upgrade takes no other arguments' };
    return { code: await upgrade({ name, env, platform, fds, install }) };
  }
  if (argv.some((arg) => version.includes(arg))) {
    write(fds[1], `${name} ${VERSION}\n`);
    return { code: 0 };
  }
  return undefined;
}
