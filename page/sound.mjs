import { CLICK, clamp, named, sleep } from './util.mjs';

export function soundOf({ scope, wait }) {
  async function webVoices() {
    const synthesis = scope.speechSynthesis;
    let voices = synthesis.getVoices();
    if (!voices.length) {
      await Promise.race([
        new Promise((resolve) =>
          synthesis.addEventListener('voiceschanged', resolve, { once: true })
        ),
        sleep(wait),
      ]);
      voices = synthesis.getVoices();
    }
    return voices.map((v) => ({
      name: v.name,
      lang: String(v.lang).replace('-', '_'),
      default: !!v.default,
      voice: v,
    }));
  }

  async function context() {
    const ctx = new scope.AudioContext();
    if (ctx.state !== 'running') await Promise.race([ctx.resume(), sleep(wait)]);
    if (ctx.state !== 'running') {
      await ctx.close();
      throw named('NotAllowedError', CLICK);
    }
    return ctx;
  }

  function until(signal, start, stop) {
    return new Promise((resolve, reject) => {
      const abort = () => {
        stop();
        reject(named('AbortError', 'stopped'));
      };
      if (signal.aborted) {
        abort();
        return;
      }
      signal.addEventListener('abort', abort, { once: true });
      start(
        () => {
          signal.removeEventListener('abort', abort);
          resolve();
        },
        (error) => {
          signal.removeEventListener('abort', abort);
          reject(error);
        }
      );
    });
  }

  async function element(bytes, { volume, rate, time }, signal) {
    const url = scope.URL.createObjectURL(new scope.Blob([bytes]));
    const audio = new scope.Audio(url);
    let timer;
    try {
      audio.preservesPitch = true;
      audio.playbackRate = rate;
      audio.volume = volume;
      await until(
        signal,
        (done, fail) => {
          audio.onended = done;
          audio.onerror = () => fail(new Error('cannot decode audio'));
          if (time) {
            timer = setTimeout(() => {
              audio.pause();
              done();
            }, time * 1000);
          }
          audio.play().catch(() => fail(named('NotAllowedError', CLICK)));
        },
        () => audio.pause()
      );
    } finally {
      clearTimeout(timer);
      scope.URL.revokeObjectURL(url);
    }
  }

  async function play(bytes, options, signal, info) {
    const volume = clamp(options.volume ?? 1, 0, 1);
    const rate = clamp(options.rate ?? 1, 0.25, 4);
    const time = options.time > 0 ? options.time : undefined;
    const ctx = await context();
    try {
      let buffer;
      try {
        buffer = await ctx.decodeAudioData(bytes.slice().buffer);
      } catch {
        throw new Error('cannot decode audio');
      }
      info?.(buffer);
      if (options.quality === 1 && rate !== 1) {
        await element(bytes, { volume, rate, time }, signal);
        return;
      }
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.playbackRate.value = rate;
      const gain = ctx.createGain();
      gain.gain.value = volume;
      source.connect(gain);
      gain.connect(ctx.destination);
      await until(
        signal,
        (done) => {
          source.onended = done;
          source.start(0);
          if (time) source.stop(ctx.currentTime + time);
        },
        () => source.stop()
      );
    } finally {
      await ctx.close();
    }
  }

  async function speak(line, { voice, lang, rate }, signal) {
    const synthesis = scope.speechSynthesis;
    const utterance = new scope.SpeechSynthesisUtterance(line);
    if (voice) utterance.voice = voice;
    if (voice || lang) utterance.lang = voice?.lang ?? lang;
    utterance.rate = clamp(rate ?? 1, 0.1, 10);
    await until(
      signal,
      (done, fail) => {
        utterance.onend = done;
        utterance.onerror = (event) =>
          fail(
            event.error === 'not-allowed'
              ? named('NotAllowedError', CLICK)
              : new Error(`Web Speech: ${event.error}`)
          );
        synthesis.speak(utterance);
      },
      () => synthesis.cancel()
    );
  }

  return { context, play, speak, until, webVoices };
}
