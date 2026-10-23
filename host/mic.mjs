import { exec, Failure, failed, first, lookup } from './common.mjs';
import { exe } from './whisper.mjs';

export async function pulse(platform, env) {
  const pactl = lookup('pactl', platform, env);
  if (!pactl) return false;
  return (await exec(pactl, ['info'], { env })).code === 0;
}

function avfoundation(text) {
  const list = [];
  let audio = false;
  for (const line of text.split(/\r?\n/)) {
    if (/audio devices:/i.test(line)) audio = true;
    else if (/video devices:/i.test(line)) audio = false;
    const m = /\]\s*\[(\d+)\]\s*(.+)$/.exec(line);
    if (audio && m) list.push([m[1], m[2].trim()]);
  }
  return list;
}

function dshow(text) {
  return [...text.matchAll(/"([^"]+)"\s*\(audio\)/g)].map((m) => [m[1], m[1]]);
}

function arecordList(text) {
  const list = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const last = list.at(-1);
    if (!/^\s/.test(line)) list.push([line.trim(), line.trim()]);
    else if (last && last[1] === last[0]) last[1] = line.trim();
  }
  return list;
}

async function ffmpegDevices({ ffmpeg, platform, env }) {
  if (!ffmpeg) throw new Failure('ffmpeg not found, which lists the microphones');
  const args =
    platform === 'darwin'
      ? ['-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', '']
      : ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'];
  const text = (await exec(ffmpeg.path, args, { env })).stderr.toString('utf8');
  return platform === 'darwin' ? avfoundation(text) : dshow(text);
}

export async function devices({ name, ffmpeg, platform, env }) {
  if (platform === 'darwin' || platform === 'win32')
    return ffmpegDevices({ ffmpeg, platform, env });
  if (await pulse(platform, env)) {
    const result = await exec(lookup('pactl', platform, env), ['list', 'short', 'sources'], {
      env,
    });
    if (result.code !== 0) throw failed(name, 'pactl', result);
    return result.stdout
      .toString('utf8')
      .split('\n')
      .map((line) => line.split('\t'))
      .filter((cols) => cols.length > 1)
      .map((cols) => [cols[1], cols[1]]);
  }
  const arecord = lookup('arecord', platform, env);
  if (!arecord) throw new Failure('neither pactl nor arecord found, which list the microphones');
  const result = await exec(arecord, ['-L'], { env });
  if (result.code !== 0) throw failed(name, 'arecord', result);
  return arecordList(result.stdout.toString('utf8'));
}

export async function source({ name, ffmpeg, platform, env, device }) {
  if (platform === 'darwin') return ['-f', 'avfoundation', '-i', `:${device ?? '0'}`];
  if (platform === 'win32') {
    let id = device;
    if (!id) {
      id = (await devices({ name, ffmpeg, platform, env }))[0]?.[0];
      if (!id) throw new Failure('no microphone found');
    }
    return ['-f', 'dshow', '-i', `audio=${id}`];
  }
  return ['-f', (await pulse(platform, env)) ? 'pulse' : 'alsa', '-i', device ?? 'default'];
}

export async function record({ name, ffmpeg, input, seconds, file, env }) {
  let spoke = false;
  let silent = false;
  let stopped = false;
  let buffer = '';
  const onErr = (chunk, child) => {
    buffer += chunk.toString('utf8');
    let at = buffer.indexOf('\n');
    while (at >= 0) {
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      const start = /silence_start:\s*(-?[\d.]+)/.exec(line);
      if (/silence_end:/.test(line)) spoke = true;
      if (start && Number(start[1]) > 0.05) spoke = true;
      if (start && Number(start[1]) <= 0.05 && !spoke) silent = true;
      if (start && spoke && !stopped) {
        stopped = true;
        child.stdin.write('q');
      }
      at = buffer.indexOf('\n');
    }
  };
  const args = [
    '-hide_banner',
    '-loglevel',
    'info',
    ...input,
    '-t',
    String(seconds),
    '-af',
    'silencedetect=noise=-30dB:d=1',
    '-ar',
    '16000',
    '-ac',
    '1',
    '-c:a',
    'pcm_s16le',
    '-y',
    file,
  ];
  const result = await exec(ffmpeg.path, args, { env, stdin: 'pipe', onErr });
  if (result.code !== 0 && !stopped) throw failed(name, 'ffmpeg', result);
  return { spoke: spoke || !silent, paused: stopped };
}

export function ffmpegOf(platform, env) {
  return first([exe(platform, 'ffmpeg')], platform, env);
}
