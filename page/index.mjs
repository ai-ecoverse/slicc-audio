import { listenOf } from './listen.mjs';
import { ortllamaOf } from './ortllama.mjs';
import { soundOf } from './sound.mjs';
import { speechOf } from './speech.mjs';
import { decode, drain, KINDS, LANGUAGES, named, ORTLLAMA, streamed } from './util.mjs';
import { chime, sniff } from './wav.mjs';

export { drain, ORTLLAMA, streamed } from './util.mjs';

const FORMATS = { timestamps: 'verbose_json', srt: 'srt' };

export function createAudio({
  scope = globalThis,
  ortllama = ORTLLAMA,
  silence = 1000,
  tick = 50,
  threshold = 0.02,
  wait = 1000,
} = {}) {
  const env = { scope, base: ortllama.replace(/\/+$/, ''), silence, tick, threshold, wait };
  const remote = ortllamaOf(env);
  const sound = soundOf(env);
  const { kokoroSay, webSay } = speechOf(env, remote, sound);
  const { capture, microphone, recognize, transcript } = listenOf(env, sound);
  const { play, webVoices } = sound;
  const { checked, kokoroVoices, ortllamaLine, transcription, warmup } = remote;

  const handlers = {
    async 'audio.play'({ options, body, signal }) {
      const given = await drain(body);
      const bytes = options.sound === 'chime' ? chime() : given;
      if (!options.debug) return play(bytes, options, signal);
      return streamed((push) =>
        play(bytes, options, signal, (buffer) => {
          const n = buffer.numberOfChannels;
          push(
            `${sniff(bytes)}, ${buffer.sampleRate} Hz, ${n} channel${n === 1 ? '' : 's'}, ${buffer.duration.toFixed(3)} s\n`
          );
        })
      );
    },
    async 'audio.say'({ options, body, signal }) {
      const text = decode(await drain(body));
      if (options.status) {
        const synthesis = scope.speechSynthesis;
        const platform = synthesis
          ? `platform: ready (Web Speech, ${(await webVoices()).length} voices)\n`
          : 'platform: unavailable (no speechSynthesis in this browser)\n';
        return (await ortllamaLine('speech', options.model)) + platform;
      }
      if (options.warmup) return warmup('speech', options.model);
      if (options.engine === 'webspeech') return webSay(text, options, signal);
      return kokoroSay(text, options, signal);
    },
    async 'audio.voices'({ options, body }) {
      await drain(body);
      let voices;
      if (options.engine === 'webspeech') {
        if (!scope.speechSynthesis)
          throw named('NotSupportedError', 'no speechSynthesis in this browser');
        voices = await webVoices();
      } else voices = await kokoroVoices(options.model);
      return voices.map((v) => `${v.name}\t${v.lang}\t${v.default ? 1 : 0}\n`).join('');
    },
    async 'audio.record'({ options, body, signal }) {
      await drain(body);
      const stream = await microphone(options);
      if (typeof stream === 'string') return stream;
      return streamed((push) => capture(stream, options, signal, push));
    },
    async 'audio.transcribe'({ options, body, signal }) {
      const bytes = await drain(body);
      if (options.status) {
        const Recognition = scope.SpeechRecognition ?? scope.webkitSpeechRecognition;
        const platform = Recognition
          ? 'platform: ready (Web Speech)\n'
          : 'platform: unavailable (no SpeechRecognition in this browser)\n';
        return (await ortllamaLine('transcribe', options.model)) + platform;
      }
      if (options.warmup) return warmup('transcribe', options.model);
      if (options.supported && options.engine === 'webspeech') {
        return [...(scope.navigator?.languages ?? [])].map((t) => `${t}\n`).join('');
      }
      if (options.supported) return LANGUAGES.map((t) => `${t}\n`).join('');
      if (options.engine === 'webspeech') return recognize(options, signal);
      if (!bytes.length) return '';
      const format = FORMATS[options.format] ?? 'json';
      const res = checked(await transcription(bytes, { ...options, format }));
      return transcript(res, options.format);
    },
  };

  async function handle(request) {
    const run = Object.hasOwn(handlers, request.kind) ? handlers[request.kind] : undefined;
    if (!run) {
      await drain(request.body);
      throw named('NotSupportedError', `slicc-audio does not answer ${request.kind}`);
    }
    return run({ ...request, options: request.options ?? {} });
  }

  return { kinds: Object.fromEntries(KINDS.map((kind) => [kind, {}])), handle };
}

const audio = createAudio();

export const { kinds, handle } = audio;

export default audio;
