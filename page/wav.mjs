const ascii = (view, at, length) =>
  String.fromCharCode(...new Uint8Array(view.buffer, view.byteOffset + at, length));

export function decodeWav(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 12 || ascii(view, 0, 4) !== 'RIFF' || ascii(view, 8, 4) !== 'WAVE') {
    throw new Error('not a WAV file');
  }
  let at = 12;
  let fmt;
  let data;
  while (at + 8 <= bytes.length) {
    const id = ascii(view, at, 4);
    const size = view.getUint32(at + 4, true);
    const start = at + 8;
    const end = Math.min(bytes.length, start + size);
    if (id === 'fmt ') fmt = new DataView(bytes.buffer, bytes.byteOffset + start, end - start);
    if (id === 'data') data = { start, end };
    at = start + size + (size % 2);
  }
  if (!fmt || !data) throw new Error('not a WAV file');
  let tag = fmt.getUint16(0, true);
  const channels = fmt.getUint16(2, true);
  const rate = fmt.getUint32(4, true);
  const bits = fmt.getUint16(14, true);
  if (tag === 0xfffe) tag = fmt.getUint16(24, true);
  const width = bits / 8;
  const frames = Math.floor((data.end - data.start) / (width * channels));
  const samples = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) {
      sum += sample(view, data.start + (i * channels + c) * width, tag, bits);
    }
    samples[i] = sum / channels;
  }
  return { rate, samples };
}

function sample(view, at, tag, bits) {
  if (tag === 3) return bits === 64 ? view.getFloat64(at, true) : view.getFloat32(at, true);
  if (bits === 8) return (view.getUint8(at) - 128) / 128;
  if (bits === 16) return view.getInt16(at, true) / 32768;
  if (bits === 24) {
    const raw = view.getUint8(at) | (view.getUint8(at + 1) << 8) | (view.getInt8(at + 2) << 16);
    return raw / 8388608;
  }
  return view.getInt32(at, true) / 2147483648;
}

export function resample(samples, from, to) {
  if (from === to) return samples;
  const length = Math.max(1, Math.round((samples.length * to) / from));
  const out = new Float32Array(length);
  const last = samples.length - 1;
  for (let i = 0; i < length; i++) {
    const pos = (i * from) / to;
    const left = Math.min(Math.floor(pos), last);
    const right = Math.min(left + 1, last);
    const t = pos - Math.floor(pos);
    out[i] = (samples[left] ?? 0) * (1 - t) + (samples[right] ?? 0) * t;
  }
  return out;
}

function put(view, { endian, kind, bits }) {
  const le = endian === 'LE';
  if (kind === 'F' && bits === 64) return (s, at) => view.setFloat64(at, s, le);
  if (kind === 'F') return (s, at) => view.setFloat32(at, s, le);
  if (kind === 'UI') return (s, at) => view.setUint8(at, Math.round(s * 127 + 128));
  const scale = 2 ** (bits - 1) - 1;
  if (bits === 8) return (s, at) => view.setInt8(at, Math.round(s * scale));
  if (bits === 16) return (s, at) => view.setInt16(at, Math.round(s * scale), le);
  if (bits === 32) return (s, at) => view.setInt32(at, Math.round(s * scale), le);
  return (s, at) => {
    const v = Math.round(s * scale) & 0xffffff;
    const bytes = [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff];
    if (!le) bytes.reverse();
    for (let k = 0; k < 3; k++) view.setUint8(at + k, bytes[k]);
  };
}

function extended(view, at, rate) {
  const exp = Math.floor(Math.log2(rate));
  const mant = rate / 2 ** exp;
  view.setUint16(at, exp + 16383);
  const hi = Math.floor(mant * 2 ** 31);
  view.setUint32(at + 2, hi >>> 0);
  view.setUint32(at + 6, Math.floor((mant * 2 ** 31 - hi) * 2 ** 32) >>> 0);
}

function text(view, at, value) {
  for (let k = 0; k < value.length; k++) view.setUint8(at + k, value.charCodeAt(k));
}

export function encode(samples, { format, endian, kind, bits, channels = 1, rate }) {
  const width = bits / 8;
  const head = format === 'WAVE' ? 44 : format === 'AIFF' ? 54 : 68;
  const size = samples.length * channels * width;
  const out = new Uint8Array(head + size);
  const view = new DataView(out.buffer);
  const write = put(view, { endian, kind, bits });
  let at = head;
  for (const raw of samples) {
    const s = Math.max(-1, Math.min(1, raw));
    for (let c = 0; c < channels; c++) {
      write(s, at);
      at += width;
    }
  }
  if (format === 'WAVE') {
    text(view, 0, 'RIFF');
    view.setUint32(4, 36 + size, true);
    text(view, 8, 'WAVEfmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, kind === 'F' ? 3 : 1, true);
    view.setUint16(22, channels, true);
    view.setUint32(24, rate, true);
    view.setUint32(28, rate * channels * width, true);
    view.setUint16(32, channels * width, true);
    view.setUint16(34, bits, true);
    text(view, 36, 'data');
    view.setUint32(40, size, true);
    return out;
  }
  if (format === 'AIFF') {
    text(view, 0, 'FORM');
    view.setUint32(4, 46 + size);
    text(view, 8, 'AIFFCOMM');
    view.setUint32(16, 18);
    view.setUint16(20, channels);
    view.setUint32(22, samples.length);
    view.setUint16(26, bits);
    extended(view, 28, rate);
    text(view, 38, 'SSND');
    view.setUint32(42, 8 + size);
    return out;
  }
  text(view, 0, 'caff');
  view.setUint16(4, 1);
  text(view, 8, 'desc');
  view.setBigUint64(12, 32n);
  view.setFloat64(20, rate);
  text(view, 28, 'lpcm');
  view.setUint32(32, (kind === 'F' ? 1 : 0) | (endian === 'LE' ? 2 : 0));
  view.setUint32(36, channels * width);
  view.setUint32(40, 1);
  view.setUint32(44, channels);
  view.setUint32(48, bits);
  text(view, 52, 'data');
  view.setBigUint64(56, BigInt(4 + size));
  return out;
}

export const wav16 = (samples, rate) =>
  encode(samples, { format: 'WAVE', endian: 'LE', kind: 'I', bits: 16, channels: 1, rate });

export function joined(wavs) {
  const decoded = wavs.map(decodeWav);
  const rate = decoded[0].rate;
  const parts = decoded.map((d) => resample(d.samples, d.rate, rate));
  const all = new Float32Array(parts.reduce((total, p) => total + p.length, 0));
  let at = 0;
  for (const p of parts) {
    all.set(p, at);
    at += p.length;
  }
  return encode(all, { format: 'WAVE', endian: 'LE', kind: 'F', bits: 32, channels: 1, rate });
}

export function convert(wav, target) {
  const { rate, samples } = decodeWav(wav);
  const to = target.rate ?? rate;
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
  return wav16(samples, rate);
}

const MAGIC = [
  ['wav', (b, s) => s(0, 4) === 'RIFF' && s(8, 4) === 'WAVE'],
  ['aiff', (b, s) => s(0, 4) === 'FORM'],
  ['caf', (b, s) => s(0, 4) === 'caff'],
  ['flac', (b, s) => s(0, 4) === 'fLaC'],
  ['ogg', (b, s) => s(0, 4) === 'OggS'],
  ['m4a', (b, s) => s(4, 4) === 'ftyp'],
  ['webm', (b) => b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3],
  ['mp3', (b, s) => s(0, 3) === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)],
];

export function sniff(bytes) {
  const s = (at, length) => String.fromCharCode(...bytes.subarray(at, at + length));
  return MAGIC.find(([, test]) => test(bytes, s))?.[0] ?? 'audio';
}
