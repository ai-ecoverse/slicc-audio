import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';

export const scratch = mkdtempSync(join(realpathSync(tmpdir()), 'slicc-audio-test-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

export function temp(prefix) {
  return mkdtempSync(join(scratch, `${prefix}-`));
}

export function tone(seconds = 0.1, rate = 24000) {
  const n = Math.round(seconds * rate);
  const out = Buffer.alloc(44 + n * 2);
  out.write('RIFF', 0, 'ascii');
  out.writeUInt32LE(36 + n * 2, 4);
  out.write('WAVEfmt ', 8, 'ascii');
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(rate, 24);
  out.writeUInt32LE(rate * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write('data', 36, 'ascii');
  out.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) out.writeInt16LE(Math.round(Math.sin(i / 5) * 8000), 44 + i * 2);
  return out;
}

const FAKE = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const file = path.basename(process.argv[1]);
const name = /^(powershell|pwsh)\.exe$/.test(file) ? file : file.replace(/\.exe$/, '');
const args = process.argv.slice(2);
const log = process.env.FAKE_LOG;
const env = {};
for (const [k, v] of Object.entries(process.env)) if (k.startsWith('SLICC_AUDIO_') || k.endsWith('_INSTALL_DIR')) env[k] = v;
let stdin = '';
const reads = ['say', 'espeak-ng', 'espeak', 'powershell.exe', 'pwsh.exe'].includes(name) && !args.includes('-L') && !args.includes('--voices') && !(args[0] === '-v' && args[1] === '?');
if (reads && process.env.SLICC_AUDIO_MODE !== 'list') stdin = fs.readFileSync(0, 'utf8');
const files = {};
for (const a of args) {
  if (fs.existsSync(a) && fs.statSync(a).isFile() && a.endsWith('.wav')) files[a] = fs.readFileSync(a).toString('base64');
}
if (env.SLICC_AUDIO_FILE && fs.existsSync(env.SLICC_AUDIO_FILE)) files[env.SLICC_AUDIO_FILE] = fs.readFileSync(env.SLICC_AUDIO_FILE).toString('base64');
fs.appendFileSync(path.join(log, 'calls'), JSON.stringify({ name: file, args, stdin, env, files }) + '\n');
const fail = process.env['FAKE_FAIL_' + file.replace(/[^A-Za-z0-9]/g, '_')];
if (fail) {
  process.stderr.write(fail + '\n');
  process.exit(3);
}
const wav = Buffer.from(process.env.FAKE_WAV, 'base64');
const after = (flag) => args[args.indexOf(flag) + 1];
const sleep = Number(process.env['FAKE_SLEEP_' + name.replace(/[^A-Za-z0-9]/g, '_')] || 0);
const done = () => setTimeout(() => process.exit(0), sleep * 1000);
if (name === 'say') {
  if (args[0] === '-v' && args[1] === '?') {
    process.stdout.write('Albert              en_US    # Hello! My name is Albert.\nDaniel              en_GB    # Hello! My name is Daniel.\nEddy (English (UK)) en_GB    # Hello! My name is Eddy.\n');
  } else if (args.includes('-o')) fs.writeFileSync(after('-o'), wav);
  else if (args.some((a) => a.includes('=?'))) process.stdout.write('say formats\n');
  done();
} else if (name === 'spd-say') {
  if (args[0] === '-L') process.stdout.write('         NAME                 LANGUAGE  VARIANT\n      English (America)       en-US     none\n      Spanish                 es        none\n');
  done();
} else if (name === 'espeak-ng' || name === 'espeak') {
  if (args[0] === '--voices') {
    process.stdout.write('Pty Language       Age/Gender VoiceName          File                 Other Languages\n 5  en-us           --/M      English_(America)  gmw/en-US            (en 3)\n 5  es              --/M      Spanish_(Spain)    roa/es\n');
  } else if (args.includes('-w')) fs.writeFileSync(after('-w'), wav);
  done();
} else if (name === 'powershell.exe' || name === 'pwsh.exe') {
  if (process.env.SLICC_AUDIO_MODE === 'list') process.stdout.write('Microsoft David Desktop\ten-US\r\nMicrosoft Hazel Desktop\ten-GB\r\n');
  if (process.env.SLICC_AUDIO_OUT) fs.writeFileSync(process.env.SLICC_AUDIO_OUT, wav);
  done();
} else if (name === 'ffmpeg') {
  if (args.includes('-list_devices')) {
    if (args.includes('avfoundation')) process.stderr.write('[AVFoundation indev @ 0x1] AVFoundation video devices:\n[AVFoundation indev @ 0x1] [0] FaceTime HD Camera\n[AVFoundation indev @ 0x1] AVFoundation audio devices:\n[AVFoundation indev @ 0x1] [0] MacBook Pro Microphone\n[AVFoundation indev @ 0x1] [1] USB Mic\n');
    else process.stderr.write('[dshow @ 0x1] "Microphone (Realtek)" (audio)\n[dshow @ 0x1]   Alternative name "@device_cm_x"\n[dshow @ 0x1] "Line In" (audio)\n');
    process.exit(1);
  }
  const out = args.at(-1);
  if (args.some((a) => a.startsWith('silencedetect'))) {
    const takes = Number(fs.existsSync(path.join(log, 'takes')) ? fs.readFileSync(path.join(log, 'takes'), 'utf8') : 0);
    fs.writeFileSync(path.join(log, 'takes'), String(takes + 1));
    const script = (process.env.FAKE_MIC || 'speech').split(',')[takes] || 'silence';
    fs.writeFileSync(out, wav);
    if (script === 'silence') {
      process.stderr.write('[silencedetect @ 0x1] silence_start: 0\n');
      setTimeout(() => process.exit(0), 50);
      return;
    }
    process.stderr.write('[silencedetect @ 0x1] silence_start: 0\n[silencedetect @ 0x1] silence_end: 0.5 | silence_duration: 0.5\n[silencedetect @ 0x1] silence_start: 2.1\n');
    let got = '';
    process.stdin.on('data', (c) => {
      got += c;
      if (got.includes('q')) {
        fs.appendFileSync(path.join(log, 'quit'), 'q');
        process.exit(0);
      }
    });
    setTimeout(() => process.exit(0), 5000);
    return;
  }
  fs.writeFileSync(out, wav);
  process.exit(0);
} else if (name === 'whisper-cli' || name === 'whisper-cpp') {
  const lines = (process.env.FAKE_TRANSCRIPT ?? 'hello world').split('|').filter(Boolean);
  if (args.includes('-osrt')) fs.writeFileSync(after('-f') + '.srt', '1\n00:00:00,000 --> 00:00:01,000\nhello world\n');
  if (args.includes('-nt')) process.stdout.write(lines.map((l) => ' ' + l + '\n').join(''));
  else process.stdout.write(lines.map((l, i) => '[00:00:0' + i + '.000 --> 00:00:0' + (i + 1) + '.000]   ' + l + '\n').join(''));
  process.exit(0);
} else if (name === 'pactl') {
  if (args[0] === 'info') process.exit(process.env.FAKE_PULSE ? 0 : 1);
  if (process.env.FAKE_PACTL_LIST) {
    process.stderr.write(process.env.FAKE_PACTL_LIST + '\n');
    process.exit(1);
  }
  process.stdout.write('0\talsa_input.usb-mic\tmodule-alsa-card.c\ts16le 1ch 48000Hz\tSUSPENDED\n');
  process.exit(0);
} else if (name === 'arecord') {
  process.stdout.write('default\n    Default ALSA Output\nhw:CARD=Mic,DEV=0\n    USB Mic, USB Audio\n');
  process.exit(0);
} else done();
`;

export function tools(names) {
  const dir = temp('bin');
  const script = join(dir, '.fake.cjs');
  writeFileSync(script, FAKE);
  for (const name of names) {
    writeFileSync(join(dir, name), `#!${process.execPath}\nrequire(${JSON.stringify(script)});\n`);
    chmodSync(join(dir, name), 0o755);
  }
  return dir;
}

export function calls(log) {
  const file = join(log, 'calls');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export function baseEnv(extra = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!/^(PATH|Path|SLICC_|OLLAMA_|HF_|XDG_|LANG|LC_ALL|NODE_OPTIONS)/.test(key))
      env[key] = value;
  }
  return {
    ...env,
    HF_HUB_CACHE: temp('hub'),
    SLICC_AUDIO_CACHE: temp('cache'),
    HF_ENDPOINT: 'http://127.0.0.1:9',
    ...extra,
  };
}

export async function run(
  command,
  { platform = 'linux', argv = [], names = [], env = {}, stdin = '', ortllama } = {}
) {
  const dir = tools(names);
  const log = temp('log');
  const input = join(log, 'in');
  writeFileSync(input, stdin);
  const fds = [
    openSync(input, 'r'),
    openSync(join(log, 'out'), 'w'),
    openSync(join(log, 'err'), 'w'),
  ];
  const full = baseEnv({
    FAKE_LOG: log,
    FAKE_WAV: tone().toString('base64'),
    OLLAMA_HOST: 'http://127.0.0.1:9',
    ...env,
  });
  if (platform === 'win32') full.Path = `${join(scratch, 'missing')};${dir}`;
  else full.PATH = dir;
  let code;
  try {
    code = await command({ argv, env: full, platform, fds, ...(ortllama ? { ortllama } : {}) });
  } finally {
    for (const fd of fds) closeSync(fd);
  }
  return {
    code,
    stdout: readFileSync(join(log, 'out'), 'utf8'),
    stdoutRaw: readFileSync(join(log, 'out')),
    stderr: readFileSync(join(log, 'err'), 'utf8'),
    calls: calls(log),
    log,
    env: full,
  };
}

function multipart(body, type) {
  const boundary = /boundary=(.+)$/.exec(type)?.[1];
  const fields = {};
  if (!boundary) return fields;
  for (const part of body.toString('latin1').split(`--${boundary}`)) {
    const m = /name="([^"]+)"(?:; filename="([^"]*)")?[\s\S]*?\r\n\r\n([\s\S]*)\r\n$/.exec(part);
    if (m)
      fields[m[1]] =
        m[2] === undefined ? m[3] : { filename: m[2], size: Buffer.from(m[3], 'latin1').length };
  }
  return fields;
}

export async function fakeServer() {
  const state = {
    requests: [],
    started: [],
    closed: 0,
    models: { ortllama: [], ollama: [] },
    answer: {},
    transcript: 'hello from the server',
    voices: [],
    files: {},
  };
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url, 'http://x');
      const [, tier, ...restParts] = url.pathname.split('/');
      const route = `/${restParts.join('/')}`;
      let parsed;
      if ((req.headers['content-type'] ?? '').includes('json'))
        parsed = JSON.parse(body.toString('utf8'));
      else if ((req.headers['content-type'] ?? '').includes('multipart'))
        parsed = multipart(body, req.headers['content-type']);
      state.requests.push({ tier, method: req.method, route, query: url.search, body: parsed });
      const send = (status, data, type = 'application/json', headers = {}) => {
        res.writeHead(status, { 'content-type': type, ...headers });
        res.end(typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data));
      };
      const fixed = state.answer[`${tier} ${route}`];
      if (fixed) return send(fixed.status, fixed.body);
      if (tier === 'files') {
        const file = state.files[route];
        if (!file) return send(404, 'missing', 'text/plain');
        return send(200, file, 'application/octet-stream');
      }
      if (tier === 'hf') {
        const m = /^\/ggerganov\/whisper\.cpp\/resolve\/main\/(ggml-.+\.bin)$/.exec(route);
        const blob = state.models.hf?.[m?.[1]];
        if (!blob) return send(404, 'missing', 'text/plain');
        const etag = blob.etag ?? createHash('sha256').update(blob.data).digest('hex');
        return send(302, '', 'text/plain', {
          location: `/blob/${m[1]}`,
          'x-linked-etag': `"${etag}"`,
        });
      }
      if (tier === 'blob') {
        const blob = state.models.hf?.[route.slice(1)];
        if (blob.cut !== undefined) {
          res.writeHead(200, {
            'content-type': 'application/octet-stream',
            'content-length': blob.data.length,
          });
          return res.write(blob.data.subarray(0, blob.cut), () => res.destroy());
        }
        return send(200, blob.data, 'application/octet-stream', {
          'content-length': blob.data.length,
        });
      }
      if (tier === 'bare') {
        if (route === '/v1/models')
          return send(200, {
            object: 'list',
            data: state.models.ortllama.map((id) => ({ id, object: 'model' })),
          });
        return send(500, {
          error: {
            message: 'ortllama on Node needs onnxruntime-node: npm install onnxruntime-node',
          },
        });
      }
      if (!state.models[tier])
        return send(404, { error: { message: `no route for ${url.pathname}` } });
      if (route === '/v1/models')
        return send(200, {
          object: 'list',
          data: state.models[tier].map((id) => ({ id, object: 'model' })),
        });
      if (route === '/v1/audio/voices') {
        const model = url.searchParams.get('model');
        const data = state.voices.filter((v) => !model || v.model === model);
        return send(200, { object: 'list', data });
      }
      if (route === '/v1/audio/speech') {
        const model = parsed.model ?? 'speech';
        state.inputs?.push(parsed.input.length);
        if (parsed.input.length > 4096)
          return send(400, { error: { message: 'input must be at most 4096 characters' } });
        if (!state.models[tier].includes(model)) {
          return send(404, {
            error: {
              message: `model ${model} is not cached; fetch it with hf download onnx-community/Kokoro-82M-v1.0-ONNX --include config.json 'voices/*'`,
            },
          });
        }
        return send(200, tone(), 'audio/wav');
      }
      if (route === '/v1/audio/transcriptions') {
        const model = parsed.model ?? 'transcribe';
        if (!state.models[tier].includes(model)) {
          return send(404, {
            error: {
              message: `model ${model} is not cached; hf download onnx-community/whisper-tiny --include '*.json'`,
            },
          });
        }
        if (parsed.response_format === 'srt')
          return send(200, '1\n00:00:00,000 --> 00:00:01,500\nhello\n', 'text/plain');
        if (parsed.response_format === 'verbose_json') {
          return send(200, {
            text: state.transcript,
            segments: [
              { start: 0, end: 1.2, text: ' hello' },
              { start: 1.2, end: 3, text: ' world.' },
            ],
          });
        }
        return send(200, { text: state.transcript });
      }
      send(404, { error: { message: `no route for ${req.method} ${url.pathname}` } });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  after(() => {
    server.closeAllConnections();
    server.close();
  });
  state.url = url;
  state.backends = [async () => ({ track: 'node' })];
  state.runtimes = [];
  state.ortllama = async () => ({
    onnx: '1.30.0',
    backends: state.backends,
    createRuntime: ({ backend }) => ({ backend }),
    startServer: async (options) => {
      state.started.push({ port: options.port, host: options.host });
      if (!options.runtime) return { url: `${url}/bare`, close: async () => state.closed++ };
      state.runtimes.push((await options.runtime.backend()).track);
      return { url: `${url}/ortllama`, close: async () => state.closed++ };
    },
  });
  state.reset = () => {
    state.requests = [];
    state.started = [];
    state.closed = 0;
    state.models = { ortllama: [], ollama: [] };
    state.answer = {};
    state.voices = [];
    state.backends = [async () => ({ track: 'node' })];
    state.runtimes = [];
  };
  return state;
}

export const missingModule = async () => {
  throw Object.assign(new Error('Cannot find package'), { code: 'ERR_MODULE_NOT_FOUND' });
};

export function hideNode() {
  const dir = temp('sys');
  for (const sys of ['/usr/bin', '/bin', '/usr/sbin', '/sbin']) {
    if (!existsSync(sys)) continue;
    for (const entry of readdirSync(sys)) {
      if (/^(node|nodejs|npm|npx|corepack)$/.test(entry) || existsSync(join(dir, entry))) continue;
      try {
        symlinkSync(join(sys, entry), join(dir, entry));
      } catch {}
    }
  }
  return dir;
}

export { existsSync, join, mkdirSync, readFileSync, writeFileSync };
