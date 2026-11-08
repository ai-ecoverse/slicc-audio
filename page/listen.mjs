import { decode, ending, lines, MIC, named, parse, stamp, streamed } from './util.mjs';

export function listenOf({ scope, silence, tick, threshold }, { context }) {
  async function recognize(options, signal) {
    const Recognition = scope.SpeechRecognition ?? scope.webkitSpeechRecognition;
    if (!Recognition) throw named('NotSupportedError', 'no SpeechRecognition in this browser');
    return streamed(
      (push) =>
        new Promise((resolve, reject) => {
          const recognition = new Recognition();
          let timer;
          let over = false;
          const finish = (error) => {
            if (over) return;
            over = true;
            clearTimeout(timer);
            signal.removeEventListener('abort', abort);
            if (error) reject(error);
            else resolve();
          };
          const abort = () => {
            recognition.abort();
            finish();
          };
          recognition.lang = options.language ?? scope.navigator?.language ?? 'en-US';
          recognition.continuous = !!options.continuous;
          recognition.interimResults = false;
          recognition.onresult = (event) => {
            for (let i = event.resultIndex; i < event.results.length; i++) {
              const result = event.results[i];
              const said = result.isFinal ? result[0].transcript.trim() : '';
              if (!said || over) continue;
              push(`${said}\n`);
              if (options.exit && ending(said, options.exit)) {
                recognition.stop();
                finish();
              }
            }
          };
          recognition.onerror = (event) => {
            if (event.error === 'no-speech' || event.error === 'aborted') return;
            finish(
              event.error === 'not-allowed' || event.error === 'service-not-allowed'
                ? named('NotAllowedError', MIC)
                : new Error(`Web Speech: ${event.error}`)
            );
          };
          recognition.onend = () => finish();
          if (signal.aborted) {
            finish();
            return;
          }
          signal.addEventListener('abort', abort, { once: true });
          timer = setTimeout(() => recognition.stop(), (options.seconds ?? 30) * 1000);
          recognition.start();
        })
    );
  }

  function transcript(bytes, format) {
    if (format === 'srt') return decode(bytes);
    const json = parse(bytes);
    if (!json) throw new Error('ortllama answered with something other than JSON');
    if (format === 'timestamps') {
      return (json.segments ?? [])
        .filter((s) => s.text?.trim())
        .map((s) => `[${stamp(s.start)} --> ${stamp(s.end)}] ${s.text.trim()}\n`)
        .join('');
    }
    return lines(String(json.text ?? ''))
      .map((l) => `${l}\n`)
      .join('');
  }

  async function microphone(options) {
    const media = scope.navigator?.mediaDevices;
    if (!media?.getUserMedia) throw named('NotSupportedError', 'no microphone in this browser');
    if (options.devices) {
      const list = await media.enumerateDevices();
      return list
        .filter((d) => d.kind === 'audioinput')
        .map((d) => `${d.deviceId}\t${d.label}\n`)
        .join('');
    }
    const audio = options.device ? { deviceId: { exact: options.device } } : true;
    try {
      return await media.getUserMedia({ audio });
    } catch (error) {
      if (error?.name === 'NotAllowedError' || error?.name === 'SecurityError')
        throw named('NotAllowedError', MIC);
      if (error?.name === 'NotFoundError' || error?.name === 'OverconstrainedError')
        throw named(
          'NotFoundError',
          options.device ? `no microphone ${options.device}` : 'no microphone'
        );
      throw new Error(error?.message ?? String(error));
    }
  }

  const release = (stream) => {
    for (const track of stream.getTracks()) track.stop();
  };

  async function capture(stream, options, signal, push) {
    const gated = options.gate !== false;
    const type = 'audio/webm;codecs=opus';
    let recorder;
    let ctx;
    try {
      if (signal.aborted) return;
      recorder = new scope.MediaRecorder(
        stream,
        scope.MediaRecorder.isTypeSupported?.(type) ? { mimeType: type } : undefined
      );
      if (gated) ctx = await context();
    } catch (error) {
      release(stream);
      throw error;
    } finally {
      if (signal.aborted) {
        release(stream);
        await ctx?.close();
      }
    }
    if (signal.aborted) return;
    let chain = Promise.resolve();
    let flowing = !gated;
    let held = [];
    const stop = () => {
      if (recorder.state !== 'inactive') recorder.stop();
      release(stream);
    };
    const stopped = new Promise((resolve) => {
      recorder.onstop = resolve;
    });
    recorder.ondataavailable = (event) => {
      chain = chain.then(async () => {
        if (!event.data?.size) return;
        const bytes = new Uint8Array(await event.data.arrayBuffer());
        if (flowing) push(bytes);
        else held.push(bytes);
      });
    };
    const speak = () => {
      chain = chain.then(() => {
        flowing = true;
        for (const bytes of held) push(bytes);
        held = [];
      });
    };
    const meter = gated
      ? listen(ctx, stream, { silence, tick, threshold, pause: options.pause }, speak, stop)
      : undefined;
    const seconds = options.seconds ?? (gated ? 30 : undefined);
    const timer = seconds === undefined ? undefined : setTimeout(stop, seconds * 1000);
    signal.addEventListener('abort', stop, { once: true });
    try {
      recorder.start(250);
      await stopped;
      await chain;
    } finally {
      clearInterval(meter);
      clearTimeout(timer);
      signal.removeEventListener('abort', stop);
      release(stream);
      await ctx?.close();
    }
  }

  return { capture, microphone, recognize, transcript };
}

function listen(ctx, stream, { silence, tick, threshold, pause }, speak, stop) {
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  ctx.createMediaStreamSource(stream).connect(analyser);
  const frame = new Float32Array(analyser.fftSize);
  let speaking = false;
  let quiet = 0;
  return setInterval(() => {
    analyser.getFloatTimeDomainData(frame);
    let sum = 0;
    for (const s of frame) sum += s * s;
    const now = Date.now();
    if (Math.sqrt(sum / frame.length) > threshold) {
      if (!speaking) {
        speaking = true;
        speak();
      }
      quiet = now;
    } else if (speaking && pause && now - quiet >= silence) stop();
  }, tick);
}
