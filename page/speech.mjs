import { clamp, lines, match, named, streamed } from './util.mjs';
import { convert } from './wav.mjs';

export function speechOf({ scope }, { kokoroVoice, synth }, { play, speak, webVoices }) {
  async function webSay(text, options, signal) {
    if (!scope.speechSynthesis)
      throw named('NotSupportedError', 'no speechSynthesis in this browser');
    if (options.output) throw named('NotSupportedError', "Web Speech can't write a file");
    const voices = await webVoices();
    let voice;
    if (options.voice) {
      voice = match(voices, options.voice)?.voice;
      if (!voice) throw named('NotFoundError', `voice "${options.voice}" not found`);
    } else if (options.lang) {
      const want = options.lang.replace('-', '_').toLowerCase();
      const pick =
        voices.find((v) => v.lang.toLowerCase() === want) ??
        voices.find((v) => v.lang.toLowerCase().split('_')[0] === want.split('_')[0]);
      if (!pick) throw named('NotFoundError', `no Web Speech voice for ${options.lang}`);
      voice = pick.voice;
    }
    const parts = options.interactive ? lines(text) : [text];
    return streamed(async (push) => {
      for (const line of parts) {
        if (options.interactive) push(`${line}\n`);
        await speak(line, { voice, lang: options.lang, rate: options.rate }, signal);
      }
    });
  }

  async function kokoroSay(text, options, signal) {
    const voice = await kokoroVoice(options);
    const request = { voice, speed: clamp(options.rate ?? 1, 0.25, 4), response_format: 'wav' };
    if (options.model) request.model = options.model;
    if (options.output) return convert(await synth(text, request), options.output);
    const parts = options.interactive ? lines(text) : [text];
    return streamed(async (push) => {
      for (const line of parts) {
        const wav = await synth(line, request);
        if (options.interactive) push(`${line}\n`);
        await play(wav, {}, signal);
      }
    });
  }

  return { kokoroSay, webSay };
}
