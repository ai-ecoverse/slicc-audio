import { UsageError } from './common.mjs';

export const FORMATS = {
  WAVE: {
    ext: ['.wav'],
    endian: 'LE',
    allowed: ['LEUI8', 'LEI16', 'LEI24', 'LEI32', 'LEF32', 'LEF64'],
  },
  AIFF: { ext: ['.aiff', '.aif'], endian: 'BE', allowed: ['BEI8', 'BEI16', 'BEI24', 'BEI32'] },
  caff: {
    ext: ['.caf'],
    endian: 'BE',
    allowed: ['LE', 'BE'].flatMap((e) =>
      ['I8', 'I16', 'I24', 'I32', 'F32', 'F64'].map((f) => e + f)
    ),
  },
};

export function fileFormatList() {
  return Object.entries(FORMATS)
    .map(([name, f]) => `${name.padEnd(6)}${f.ext.join(' ')}\n`)
    .join('');
}

export function dataFormatList(format) {
  const names = format ? [format] : Object.keys(FORMATS);
  return names.map((name) => `${name.padEnd(6)}${FORMATS[name].allowed.join(' ')}\n`).join('');
}

export function fileFormat(value) {
  const name = Object.keys(FORMATS).find((key) => key.toLowerCase() === value.toLowerCase());
  if (!name) throw new UsageError(`--file-format ${value}: no encoder for it`);
  return name;
}

export function formatOf(path, given) {
  if (given) return { path, format: given };
  const lower = path.toLowerCase();
  for (const [name, f] of Object.entries(FORMATS)) {
    if (f.ext.some((ext) => lower.endsWith(ext))) return { path, format: name };
  }
  return { path: `${path}.aiff`, format: 'AIFF' };
}

export function dataFormat(value, format) {
  const match = /^(LE|BE)?(UI|I|F)(8|16|24|32|64)(?:@(\d+))?$/.exec(value ?? 'I16');
  if (!match) throw new UsageError(`--data-format ${value}: no encoder for it`);
  const [, endian = FORMATS[format].endian, kind, bits, rate] = match;
  const name = `${endian}${kind}${bits}`;
  const fallback = format === 'WAVE' && bits === '8' && kind === 'I' ? 'LEUI8' : name;
  if (!FORMATS[format].allowed.includes(fallback)) {
    throw new UsageError(`--data-format ${value}: no encoder for it in ${format}`);
  }
  const parsed = /^(LE|BE)(UI|I|F)(\d+)$/.exec(fallback);
  const hz = rate === undefined ? undefined : Number(rate);
  if (hz !== undefined && (hz < 1000 || hz > 384000))
    throw new UsageError(`--data-format ${value}: bad sample rate`);
  return { endian: parsed[1], kind: parsed[2], bits: Number(parsed[3]), rate: hz };
}

export function decodeWav(buffer) {
  if (
    buffer.length < 12 ||
    buffer.toString('ascii', 0, 4) !== 'RIFF' ||
    buffer.toString('ascii', 8, 12) !== 'WAVE'
  ) {
    throw new Error('not a WAV file');
  }
  let at = 12;
  let fmt;
  let data;
  while (at + 8 <= buffer.length) {
    const id = buffer.toString('ascii', at, at + 4);
    const size = buffer.readUInt32LE(at + 4);
    const body = buffer.subarray(at + 8, Math.min(buffer.length, at + 8 + size));
    if (id === 'fmt ') fmt = body;
    if (id === 'data') data = body;
    at += 8 + size + (size % 2);
  }
  if (!fmt || !data) throw new Error('not a WAV file');
  let tag = fmt.readUInt16LE(0);
  const channels = fmt.readUInt16LE(2);
  const rate = fmt.readUInt32LE(4);
  const bits = fmt.readUInt16LE(14);
  if (tag === 0xfffe) tag = fmt.readUInt16LE(24);
  const bytes = bits / 8;
  const frames = Math.floor(data.length / (bytes * channels));
  const samples = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++)
      sum += readSample(data, (i * channels + c) * bytes, tag, bits);
    samples[i] = sum / channels;
  }
  return { rate, samples };
}

function readSample(data, at, tag, bits) {
  if (tag === 3) return bits === 64 ? data.readDoubleLE(at) : data.readFloatLE(at);
  if (bits === 8) return (data[at] - 128) / 128;
  return data.readIntLE(at, bits / 8) / 2 ** (bits - 1);
}

export function resample(samples, from, to) {
  if (from === to) return samples;
  const length = Math.max(1, Math.round((samples.length * to) / from));
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const pos = (i * from) / to;
    const left = Math.floor(pos);
    const right = Math.min(left + 1, samples.length - 1);
    const t = pos - left;
    out[i] =
      (samples[Math.min(left, samples.length - 1)] ?? 0) * (1 - t) + (samples[right] ?? 0) * t;
  }
  return out;
}

function writer(out, { endian, kind, bits }) {
  const le = endian === 'LE';
  const bytes = bits / 8;
  if (kind === 'F' && bits === 64)
    return (s, at) => (le ? out.writeDoubleLE(s, at) : out.writeDoubleBE(s, at));
  if (kind === 'F') return (s, at) => (le ? out.writeFloatLE(s, at) : out.writeFloatBE(s, at));
  if (kind === 'UI') return (s, at) => (out[at] = Math.round(s * 127 + 128));
  const scale = 2 ** (bits - 1) - 1;
  return (s, at) =>
    le
      ? out.writeIntLE(Math.round(s * scale), at, bytes)
      : out.writeIntBE(Math.round(s * scale), at, bytes);
}

function pcm(samples, channels, data) {
  const bytes = data.bits / 8;
  const out = Buffer.alloc(samples.length * channels * bytes);
  const put = writer(out, data);
  let at = 0;
  for (const raw of samples) {
    const s = Math.max(-1, Math.min(1, raw));
    for (let c = 0; c < channels; c++) {
      put(s, at);
      at += bytes;
    }
  }
  return out;
}

function extended(rate) {
  const out = Buffer.alloc(10);
  const exp = Math.floor(Math.log2(rate));
  const mant = rate / 2 ** exp;
  out.writeUInt16BE(exp + 16383, 0);
  const hi = Math.floor(mant * 2 ** 31);
  const lo = Math.floor((mant * 2 ** 31 - hi) * 2 ** 32);
  out.writeUInt32BE(hi >>> 0, 2);
  out.writeUInt32BE(lo >>> 0, 6);
  return out;
}

export function encode(samples, { format, data, channels, rate }) {
  const body = pcm(samples, channels, data);
  const bytes = data.bits / 8;
  if (format === 'WAVE') {
    const head = Buffer.alloc(44);
    head.write('RIFF', 0, 'ascii');
    head.writeUInt32LE(36 + body.length, 4);
    head.write('WAVEfmt ', 8, 'ascii');
    head.writeUInt32LE(16, 16);
    head.writeUInt16LE(data.kind === 'F' ? 3 : 1, 20);
    head.writeUInt16LE(channels, 22);
    head.writeUInt32LE(rate, 24);
    head.writeUInt32LE(rate * channels * bytes, 28);
    head.writeUInt16LE(channels * bytes, 32);
    head.writeUInt16LE(data.bits, 34);
    head.write('data', 36, 'ascii');
    head.writeUInt32LE(body.length, 40);
    return Buffer.concat([head, body]);
  }
  if (format === 'AIFF') {
    const head = Buffer.alloc(54);
    head.write('FORM', 0, 'ascii');
    head.writeUInt32BE(46 + body.length, 4);
    head.write('AIFFCOMM', 8, 'ascii');
    head.writeUInt32BE(18, 16);
    head.writeUInt16BE(channels, 20);
    head.writeUInt32BE(samples.length, 22);
    head.writeUInt16BE(data.bits, 26);
    extended(rate).copy(head, 28);
    head.write('SSND', 38, 'ascii');
    head.writeUInt32BE(8 + body.length, 42);
    return Buffer.concat([head, body]);
  }
  const head = Buffer.alloc(68);
  head.write('caff', 0, 'ascii');
  head.writeUInt16BE(1, 4);
  head.write('desc', 8, 'ascii');
  head.writeBigUInt64BE(32n, 12);
  head.writeDoubleBE(rate, 20);
  head.write('lpcm', 28, 'ascii');
  head.writeUInt32BE((data.kind === 'F' ? 1 : 0) | (data.endian === 'LE' ? 2 : 0), 32);
  head.writeUInt32BE(channels * bytes, 36);
  head.writeUInt32BE(1, 40);
  head.writeUInt32BE(channels, 44);
  head.writeUInt32BE(data.bits, 48);
  head.write('data', 52, 'ascii');
  head.writeBigUInt64BE(BigInt(4 + body.length), 56);
  return Buffer.concat([head, body]);
}

export function convert(wav, target) {
  const { rate, samples } = decodeWav(wav);
  const to = target.data.rate ?? rate;
  return encode(resample(samples, rate, to), { ...target, rate: to });
}

export function chime() {
  const rate = 44100;
  const length = Math.round(0.45 * rate);
  const samples = new Float32Array(length);
  let peak = 0;
  for (let i = 0; i < length; i++) {
    const t = i / rate;
    let s = Math.sin(2 * Math.PI * 880 * t) * Math.exp(-t / 0.12);
    if (t >= 0.1) s += Math.sin(2 * Math.PI * 1318.5 * (t - 0.1)) * Math.exp(-(t - 0.1) / 0.12);
    samples[i] = s;
    peak = Math.max(peak, Math.abs(s));
  }
  const gain = 10 ** (-6 / 20) / peak;
  for (let i = 0; i < length; i++) samples[i] *= gain;
  return encode(samples, {
    format: 'WAVE',
    data: { endian: 'LE', kind: 'I', bits: 16 },
    channels: 1,
    rate,
  });
}
