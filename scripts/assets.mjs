import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const [dir, version] = process.argv.slice(2);
if (!dir || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version ?? '')) {
  console.error('usage: node scripts/assets.mjs DIR VERSION');
  process.exit(2);
}
const root = resolve(import.meta.dirname, '..');
const packed = join(resolve(dir), `ai-ecoverse-slicc-audio-${version}.tgz`);
const name = `slicc-audio-${version}.tgz`;
const tarball = join(resolve(dir), name);
if (existsSync(packed)) renameSync(packed, tarball);
if (!existsSync(tarball)) {
  console.error(`scripts/assets.mjs: no ${packed}`);
  process.exit(1);
}
const sum = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const lines = [
  `${sum(tarball)}  ${name}`,
  `${sum(join(root, 'install.sh'))}  install.sh`,
  `${sum(join(root, 'install.ps1'))}  install.ps1`,
];
writeFileSync(join(resolve(dir), 'SHA256SUMS'), `${lines.join('\n')}\n`);
console.log(lines.join('\n'));
