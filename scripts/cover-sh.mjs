import { appendFileSync, existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join, posix, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const traces = join(root, 'coverage/sh');
const lcov = join(root, 'coverage/unit/lcov.info');
const skip = [
  /^\s*$/,
  /^#!/,
  /^\s*(\}|fi|done|esac|;;|else|then|do|EOF|')\s*$/,
  /^\s*done <.*$/,
  /^\s*[\w-]+\(\)\s*\{\s*$/,
  /^\s*[^()]+\)\s*(;;)?\s*$/,
  /='$/,
  /^\$\{?[^\s]*\}?$/,
];

function executable(source) {
  const lines = [];
  source.split('\n').forEach((text, index) => {
    if (!skip.some((pattern) => pattern.test(text))) lines.push(index + 1);
  });
  return lines;
}

const files = ['bin', 'sh'].flatMap((dir) =>
  readdirSync(join(root, dir)).map((name) => `${dir}/${name}`)
);
const counts = new Map(files.map((file) => [file, new Map()]));
if (existsSync(traces)) {
  for (const name of readdirSync(traces)) {
    for (const line of readFileSync(join(traces, name), 'utf8').split('\n')) {
      const match = /^\++(\S*?slicc-audio\/(\S+)):(\d+): /.exec(line);
      if (!match) continue;
      const file = posix.normalize(match[2]);
      const seen = counts.get(file);
      if (!seen) continue;
      const at = Number(match[3]);
      seen.set(at, (seen.get(at) ?? 0) + 1);
    }
  }
  rmSync(traces, { recursive: true, force: true });
}
let text = '';
let missed = 0;
for (const file of files) {
  const lines = executable(readFileSync(join(root, file), 'utf8'));
  const seen = counts.get(file);
  const holes = lines.filter((line) => !seen.get(line));
  missed += holes.length;
  text += `SF:${file}\n${lines.map((line) => `DA:${line},${seen.get(line) ?? 0}\n`).join('')}`;
  text += `LF:${lines.length}\nLH:${lines.length - holes.length}\nend_of_record\n`;
  console.log(
    `${file}: ${lines.length - holes.length}/${lines.length}${holes.length ? ` missed ${holes.join(',')}` : ''}`
  );
}
if (existsSync(lcov)) appendFileSync(lcov, text);
else console.log('cover-sh: no coverage/unit/lcov.info to append to');
console.log(`cover-sh: ${missed} lines missed`);
