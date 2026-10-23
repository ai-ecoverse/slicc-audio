import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { exec, Failure, lookup, root, words, write } from './common.mjs';

export class Unavailable extends Error {
  constructor(reason, status = reason) {
    super(reason);
    this.status = status;
  }
}

const ORTLLAMA = '@ai-ecoverse/slicc-ortllama';

export async function loadOrtllama() {
  const mod = await import(ORTLLAMA);
  const index = import.meta.resolve(ORTLLAMA);
  const manifest = JSON.parse(readFileSync(new URL('../package.json', index), 'utf8'));
  const backend = (path) => async (options) =>
    (await import(new URL(path, index))).loadBackend(options);
  return {
    startServer: mod.startServer,
    createRuntime: mod.createRuntime,
    backends: [backend('./ort/node.js'), backend('./ort/web.js')],
    onnx: manifest.peerDependencies?.['onnxruntime-node'],
  };
}

export function runtimeFix(onnx, dir = fileURLToPath(root).replace(/[\\/]$/, '')) {
  const prefix = /^[\w@%+=:,./\\-]+$/.test(dir) ? dir : `"${dir}"`;
  const spec = onnx ? `onnxruntime-node@${onnx}` : 'onnxruntime-node';
  return `npm install --prefix ${prefix} --no-save --ignore-scripts ${spec}`;
}

export async function ortRuntime(mod, env) {
  for (const load of mod.backends ?? []) {
    try {
      const backend = await load({ env });
      return mod.createRuntime({ env, backend: async () => backend });
    } catch {}
  }
  throw new Unavailable(`no ONNX Runtime (${runtimeFix(mod.onnx)})`);
}

export async function serve(load, env) {
  const mod = await loadModule(load);
  const runtime = await ortRuntime(mod, env);
  return mod.startServer({ port: 0, host: '127.0.0.1', env, runtime });
}

export async function ortllamaTools(load, env) {
  await ortRuntime(await loadModule(load), env);
}

const KOKORO_LANGS = {
  'en-US': 'af_heart',
  en: 'af_heart',
  'en-GB': 'bf_emma',
  es: 'ef_dora',
  fr: 'ff_siwis',
  hi: 'hf_alpha',
  it: 'if_sara',
  pt: 'pf_dora',
};

export function kokoroVoice(tag) {
  return KOKORO_LANGS[tag] ?? KOKORO_LANGS[tag.split('-')[0]];
}

export async function ortllamaVoices(base, model) {
  const query = model ? `?model=${encodeURIComponent(model)}` : '';
  try {
    const res = await fetch(`${base}/v1/audio/voices${query}`);
    if (!res.ok) return [];
    const data = (await res.json()).data ?? [];
    return data.map((v) => ({
      name: v.id,
      lang: String(v.language ?? 'en-US').replace('-', '_'),
      default: v.id === 'af_heart',
    }));
  } catch {
    return [];
  }
}

export function matchVoice(voices, wanted) {
  const lower = wanted.toLowerCase();
  return (
    voices.find((v) => v.name.toLowerCase().startsWith(lower)) ??
    voices.find((v) => v.name.toLowerCase().includes(lower))
  );
}

export function ollamaBase(env) {
  const host = (env.OLLAMA_HOST || '127.0.0.1:11434').trim();
  if (/^https?:\/\//i.test(host)) return host.replace(/\/+$/, '');
  return `http://${/:\d+$/.test(host) ? host : `${host}:11434`}`;
}

export function loopback(base) {
  const host = new URL(base).hostname;
  return host === 'localhost' || host === '[::1]' || host.startsWith('127.');
}

export function hint(message) {
  return /hf download[^\n]*/.exec(message)?.[0];
}

async function call(url, init) {
  let res;
  try {
    res = await fetch(url, init);
  } catch (error) {
    return { offline: true, error };
  }
  const body = Buffer.from(await res.arrayBuffer());
  let message = body.toString('utf8');
  try {
    message = JSON.parse(message).error?.message ?? message;
  } catch {}
  return { status: res.status, body, message: res.ok ? '' : message };
}

export async function speech(base, request) {
  return call(`${base}/v1/audio/speech`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  });
}

export async function transcription(base, { file, name, model, language, format }) {
  const form = new FormData();
  form.append('file', new Blob([file]), name);
  if (model) form.append('model', model);
  if (language) form.append('language', language);
  form.append('response_format', format);
  return call(`${base}/v1/audio/transcriptions`, { method: 'POST', body: form });
}

export async function models(base) {
  const res = await call(`${base}/v1/models`, {});
  if (res.offline || res.status !== 200) return res;
  try {
    return { ...res, data: JSON.parse(res.body.toString('utf8')).data ?? [] };
  } catch {
    return { ...res, data: [] };
  }
}

export function listed(data, id) {
  const entry = data.find((m) => m.id === id || m.id === `${id}:latest`);
  return entry && (entry.ortllama?.alias_of ?? entry.id);
}

export async function loadModule(load) {
  try {
    return await load();
  } catch {
    throw new Unavailable(
      '@ai-ecoverse/slicc-ortllama not installed (an optional dependency of slicc-audio; reinstall slicc-audio)',
      'not installed (reinstall slicc-audio to get @ai-ecoverse/slicc-ortllama)'
    );
  }
}

export async function withOrtllama(load, env, fn) {
  const server = await serve(load, env);
  try {
    return await fn(server.url);
  } finally {
    await server.close();
  }
}

export function ortllamaMissing(res) {
  const command = hint(res.message) ?? res.message.trim();
  return new Unavailable(`model not cached (${command})`, `not cached (${command})`);
}

export function offline(base) {
  return new Unavailable(
    `no server at ${base} (install Ollama from https://ollama.com, then ollama serve)`
  );
}

export function checked(res, missing) {
  if (res.status === 404) throw missing();
  if (res.status < 200 || res.status >= 300)
    throw new Failure(res.message.trim() || `HTTP ${res.status}`);
  return res.body;
}

export async function ortllamaStatus(base, { role, model, probe }) {
  const list = await models(base);
  const ready = list.data && listed(list.data, model ?? role);
  if (ready) return { ready };
  const res = await probe();
  if (res.offline) throw new Failure(res.error.message);
  if (res.status === 404) return { missing: hint(res.message) ?? res.message.trim() };
  return { ready: model ?? role };
}

export async function warmOrtllama({ name, command, platform, env, fds }) {
  const hf = lookup(platform === 'win32' ? 'hf.exe' : 'hf', platform, env);
  if (!hf) {
    write(fds[2], `${name}: hf not found; run: ${command}\n`);
    return 1;
  }
  const argv = words(command).slice(1);
  const result = await exec(hf, argv, { env, stdin: 'ignore', stdout: fds[2], stderr: fds[2] });
  return result.code === 0 ? 0 : 1;
}

export async function status(engines, ctx) {
  for (const e of ctx.engines) write(ctx.fds[1], `${e}: ${await engines[e].status(ctx)}\n`);
  return 0;
}

export async function warm(engines, ctx, none) {
  const reasons = [];
  for (const e of ctx.engines) {
    try {
      await engines[e].tools(ctx);
    } catch (error) {
      reasons.push([e, error.message]);
      continue;
    }
    return engines[e].warmup(ctx);
  }
  throw none(reasons);
}
