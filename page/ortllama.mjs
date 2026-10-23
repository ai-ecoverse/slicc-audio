import { chunks, decode, KOKORO, match, named, parse, words } from './util.mjs';
import { joined, wav16 } from './wav.mjs';

export function ortllamaOf({ scope, base }) {
  const offline = `no server at ${base} (pnpm add -g @ai-ecoverse/slicc-ortllama, then ortllama serve --detach)`;

  async function call(path, init = {}) {
    let res;
    try {
      res = await scope.fetch(`${base}${path}`, init);
    } catch {
      if (init.signal?.aborted) throw named('AbortError', 'stopped');
      return { offline: true };
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    let message = '';
    if (!res.ok) {
      message = decode(bytes);
      message = parse(bytes)?.error?.message ?? message;
    }
    return { status: res.status, ok: res.ok, bytes, message: message.trim() };
  }

  function checked(res) {
    if (res.offline) throw new Error(offline);
    if (res.status === 404) throw new Error(`model not cached (${hint(res.message)})`);
    if (!res.ok) throw new Error(res.message || `HTTP ${res.status}`);
    return res.bytes;
  }

  const hint = (message) => /hf download[^\n]*/.exec(message)?.[0] ?? message;

  const speech = (request, signal) =>
    call('/v1/audio/speech', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
      signal,
    });

  function transcription(bytes, { model, language, format }, signal) {
    const form = new scope.FormData();
    form.append('file', new scope.Blob([bytes]), 'audio');
    if (model) form.append('model', model);
    if (language) form.append('language', language.split('-')[0]);
    form.append('response_format', format);
    return call('/v1/audio/transcriptions', { method: 'POST', body: form, signal });
  }

  const probes = {
    speech: (model) => speech({ model: model ?? 'speech', input: ' ', response_format: 'wav' }),
    transcribe: (model) =>
      transcription(wav16(new Float32Array(1600), 16000), {
        model: model ?? 'transcribe',
        format: 'json',
      }),
  };

  async function readiness(role, model) {
    const list = await call('/v1/models');
    if (list.offline) return { why: offline };
    const wanted = model ?? role;
    let entry;
    if (list.ok) entry = (parse(list.bytes)?.data ?? []).find((m) => m.id === wanted);
    if (entry) return { ready: entry.ortllama?.alias_of ?? entry.id };
    const res = await probes[role](model);
    if (res.offline) return { why: offline };
    if (res.status === 404) return { missing: hint(res.message) };
    return { ready: wanted };
  }

  async function ortllamaLine(role, model) {
    const state = await readiness(role, model);
    if (state.ready) return `ortllama: ready (${state.ready})\n`;
    if (state.missing) return `ortllama: not cached (${state.missing})\n`;
    return `ortllama: ${state.why}\n`;
  }

  async function warmup(role, model) {
    const state = await readiness(role, model);
    if (state.ready) return `ortllama: ready (${state.ready})\n`;
    if (state.why) throw named('NotSupportedError', `ortllama: ${state.why}`);
    const argv = words(state.missing);
    if (argv[0] !== 'hf' || argv[1] !== 'download') throw new Error(`ortllama: ${state.missing}`);
    return `${state.missing}\n${argv.join('\n')}\n`;
  }

  async function kokoroVoices(model) {
    const query = model ? `?model=${encodeURIComponent(model)}` : '';
    const res = await call(`/v1/audio/voices${query}`);
    if (res.offline) throw new Error(offline);
    if (!res.ok) return [];
    return (parse(res.bytes)?.data ?? []).map((v) => ({
      name: v.id,
      lang: String(v.language ?? 'en-US').replace('-', '_'),
      default: v.id === 'af_heart',
    }));
  }

  async function kokoroVoice({ voice, lang, model }) {
    if (voice) {
      const voices = await kokoroVoices(model);
      if (!voices.length) return voice;
      const pick = match(voices, voice);
      if (!pick) throw named('NotFoundError', `voice "${voice}" not found`);
      return pick.name;
    }
    if (lang) {
      const pick = KOKORO[lang] ?? KOKORO[lang.split('-')[0]];
      if (!pick) throw named('NotFoundError', `no Kokoro voice for ${lang}`);
      return pick;
    }
    return 'af_heart';
  }

  async function synth(text, request, signal) {
    const parts = chunks(text);
    const wavs = [];
    for (const input of parts) wavs.push(checked(await speech({ ...request, input }, signal)));
    return wavs.length === 1 ? wavs[0] : joined(wavs);
  }

  return {
    checked,
    kokoroVoice,
    kokoroVoices,
    ortllamaLine,
    synth,
    transcription,
    warmup,
  };
}
