import { wav16 } from '../../page/wav.mjs';

export function tone(seconds = 0.01, rate = 24000) {
  const samples = new Float32Array(Math.round(seconds * rate));
  for (let i = 0; i < samples.length; i++) samples[i] = Math.sin(i / 3) * 0.5;
  return wav16(samples, rate);
}

const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export function fakeServer(state = {}) {
  const server = {
    requests: [],
    offline: false,
    cached: true,
    models: [
      { id: 'speech', ortllama: { alias_of: 'onnx-community/Kokoro-82M-v1.0-ONNX' } },
      { id: 'transcribe', ortllama: { alias_of: 'onnx-community/whisper-tiny' } },
    ],
    voices: [
      { id: 'af_heart', language: 'en-US' },
      { id: 'bf_emma', language: 'en-GB' },
      { id: 'ef_dora', language: 'es-ES' },
    ],
    text: 'Hello there.\nGeneral Kenobi.',
    segments: [
      { start: 0, end: 1.2, text: ' Hello there.' },
      { start: 1.2, end: 3, text: ' General Kenobi.' },
    ],
    failure: undefined,
    ...state,
  };
  server.fetch = async (url, init = {}) => {
    const { pathname, searchParams } = new URL(url);
    const entry = { path: pathname, method: init.method ?? 'GET', query: searchParams.toString() };
    if (init.body instanceof FormData) entry.form = Object.fromEntries(init.body.entries());
    else if (typeof init.body === 'string') entry.json = JSON.parse(init.body);
    server.requests.push(entry);
    if (server.offline) throw new TypeError('fetch failed');
    if (server.slow && pathname.startsWith('/v1/audio/') && pathname !== '/v1/audio/voices') {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, server.slow);
        init.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          entry.aborted = true;
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
    }
    if (server.failure) return json(500, { error: { message: server.failure } });
    const missing = (repo) =>
      json(404, {
        error: { message: `model not cached; run: hf download ${repo} --include '*.json'` },
      });
    if (pathname === '/v1/models') {
      return json(200, { data: server.cached ? server.models : [] });
    }
    if (pathname === '/v1/audio/voices') {
      if (server.voices === undefined) return json(404, { error: { message: 'no route' } });
      return json(200, { object: 'list', data: server.voices });
    }
    if (pathname === '/v1/audio/speech') {
      if (!server.cached) return missing('onnx-community/Kokoro-82M-v1.0-ONNX');
      return new Response(tone(), { headers: { 'content-type': 'audio/wav' } });
    }
    if (pathname === '/v1/audio/transcriptions') {
      if (!server.cached) return missing('onnx-community/whisper-tiny');
      const format = entry.form.response_format;
      if (format === 'srt') return new Response('1\n00:00:00,000 --> 00:00:01,200\nHello there.\n');
      if (format === 'verbose_json')
        return json(200, { text: server.text, segments: server.segments });
      if (server.garbled) return new Response('not json');
      return json(200, { text: server.text });
    }
    return json(404, { error: { message: `no route ${pathname}` } });
  };
  return server;
}

export function fakeBrowser(options = {}) {
  const o = {
    duration: 0.02,
    level: () => 0,
    heard: ['hello world'],
    voices: [
      { name: 'Samantha', lang: 'en-US', default: true },
      { name: 'Daniel', lang: 'en-GB', default: false },
      { name: 'Monica', lang: 'es-ES', default: false },
    ],
    ...options,
  };
  const log = [];
  const contexts = [];
  class AudioContext {
    constructor() {
      this.state = o.suspended ? 'suspended' : 'running';
      this.currentTime = 0;
      this.destination = { name: 'destination' };
      contexts.push(this);
    }
    resume() {
      if (o.hangResume) return new Promise(() => {});
      if (o.slowResume) {
        return new Promise((resolve) =>
          setTimeout(() => {
            this.state = 'running';
            resolve();
          }, o.slowResume)
        );
      }
      if (!o.blocked) this.state = 'running';
      return Promise.resolve();
    }
    async close() {
      this.state = 'closed';
      log.push(['close']);
    }
    async decodeAudioData(buffer) {
      if (o.undecodable || buffer.byteLength === 0) throw new DOMException('bad', 'EncodingError');
      return { duration: o.duration, sampleRate: 44100, numberOfChannels: o.channels ?? 1 };
    }
    createBufferSource() {
      const node = {
        playbackRate: { value: 1 },
        connect(to) {
          log.push(['connect', 'source', to.name]);
        },
        start(when) {
          log.push(['start', when, node.playbackRate.value]);
          node.timer = setTimeout(
            () => node.onended?.(),
            (o.duration * 1000) / node.playbackRate.value
          );
        },
        stop(at) {
          log.push(['stop', at]);
          clearTimeout(node.timer);
          if (at !== undefined) node.timer = setTimeout(() => node.onended?.(), at * 1000);
        },
      };
      return node;
    }
    createGain() {
      const node = {
        name: 'gain',
        gain: { value: 1 },
        connect(to) {
          log.push(['connect', 'gain', to.name, node.gain.value]);
        },
      };
      return node;
    }
    createAnalyser() {
      return {
        fftSize: 0,
        getFloatTimeDomainData(frame) {
          frame.fill(o.level());
        },
      };
    }
    createMediaStreamSource(stream) {
      return {
        connect() {
          log.push(['analyse', stream.id]);
        },
      };
    }
  }
  class Audio {
    constructor(url) {
      this.url = url;
      log.push(['audio', url.startsWith('blob:')]);
    }
    play() {
      log.push(['play', this.playbackRate, this.volume, this.preservesPitch]);
      if (o.refusePlay) return Promise.reject(new DOMException('no', 'NotAllowedError'));
      if (o.badElement) setTimeout(() => this.onerror?.(), 1);
      else this.timer = setTimeout(() => this.onended?.(), o.duration * 1000);
      return Promise.resolve();
    }
    pause() {
      clearTimeout(this.timer);
      log.push(['pause']);
    }
  }
  class SpeechSynthesisUtterance {
    constructor(text) {
      this.text = text;
    }
  }
  const listeners = [];
  let ready = !o.lateVoices;
  const speechSynthesis = {
    getVoices: () => (ready ? o.voices : []),
    addEventListener(name, fn) {
      listeners.push(fn);
      if (o.lateVoices === 'fires') {
        setTimeout(() => {
          ready = true;
          fn();
        }, 5);
      }
    },
    speak(u) {
      log.push(['speak', u.text, u.voice?.name, u.lang, u.rate]);
      speechSynthesis.current = setTimeout(() => {
        if (o.speakError) u.onerror({ error: o.speakError });
        else u.onend();
      }, 5);
    },
    cancel() {
      clearTimeout(speechSynthesis.current);
      log.push(['cancel']);
    },
  };
  class SpeechRecognition {
    constructor() {
      log.push(['recognition']);
    }
    start() {
      log.push(['listen', this.lang, this.continuous, this.interimResults]);
      if (o.recognitionError) {
        setTimeout(() => {
          this.onerror({ error: o.recognitionError });
          this.onend();
        }, 2);
        return;
      }
      const results = [];
      o.heard.forEach((text, i) => {
        setTimeout(
          () => {
            if (this.done) return;
            results.push(Object.assign([{ transcript: ` ${text}` }], { isFinal: true }));
            const partial = Object.assign([{ transcript: 'partial' }], { isFinal: false });
            this.onresult({ resultIndex: i, results: [...results, partial] });
            if (!this.continuous) this.stop();
          },
          5 * (i + 1)
        );
      });
      if (o.heard.length === 0) {
        setTimeout(() => {
          this.onerror({ error: 'no-speech' });
          this.stop();
        }, 2);
      }
    }
    stop() {
      if (this.done) return;
      this.done = true;
      log.push(['recognition stop']);
      setTimeout(() => this.onend(), 1);
    }
    abort() {
      this.done = true;
      log.push(['recognition abort']);
    }
  }
  class MediaRecorder {
    static isTypeSupported(type) {
      return !o.noOpus && type === 'audio/webm;codecs=opus';
    }
    constructor(stream, init) {
      if (o.recorderError) throw new DOMException('no recorder', o.recorderError);
      this.stream = stream;
      this.init = init;
      this.state = 'inactive';
      this.count = 0;
      log.push(['recorder', init?.mimeType]);
    }
    chunk() {
      this.count += 1;
      const bytes = new TextEncoder().encode(`[${this.count}]`);
      this.ondataavailable({ data: new Blob([bytes]) });
    }
    start(slice) {
      this.state = 'recording';
      log.push(['record', slice]);
      this.ondataavailable({ data: new Blob([]) });
      this.timer = setInterval(() => this.chunk(), 10);
    }
    stop() {
      clearInterval(this.timer);
      this.state = 'inactive';
      this.chunk();
      log.push(['recorder stop']);
      setTimeout(() => this.onstop(), 1);
    }
  }
  const tracks = [];
  const navigator = {
    language: 'en-US',
    languages: ['en-US', 'de-DE'],
    mediaDevices: {
      async getUserMedia(constraints) {
        log.push(['getUserMedia', JSON.stringify(constraints)]);
        if (o.micError) throw new DOMException('denied', o.micError);
        if (o.micDelay) await new Promise((resolve) => setTimeout(resolve, o.micDelay));
        const track = {
          stop() {
            log.push(['track stop']);
          },
        };
        tracks.push(track);
        return { id: 'mic', getTracks: () => [track] };
      },
      async enumerateDevices() {
        return [
          { kind: 'audioinput', deviceId: 'default', label: 'Default' },
          { kind: 'videoinput', deviceId: 'cam', label: 'Camera' },
          { kind: 'audioinput', deviceId: 'usb', label: 'USB Mic' },
        ];
      },
    },
  };
  const server = o.server ?? fakeServer();
  const scope = {
    fetch: server.fetch,
    FormData,
    Blob,
    URL,
    AudioContext,
    Audio,
    speechSynthesis,
    SpeechSynthesisUtterance,
    SpeechRecognition,
    MediaRecorder,
    navigator,
  };
  if (o.noSynthesis) delete scope.speechSynthesis;
  if (o.noRecognition) delete scope.SpeechRecognition;
  if (o.webkit) {
    scope.webkitSpeechRecognition = SpeechRecognition;
    delete scope.SpeechRecognition;
  }
  if (o.noMic) scope.navigator = {};
  return { scope, log, server, contexts, tracks, listeners, options: o };
}
