export const ORTLLAMA = 'http://11435.kernel.localhost';
export const MAX_BODY = 64 * 1024 * 1024;
export const MAX_INPUT = 4096;
export const KINDS = [
  'audio.play',
  'audio.say',
  'audio.voices',
  'audio.record',
  'audio.transcribe',
];
export const LANGUAGES =
  'en zh de es ru ko fr ja pt tr pl ca nl ar sv it id hi fi vi he uk el ms cs ro da hu ta no th ur hr bg lt la mi ml cy sk te fa lv bn sr az sl kn et mk br eu is hy ne mn bs kk sq sw gl mr pa si km sn yo so af oc ka be tg sd gu am yi lo uz fo ht ps tk nn mt sa lb my bo tl mg as tt haw ln ha ba jw su yue'.split(
    ' '
  );
export const KOKORO = {
  'en-US': 'af_heart',
  en: 'af_heart',
  'en-GB': 'bf_emma',
  es: 'ef_dora',
  fr: 'ff_siwis',
  hi: 'hf_alpha',
  it: 'if_sara',
  pt: 'pf_dora',
};
export const CLICK = "needs a click in seven's page";
export const MIC = 'microphone permission denied';
const encoder = new TextEncoder();

export const named = (name, message) => new DOMException(message, name);
export const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
export const decode = (bytes) => new TextDecoder().decode(bytes);
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function drain(body, limit = MAX_BODY) {
  const chunks = [];
  let size = 0;
  if (body) {
    for await (const chunk of body) {
      size += chunk.length;
      if (size > limit) throw new Error(`the request is larger than ${limit / 1048576} MiB`);
      chunks.push(chunk);
    }
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

export function streamed(work) {
  let open = true;
  return new ReadableStream({
    start(controller) {
      const push = (chunk) => {
        if (open) controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
      };
      work(push).then(
        () => {
          if (open) controller.close();
          open = false;
        },
        (error) => {
          if (open) controller.error(error);
          open = false;
        }
      );
    },
    cancel() {
      open = false;
    },
  });
}

export function words(command) {
  const out = [];
  let word = '';
  let quote = '';
  let has = false;
  for (const ch of command) {
    if (quote) {
      if (ch === quote) quote = '';
      else word += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (has || word) out.push(word);
      word = '';
      has = false;
    } else word += ch;
  }
  if (has || word) out.push(word);
  return out;
}

export function chunks(text, max = MAX_INPUT) {
  const out = [];
  let current = '';
  const push = (piece) => {
    if (current.length + piece.length > max && current) {
      out.push(current);
      current = '';
    }
    current += piece;
  };
  for (const sentence of text.match(/[^.!?\n]*[.!?\n]*\s*/g)) {
    if (sentence.length <= max) {
      push(sentence);
      continue;
    }
    for (const word of sentence.match(/\S*\s*/g)) {
      for (let at = 0; at < word.length; at += max) push(word.slice(at, at + max));
    }
  }
  if (current.trim()) out.push(current);
  return out;
}

export function ending(line, word) {
  const last = line
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s'-]+$/u, '')
    .trim()
    .split(/\s+/)
    .at(-1);
  return last === word.toLowerCase().replace(/[^\p{L}\p{N}'-]+$/u, '');
}

export function match(voices, wanted) {
  const lower = wanted.toLowerCase();
  return (
    voices.find((v) => v.name.toLowerCase().startsWith(lower)) ??
    voices.find((v) => v.name.toLowerCase().includes(lower))
  );
}

export function stamp(seconds) {
  const ms = Math.round(seconds * 1000);
  const h = String(Math.floor(ms / 3600000)).padStart(2, '0');
  const m = String(Math.floor(ms / 60000) % 60).padStart(2, '0');
  const s = String(Math.floor(ms / 1000) % 60).padStart(2, '0');
  return `${h}:${m}:${s}.${String(ms % 1000).padStart(3, '0')}`;
}

export const lines = (text) =>
  text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

export const parse = (bytes) => {
  try {
    return JSON.parse(decode(bytes));
  } catch {
    return undefined;
  }
};
