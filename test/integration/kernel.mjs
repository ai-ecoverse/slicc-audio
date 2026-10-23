import { appendFileSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { createNodeKernel } from '@ai-ecoverse/slicc-kernel/node';
import { createNodeKernel as createOldKernel } from 'slicc-kernel-without-embedder/node';

export const root = resolve(import.meta.dirname, '../..');
export const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
export const modules = `/node_modules/${pkg.name}`;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

const trace = process.env.SLICC_AUDIO_TRACE;
const TRACE = "exec 9>>/tmp/.trace; BASH_XTRACEFD=9; PS4='+${BASH_SOURCE}:${LINENO}: '; set -x; ";

function traced(name, rel, bytes) {
  if (!trace || name !== pkg.name || !rel.startsWith('bin/')) return bytes;
  const lines = bytes.toString().split('\n');
  lines[1] = TRACE + lines[1];
  return lines.join('\n');
}

async function install(kernel, name, dir, files, at = '/node_modules') {
  for (const path of files) {
    const rel = relative(dir, path).replaceAll('\\', '/');
    await kernel.writeFile(`${at}/${name}/${rel}`, traced(name, rel, readFileSync(path)));
  }
}

async function collect(kernel) {
  if (!trace) return;
  let text = '';
  try {
    text = new TextDecoder().decode(await kernel.readFile('/tmp/.trace'));
  } catch {
    return;
  }
  mkdirSync(trace, { recursive: true });
  appendFileSync(join(trace, `${process.pid}.trace`), text);
}

export async function boot(options = {}, { create = createNodeKernel, at, manifest } = {}) {
  const kernel = await create(options);
  for (const name of ['@ai-ecoverse/wasm-bash', '@ai-ecoverse/wasm-coreutils']) {
    const dir = join(root, 'node_modules', name);
    await install(kernel, name, dir, walk(dir));
  }
  const own = pkg.files.flatMap((file) => walk(join(root, file)));
  await install(kernel, pkg.name, root, own, at);
  await kernel.writeFile(
    `${at ?? '/node_modules'}/${pkg.name}/package.json`,
    `${JSON.stringify(manifest ?? pkg, null, 2)}\n`
  );
  return {
    kernel,
    sh: (script, opts = {}) => kernel.run(['sh', '-c', script], { cwd: '/tmp', ...opts }),
    close: async () => {
      await collect(kernel);
      kernel.terminate();
    },
  };
}

export const bootOld = (options = {}, manifest) =>
  boot(options, { create: createOldKernel, manifest });

export async function bytes(body) {
  const chunks = [];
  if (body) for await (const chunk of body) chunks.push(chunk);
  return Buffer.concat(chunks);
}

export function fakePage(
  kinds = ['audio.play', 'audio.say', 'audio.voices', 'audio.record', 'audio.transcribe']
) {
  const page = {
    calls: [],
    answer: async () => '',
    kinds: Object.fromEntries(kinds.map((kind) => [kind, {}])),
    async handle({ kind, options, body, stamp, signal }) {
      const call = { kind, options, body: await bytes(body), stamp, signal };
      page.calls.push(call);
      return page.answer(call);
    },
  };
  return page;
}
