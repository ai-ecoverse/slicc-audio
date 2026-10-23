import { createHash } from 'node:crypto';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { cacheDir, exec, Failure, failed, first, write } from './common.mjs';
import { Unavailable } from './engines.mjs';

export function whisperHints(platform) {
  if (platform === 'darwin')
    return {
      both: 'brew install whisper-cpp ffmpeg',
      ffmpeg: 'brew install ffmpeg',
      whisper: 'brew install whisper-cpp',
    };
  if (platform === 'win32') {
    return {
      both: 'whisper-bin-x64.zip from github.com/ggml-org/whisper.cpp/releases, and winget install Gyan.FFmpeg',
      ffmpeg: 'winget install Gyan.FFmpeg',
      whisper: 'whisper-bin-x64.zip from github.com/ggml-org/whisper.cpp/releases',
    };
  }
  const whisper =
    "your distribution's whisper-cpp package, or a build from github.com/ggml-org/whisper.cpp";
  return { both: `${whisper}, and ffmpeg`, ffmpeg: "your distribution's ffmpeg package", whisper };
}

export function exe(platform, name) {
  return platform === 'win32' ? `${name}.exe` : name;
}

export function whisperTools(platform, env) {
  const cli = first([exe(platform, 'whisper-cli'), exe(platform, 'whisper-cpp')], platform, env);
  const ffmpeg = first([exe(platform, 'ffmpeg')], platform, env);
  const hints = whisperHints(platform);
  if (!cli && !ffmpeg) throw new Unavailable(`whisper-cli not found (${hints.both})`);
  if (!cli) throw new Unavailable(`whisper-cli not found (${hints.whisper})`);
  if (!ffmpeg) throw new Unavailable(`ffmpeg not found (${hints.ffmpeg})`);
  return { cli, ffmpeg };
}

export function modelPath(model, platform, env) {
  const id = model ?? 'base';
  if (id.endsWith('.bin') || id.includes('/') || id.includes('\\'))
    return { path: id, local: true };
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id))
    throw new Failure(`--model ${id}: not a whisper.cpp model name`);
  return {
    path: join(cacheDir(platform, env), `ggml-${id}.bin`),
    name: `ggml-${id}.bin`,
    local: false,
  };
}

async function follow(url) {
  let current = url;
  let etag;
  for (let hop = 0; hop < 6; hop++) {
    const res = await fetch(current, { redirect: 'manual' });
    etag ??= res.headers.get('x-linked-etag') ?? undefined;
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      await res.body?.cancel();
      current = new URL(res.headers.get('location'), current).href;
      continue;
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new Failure(`cannot download ${url}: HTTP ${res.status}`);
    }
    return { res, etag: etag?.replace(/^W\//, '').replace(/"/g, '') };
  }
  throw new Failure(`cannot download ${url}: too many redirects`);
}

export async function download({ name, file, model, env, fds }) {
  const endpoint = (env.HF_ENDPOINT || 'https://huggingface.co').replace(/\/+$/, '');
  const url = `${endpoint}/ggerganov/whisper.cpp/resolve/main/${model}`;
  let got;
  try {
    got = await follow(url);
  } catch (error) {
    if (error instanceof Failure) throw error;
    throw new Failure(`cannot download ${url}: ${error.cause?.message ?? error.message}`);
  }
  const { res, etag } = got;
  mkdirSync(join(file, '..'), { recursive: true });
  const part = `${file}.part`;
  const total = Number(res.headers.get('content-length')) || 0;
  const hash = createHash('sha256');
  const out = createWriteStream(part);
  let size = 0;
  let shown = -1;
  try {
    for await (const chunk of res.body) {
      hash.update(chunk);
      size += chunk.length;
      if (!out.write(chunk)) await new Promise((resolve) => out.once('drain', resolve));
      const pct = total ? Math.floor((size * 100) / total) : -1;
      if (pct !== shown && pct % 10 === 0) {
        shown = pct;
        write(fds[2], `${name}: downloading ${model}: ${pct}%\n`);
      }
    }
  } finally {
    await new Promise((resolve) => out.end(resolve));
  }
  const digest = hash.digest('hex');
  if (!etag || digest !== etag.toLowerCase()) {
    rmSync(part, { force: true });
    throw new Failure(`${model}: SHA-256 ${digest} doesn't match the hub's ${etag ?? '(none)'}`);
  }
  renameSync(part, file);
}

export async function ensureModel({ name, model, platform, env, fds }) {
  const where = modelPath(model, platform, env);
  if (existsSync(where.path)) return where.path;
  if (where.local) throw new Failure(`cannot open ${where.path}: No such file`);
  await download({ name, file: where.path, model: where.name, env, fds });
  return where.path;
}

export async function toWav({ name, ffmpeg, input, output, env }) {
  const result = await exec(
    ffmpeg.path,
    [
      '-nostdin',
      '-loglevel',
      'error',
      '-i',
      input,
      '-ar',
      '16000',
      '-ac',
      '1',
      '-c:a',
      'pcm_s16le',
      '-f',
      'wav',
      output,
    ],
    { env }
  );
  if (result.code !== 0) throw failed(name, 'ffmpeg', result);
}

export async function whisperRun({ name, cli, model, wav, language, format, env }) {
  const args = ['-m', model, '-f', wav, '-l', language ?? 'auto', '-np'];
  if (format === 'json') args.push('-nt');
  if (format === 'srt') args.push('-nt', '-osrt');
  const result = await exec(cli.path, args, { env });
  if (result.code !== 0) throw failed(name, cli.file, result);
  if (format === 'srt') return { srt: readFileSync(`${wav}.srt`, 'utf8') };
  const lines = result.stdout
    .toString('utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (format === 'verbose_json') {
    return { lines: lines.map((line) => line.replace(/^(\[[^\]]+\])\s*/, '$1 ')) };
  }
  return { lines };
}
