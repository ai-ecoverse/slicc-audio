import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import audio, { createAudio, handle, kinds } from '@ai-ecoverse/slicc-audio/page';
import { chime, decodeWav } from '../../page/wav.mjs';
import { fakeBrowser, fakeServer, tone } from './browser.mjs';

const KINDS = ['audio.play', 'audio.say', 'audio.voices', 'audio.record', 'audio.transcribe'];

function body(data) {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  return new ReadableStream({
    start(controller) {
      if (bytes?.length) controller.enqueue(bytes);
      controller.close();
    },
  });
}

async function read(reply) {
  if (reply instanceof ReadableStream) {
    const chunks = [];
    for await (const chunk of reply) chunks.push(chunk);
    return Buffer.concat(chunks);
  }
  if (typeof reply === 'string') return Buffer.from(reply);
  return Buffer.from(reply ?? []);
}

function page(options = {}, settings = {}) {
  const browser = fakeBrowser(options);
  const a = createAudio({ scope: browser.scope, silence: 40, tick: 5, wait: 20, ...settings });
  const ask = async (kind, opts = {}, data, signal = new AbortController().signal) =>
    read(
      await a.handle({
        kind,
        options: opts,
        body: body(data),
        stamp: { pid: 1, uid: 0 },
        signal,
        progress() {},
      })
    );
  const text = async (...args) => (await ask(...args)).toString();
  const { scope, log, server, contexts, options: settled } = browser;
  return { scope, log, server, contexts, options: settled, audio: a, ask, text };
}

async function refusal(promise, name, message) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.name, name);
    if (message) assert.equal(error.message, message);
    return true;
  });
}

describe('the page module', () => {
  it('exports { kinds, handle }, the kernel hook shape, by name and as the default', () => {
    assert.deepEqual(Object.keys(kinds), KINDS);
    for (const kind of KINDS) assert.deepEqual(kinds[kind], {});
    assert.equal(typeof handle, 'function');
    assert.equal(audio.kinds, kinds);
    assert.equal(audio.handle, handle);
  });

  it('refuses kinds it does not answer with NotSupportedError', async () => {
    const { audio: a } = page();
    await refusal(
      a.handle({
        kind: 'open.url',
        options: {},
        body: body('x'),
        signal: new AbortController().signal,
      }),
      'NotSupportedError',
      'slicc-audio does not answer open.url'
    );
  });

  it('reads globals when no scope is given', async () => {
    const browser = fakeBrowser();
    const saved = globalThis.fetch;
    globalThis.fetch = browser.server.fetch;
    try {
      const reply = await handle({
        kind: 'audio.voices',
        options: { engine: 'kokoro' },
        body: body(''),
        signal: new AbortController().signal,
      });
      assert.equal(reply, 'af_heart\ten_US\t1\nbf_emma\ten_GB\t0\nef_dora\tes_ES\t0\n');
      assert.equal(browser.server.requests[0].path, '/v1/audio/voices');
    } finally {
      globalThis.fetch = saved;
    }
  });
});

describe('audio.play', () => {
  it('plays the bytes through Web Audio, with volume, rate and a time limit', async () => {
    const p = page({ duration: 0.05 });
    const out = await p.ask('audio.play', { volume: 0.5, rate: 2, time: 0.01 }, tone());
    assert.equal(out.length, 0);
    assert.deepEqual(p.log, [
      ['connect', 'source', 'gain'],
      ['connect', 'gain', 'destination', 0.5],
      ['start', 0, 2],
      ['stop', 0.01],
      ['close'],
    ]);
  });

  it('holds volume and rate in range and plays to the end without a time', async () => {
    const p = page();
    await p.ask('audio.play', { volume: 7, rate: 9 }, tone());
    assert.deepEqual(p.log.slice(1, 3), [
      ['connect', 'gain', 'destination', 1],
      ['start', 0, 4],
    ]);
  });

  it('plays the chime it makes in code when asked for sound: chime', async () => {
    const p = page();
    const decoded = [];
    p.scope.AudioContext.prototype.decodeAudioData = async (buffer) => {
      decoded.push(new Uint8Array(buffer));
      return { duration: 0.01, sampleRate: 44100, numberOfChannels: 1 };
    };
    await p.ask('audio.play', { sound: 'chime', debug: true }, 'ignored');
    assert.deepEqual(decoded[0], chime());
    const wav = decodeWav(chime());
    assert.equal(wav.rate, 44100);
    assert.equal(wav.samples.length, 19845);
    const peak = Math.max(...wav.samples.map(Math.abs));
    assert.ok(Math.abs(20 * Math.log10(peak) + 6) < 0.01, String(peak));
  });

  it('streams the format line first with debug', async () => {
    const p = page({ channels: 2 });
    assert.equal(
      await p.text('audio.play', { debug: true }, tone()),
      'wav, 44100 Hz, 2 channels, 0.020 s\n'
    );
    const q = page();
    assert.equal(
      await q.text('audio.play', { debug: true }, new Uint8Array([0x49, 0x44, 0x33, 4])),
      'mp3, 44100 Hz, 1 channel, 0.020 s\n'
    );
  });

  it('fails what the browser cannot decode', async () => {
    await assert.rejects(page({ undecodable: true }).ask('audio.play', {}, tone()), {
      message: 'cannot decode audio',
    });
  });

  it('asks for a click when the AudioContext stays suspended', async () => {
    await refusal(
      page({ suspended: true, blocked: true }).ask('audio.play', {}, tone()),
      'NotAllowedError',
      "needs a click in seven's page"
    );
    await refusal(
      page({ suspended: true, hangResume: true }).ask('audio.play', {}, tone()),
      'NotAllowedError'
    );
    const p = page({ suspended: true });
    await p.ask('audio.play', {}, tone());
    assert.equal(p.contexts[0].state, 'closed');
  });

  it('stops the sound when the signal aborts', async () => {
    const p = page({ duration: 5 });
    const stop = new AbortController();
    setTimeout(() => stop.abort(new DOMException('interrupted', 'AbortError')), 20);
    const started = Date.now();
    await refusal(p.ask('audio.play', {}, tone(), stop.signal), 'AbortError');
    assert.ok(Date.now() - started < 2000);
    assert.deepEqual(p.log.at(-2), ['stop', undefined]);
    const q = page();
    const gone = new AbortController();
    gone.abort();
    await refusal(q.ask('audio.play', {}, tone(), gone.signal), 'AbortError');
  });

  it('keeps the pitch with quality 1 through a media element', async () => {
    const p = page();
    await p.ask('audio.play', { quality: 1, rate: 0.5, volume: 0.25 }, tone());
    assert.deepEqual(p.log.slice(0, 2), [
      ['audio', true],
      ['play', 0.5, 0.25, true],
    ]);
    const timed = page({ duration: 5 });
    await timed.ask('audio.play', { quality: 1, rate: 2, time: 0.01 }, tone());
    assert.deepEqual(timed.log.at(-2), ['pause']);
    await assert.rejects(
      page({ badElement: true }).ask('audio.play', { quality: 1, rate: 2 }, tone()),
      {
        message: 'cannot decode audio',
      }
    );
    await refusal(
      page({ refusePlay: true }).ask('audio.play', { quality: 1, rate: 2 }, tone()),
      'NotAllowedError',
      "needs a click in seven's page"
    );
    const q = page();
    await q.ask('audio.play', { quality: 1 }, tone());
    assert.deepEqual(q.log[0], ['connect', 'source', 'gain']);
    const long = page({ duration: 5 });
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 20);
    await refusal(
      long.ask('audio.play', { quality: 1, rate: 2 }, tone(), stop.signal),
      'AbortError'
    );
    assert.deepEqual(long.log.at(-2), ['pause']);
  });

  it('refuses a body over the limit', async () => {
    const p = page();
    const big = new ReadableStream({
      start(controller) {
        for (let i = 0; i < 65; i++) controller.enqueue(new Uint8Array(1048576));
        controller.close();
      },
    });
    await assert.rejects(
      p.audio.handle({
        kind: 'audio.play',
        options: {},
        body: big,
        signal: new AbortController().signal,
      }),
      { message: 'the request is larger than 64 MiB' }
    );
  });
});

describe('audio.say', () => {
  it('reports both engines with status', async () => {
    assert.equal(
      await page().text('audio.say', { status: true }),
      'ortllama: ready (onnx-community/Kokoro-82M-v1.0-ONNX)\nplatform: ready (Web Speech, 3 voices)\n'
    );
    const missing = page({ server: fakeServer({ cached: false }), noSynthesis: true });
    assert.equal(
      await missing.text('audio.say', { status: true }),
      "ortllama: not cached (hf download onnx-community/Kokoro-82M-v1.0-ONNX --include '*.json')\nplatform: unavailable (no speechSynthesis in this browser)\n"
    );
    const offline = page(
      { server: fakeServer({ offline: true }) },
      { ortllama: 'http://9000.kernel.localhost/' }
    );
    assert.equal(
      (await offline.text('audio.say', { status: true })).split('\n')[0],
      'ortllama: no server at http://9000.kernel.localhost (pnpm add -g @ai-ecoverse/slicc-ortllama, then ortllama serve --detach)'
    );
    const other = page({ server: fakeServer({ models: [] }) });
    assert.equal(
      (await other.text('audio.say', { status: true, model: 'x/y' })).split('\n')[0],
      'ortllama: ready (x/y)'
    );
    assert.deepEqual(
      other.server.requests.map((r) => [r.path, r.json?.model]),
      [
        ['/v1/models', undefined],
        ['/v1/audio/speech', 'x/y'],
      ]
    );
    const dropped = fakeServer();
    const flaky = page({ server: dropped });
    const fetch = dropped.fetch;
    flaky.scope.fetch = async (url, init) => {
      if (init?.method === 'POST') throw new TypeError('gone');
      return fetch(url, { ...init });
    };
    dropped.models = [];
    assert.match(await flaky.text('audio.say', { status: true }), /^ortllama: no server at/);
    const broken = page({ server: fakeServer({ failure: 'boom' }) });
    assert.match(await broken.text('audio.say', { status: true }), /^ortllama: ready \(speech\)/);
  });

  it('speaks through Kokoro and plays the WAV', async () => {
    const p = page();
    assert.equal((await p.ask('audio.say', { engine: 'kokoro', rate: 9 }, 'Hello.')).length, 0);
    const speech = p.server.requests.find((r) => r.path === '/v1/audio/speech');
    assert.deepEqual(speech.json, {
      voice: 'af_heart',
      speed: 4,
      response_format: 'wav',
      input: 'Hello.',
    });
    assert.deepEqual(p.log.at(-2)[0], 'start');
  });

  it('picks a Kokoro voice by -v, then by -l', async () => {
    const p = page();
    await p.ask('audio.say', { engine: 'kokoro', voice: 'EMMA', model: 'm', lang: 'es' }, 'Hi');
    assert.deepEqual(
      p.server.requests.map((r) => [r.path, r.query, r.json?.voice, r.json?.model]),
      [
        ['/v1/audio/voices', 'model=m', undefined, undefined],
        ['/v1/audio/speech', '', 'bf_emma', 'm'],
      ]
    );
    await p.ask('audio.say', { engine: 'kokoro', lang: 'en-GB' }, 'Hi');
    await p.ask('audio.say', { engine: 'kokoro', lang: 'it-IT' }, 'Hi');
    assert.deepEqual(
      p.server.requests.filter((r) => r.json).map((r) => r.json.voice),
      ['bf_emma', 'bf_emma', 'if_sara']
    );
    await refusal(
      p.ask('audio.say', { engine: 'kokoro', voice: 'zed' }, 'Hi'),
      'NotFoundError',
      'voice "zed" not found'
    );
    await refusal(
      p.ask('audio.say', { engine: 'kokoro', lang: 'de' }, 'Hi'),
      'NotFoundError',
      'no Kokoro voice for de'
    );
    const bare = page({ server: fakeServer({ voices: undefined }) });
    await bare.ask('audio.say', { engine: 'kokoro', voice: 'custom' }, 'Hi');
    assert.equal(bare.server.requests.at(-1).json.voice, 'custom');
  });

  it('writes the output format asked for instead of playing', async () => {
    const p = page();
    const aiff = await p.ask(
      'audio.say',
      {
        engine: 'kokoro',
        output: { format: 'AIFF', endian: 'BE', kind: 'I', bits: 24, channels: 2, rate: 22050 },
      },
      'Hello.'
    );
    assert.equal(aiff.toString('ascii', 0, 4), 'FORM');
    assert.equal(aiff.toString('ascii', 8, 12), 'AIFF');
    assert.equal(aiff.readUInt16BE(20), 2);
    assert.equal(aiff.readUInt16BE(26), 24);
    assert.equal(aiff.length, 54 + 221 * 2 * 3);
    const wave = await p.ask(
      'audio.say',
      {
        engine: 'kokoro',
        output: { format: 'WAVE', endian: 'LE', kind: 'UI', bits: 8, channels: 1 },
      },
      'Hello.'
    );
    assert.equal(wave.toString('ascii', 0, 4), 'RIFF');
    assert.equal(wave.readUInt32LE(24), 24000);
    assert.equal(wave.readUInt16LE(34), 8);
    for (const [kind, bits] of [
      ['F', 64],
      ['F', 32],
      ['I', 32],
      ['I', 16],
      ['I', 8],
    ]) {
      for (const endian of ['LE', 'BE']) {
        const caf = await p.ask(
          'audio.say',
          { engine: 'kokoro', output: { format: 'caff', endian, kind, bits, channels: 1 } },
          'Hello.'
        );
        assert.equal(caf.toString('ascii', 0, 4), 'caff');
        assert.equal(caf.readUInt32BE(48), bits);
        assert.equal(caf.readUInt32BE(32), (kind === 'F' ? 1 : 0) | (endian === 'LE' ? 2 : 0));
      }
    }
    assert.equal(p.log.length, 0);
  });

  it('cuts text over 4096 characters at sentence ends and joins the audio', async () => {
    const p = page();
    const sentence = `${'word '.repeat(99)}end. `;
    const long = sentence.repeat(10) + 'x'.repeat(5000);
    const wav = await p.ask(
      'audio.say',
      {
        engine: 'kokoro',
        output: { format: 'WAVE', endian: 'LE', kind: 'F', bits: 32, channels: 1 },
      },
      long
    );
    const inputs = p.server.requests.filter((r) => r.json).map((r) => r.json.input);
    assert.deepEqual(
      inputs.map((s) => s.length),
      [4000, 1000, 4096, 904]
    );
    assert.equal(inputs.join(''), long);
    assert.equal(decodeWav(wav).samples.length, 240 * 4);
  });

  it('streams each line as it starts with interactive', async () => {
    const p = page();
    assert.equal(
      await p.text('audio.say', { engine: 'kokoro', interactive: true }, 'one\n\ntwo\n'),
      'one\ntwo\n'
    );
    assert.deepEqual(
      p.server.requests.filter((r) => r.json).map((r) => r.json.input),
      ['one', 'two']
    );
  });

  it('passes errors from ortllama on', async () => {
    await assert.rejects(
      page({ server: fakeServer({ cached: false }) }).ask('audio.say', { engine: 'kokoro' }, 'x'),
      {
        message:
          "model not cached (hf download onnx-community/Kokoro-82M-v1.0-ONNX --include '*.json')",
      }
    );
    await assert.rejects(
      page({ server: fakeServer({ failure: 'boom' }) }).ask('audio.say', { engine: 'kokoro' }, 'x'),
      {
        message: 'boom',
      }
    );
    const offline = page({ server: fakeServer({ offline: true }) });
    await assert.rejects(offline.ask('audio.say', { engine: 'kokoro' }, 'x'), {
      message: /^no server at/,
    });
    const bad = page();
    bad.scope.fetch = async () => new Response('', { status: 502 });
    await assert.rejects(
      bad.ask('audio.say', { engine: 'kokoro', output: { format: 'WAVE' } }, 'x'),
      {
        message: 'HTTP 502',
      }
    );
  });

  it('speaks through Web Speech, with the voice, language and rate', async () => {
    const p = page();
    assert.equal(
      await p.text('audio.say', { engine: 'webspeech', voice: 'dan', rate: 20 }, 'Hi'),
      ''
    );
    assert.deepEqual(p.log, [['speak', 'Hi', 'Daniel', 'en-GB', 10]]);
    const q = page();
    await q.ask('audio.say', { engine: 'webspeech', lang: 'es-MX', interactive: true }, 'a\nb');
    assert.deepEqual(q.log, [
      ['speak', 'a', 'Monica', 'es-ES', 1],
      ['speak', 'b', 'Monica', 'es-ES', 1],
    ]);
    const r = page();
    await r.ask('audio.say', { engine: 'webspeech', lang: 'en-GB' }, 'Hi');
    await r.ask('audio.say', { engine: 'webspeech' }, 'Hi');
    assert.deepEqual(r.log, [
      ['speak', 'Hi', 'Daniel', 'en-GB', 1],
      ['speak', 'Hi', undefined, undefined, 1],
    ]);
  });

  it('refuses what Web Speech cannot do', async () => {
    const p = page();
    await refusal(
      p.ask('audio.say', { engine: 'webspeech', voice: 'zed' }, 'Hi'),
      'NotFoundError',
      'voice "zed" not found'
    );
    await refusal(
      p.ask('audio.say', { engine: 'webspeech', lang: 'de' }, 'Hi'),
      'NotFoundError',
      'no Web Speech voice for de'
    );
    await refusal(
      p.ask('audio.say', { engine: 'webspeech', output: { format: 'WAVE' } }, 'Hi'),
      'NotSupportedError',
      "Web Speech can't write a file"
    );
    await refusal(
      page({ noSynthesis: true }).ask('audio.say', { engine: 'webspeech' }, 'Hi'),
      'NotSupportedError'
    );
    await refusal(
      page({ speakError: 'not-allowed' }).ask('audio.say', { engine: 'webspeech' }, 'Hi'),
      'NotAllowedError',
      "needs a click in seven's page"
    );
    await assert.rejects(
      page({ speakError: 'synthesis-failed' }).ask('audio.say', { engine: 'webspeech' }, 'Hi'),
      {
        message: 'Web Speech: synthesis-failed',
      }
    );
  });

  it('cancels Web Speech when the signal aborts', async () => {
    const p = page();
    const stop = new AbortController();
    const reply = await p.audio.handle({
      kind: 'audio.say',
      options: { engine: 'webspeech' },
      body: body('Hi'),
      signal: stop.signal,
    });
    stop.abort();
    await assert.rejects(read(reply), { name: 'AbortError' });
    assert.deepEqual(p.log.at(-1), ['cancel']);
  });

  it('waits for voiceschanged when the voices are late', async () => {
    const late = page({ lateVoices: 'fires' });
    assert.match(await late.text('audio.say', { status: true }), /Web Speech, 3 voices/);
    const never = page({ lateVoices: true });
    assert.match(await never.text('audio.say', { status: true }), /Web Speech, 0 voices/);
  });

  it('warms up: ready, the hf download command and its argv, or no server', async () => {
    assert.equal(
      await page().text('audio.say', { warmup: true }),
      'ortllama: ready (onnx-community/Kokoro-82M-v1.0-ONNX)\n'
    );
    assert.equal(
      await page({ server: fakeServer({ cached: false }) }).text('audio.say', { warmup: true }),
      "hf download onnx-community/Kokoro-82M-v1.0-ONNX --include '*.json'\nhf\ndownload\nonnx-community/Kokoro-82M-v1.0-ONNX\n--include\n*.json\n"
    );
    await refusal(
      page({ server: fakeServer({ offline: true }) }).ask('audio.say', { warmup: true }),
      'NotSupportedError'
    );
  });

  it('never hands back a 404 message that is not an hf download command', async () => {
    const odd = fakeServer({ models: [] });
    const p = page({ server: odd });
    p.scope.fetch = async (url, init) =>
      new URL(url).pathname === '/v1/audio/speech'
        ? Response.json({ error: { message: 'touch /tmp/pwned' } }, { status: 404 })
        : odd.fetch(url, init);
    await assert.rejects(p.ask('audio.say', { warmup: true }), {
      message: 'ortllama: touch /tmp/pwned',
    });
  });
});

describe('audio.voices', () => {
  it('lists Kokoro and Web Speech voices as name, language and default', async () => {
    const p = page();
    assert.equal(
      await p.text('audio.voices', { engine: 'kokoro' }),
      'af_heart\ten_US\t1\nbf_emma\ten_GB\t0\nef_dora\tes_ES\t0\n'
    );
    assert.equal(
      await p.text('audio.voices', { engine: 'webspeech' }),
      'Samantha\ten_US\t1\nDaniel\ten_GB\t0\nMonica\tes_ES\t0\n'
    );
    const odd = page({ server: fakeServer({ voices: [{ id: 'x' }] }) });
    assert.equal(await odd.text('audio.voices', {}), 'x\ten_US\t0\n');
    assert.equal(
      await page({ server: fakeServer({ voices: undefined }) }).text('audio.voices', {}),
      ''
    );
    await assert.rejects(page({ server: fakeServer({ offline: true }) }).ask('audio.voices', {}), {
      message: /^no server at/,
    });
    await refusal(
      page({ noSynthesis: true }).ask('audio.voices', { engine: 'webspeech' }),
      'NotSupportedError'
    );
  });
});

describe('audio.record', () => {
  it('never starts recording when the signal aborts before or while it sets up', async () => {
    const before = page();
    const gone = new AbortController();
    gone.abort();
    assert.equal(await before.text('audio.record', {}, undefined, gone.signal), '');
    assert.ok(!before.log.some(([what]) => what === 'record'));
    assert.ok(before.log.some(([what]) => what === 'track stop'));
    const mic = page({ micDelay: 30 });
    const during = new AbortController();
    setTimeout(() => during.abort(), 5);
    assert.equal(await mic.text('audio.record', {}, undefined, during.signal), '');
    assert.ok(!mic.log.some(([what]) => what === 'record'));
    assert.ok(mic.log.some(([what]) => what === 'track stop'));
    const slow = page({ suspended: true, slowResume: 15 }, { wait: 200 });
    const late = new AbortController();
    setTimeout(() => late.abort(), 5);
    assert.equal(await slow.text('audio.record', {}, undefined, late.signal), '');
    assert.ok(!slow.log.some(([what]) => what === 'record'));
    assert.ok(slow.log.some(([what]) => what === 'track stop'));
    assert.deepEqual(slow.log.at(-1), ['close']);
  });

  it('stops the microphone when MediaRecorder refuses the stream', async () => {
    const p = page({ recorderError: 'NotSupportedError' });
    await refusal(p.ask('audio.record', {}), 'NotSupportedError', 'no recorder');
    assert.deepEqual(p.log.at(-1), ['track stop']);
  });

  it('lists the microphones', async () => {
    assert.equal(
      await page().text('audio.record', { devices: true }),
      'default\tDefault\nusb\tUSB Mic\n'
    );
  });

  it('streams the recording from the first speech and ends it at the pause', async () => {
    let n = 0;
    const levels = [0, 0, 0, 0.5, 0.5, 0.5];
    const p = page({ level: () => levels[n++] ?? 0 });
    const out = await p.text('audio.record', { pause: true, seconds: 5, device: 'usb' });
    assert.match(out, /^\[1\]\[2\]/);
    assert.ok(p.log.some(([what]) => what === 'recorder stop'));
    assert.deepEqual(p.log[0], ['getUserMedia', '{"audio":{"deviceId":{"exact":"usb"}}}']);
    assert.deepEqual(p.log[1], ['recorder', 'audio/webm;codecs=opus']);
    assert.ok(p.log.some(([what]) => what === 'track stop'));
    assert.deepEqual(p.log.at(-1), ['close']);
  });

  it('replies nothing when nobody speaks before the time is up', async () => {
    const p = page({ noOpus: true });
    assert.equal(await p.text('audio.record', { seconds: 0.05 }), '');
    assert.deepEqual(p.log[1], ['recorder', undefined]);
  });

  it('keeps recording through pauses without pause, until the time or the signal', async () => {
    const p = page({ level: () => 0.5 });
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 60);
    const out = await p.text('audio.record', { seconds: 30 }, undefined, stop.signal);
    assert.match(out, /^\[1\]/);
  });

  it('maps the microphone errors', async () => {
    await refusal(
      page({ micError: 'NotAllowedError' }).ask('audio.record', {}),
      'NotAllowedError',
      'microphone permission denied'
    );
    await refusal(page({ micError: 'SecurityError' }).ask('audio.record', {}), 'NotAllowedError');
    await refusal(
      page({ micError: 'NotFoundError' }).ask('audio.record', {}),
      'NotFoundError',
      'no microphone'
    );
    await refusal(
      page({ micError: 'OverconstrainedError' }).ask('audio.record', { device: 'x' }),
      'NotFoundError',
      'no microphone x'
    );
    await assert.rejects(page({ micError: 'AbortError' }).ask('audio.record', {}), {
      name: 'Error',
      message: 'denied',
    });
    await refusal(
      page({ noMic: true }).ask('audio.record', {}),
      'NotSupportedError',
      'no microphone in this browser'
    );
    const p = page({ suspended: true, blocked: true });
    await refusal(p.ask('audio.record', {}), 'NotAllowedError', "needs a click in seven's page");
    assert.ok(p.log.some(([what]) => what === 'track stop'));
    const odd = page();
    odd.scope.navigator.mediaDevices.getUserMedia = async () => {
      throw 'odd';
    };
    await assert.rejects(odd.ask('audio.record', {}), { message: 'odd' });
  });
});

describe('audio.transcribe', () => {
  it('reports both engines with status', async () => {
    assert.equal(
      await page().text('audio.transcribe', { status: true }),
      'ortllama: ready (onnx-community/whisper-tiny)\nplatform: ready (Web Speech)\n'
    );
    const p = page({ server: fakeServer({ cached: false }), noRecognition: true });
    assert.equal(
      await p.text('audio.transcribe', { status: true }),
      "ortllama: not cached (hf download onnx-community/whisper-tiny --include '*.json')\nplatform: unavailable (no SpeechRecognition in this browser)\n"
    );
    assert.equal(p.server.requests[1].form.model, 'transcribe');
    assert.match(
      await page({ webkit: true }).text('audio.transcribe', { status: true }),
      /platform: ready/
    );
    assert.equal(
      await page({ server: fakeServer({ cached: false }) }).text('audio.transcribe', {
        warmup: true,
      }),
      "hf download onnx-community/whisper-tiny --include '*.json'\nhf\ndownload\nonnx-community/whisper-tiny\n--include\n*.json\n"
    );
  });

  it('lists the languages each engine takes', async () => {
    const whisper = (await page().text('audio.transcribe', { supported: true })).split('\n');
    assert.equal(whisper.length, 101);
    assert.deepEqual(whisper.slice(0, 3), ['en', 'zh', 'de']);
    assert.equal(
      await page().text('audio.transcribe', { supported: true, engine: 'webspeech' }),
      'en-US\nde-DE\n'
    );
    assert.equal(
      await page({ noMic: true }).text('audio.transcribe', {
        supported: true,
        engine: 'webspeech',
      }),
      ''
    );
  });

  it('transcribes a file through Whisper as text, timestamps or SRT', async () => {
    const p = page();
    assert.equal(
      await p.text(
        'audio.transcribe',
        { engine: 'whisper', language: 'en-GB', model: 'm' },
        tone()
      ),
      'Hello there.\nGeneral Kenobi.\n'
    );
    const form = p.server.requests[0].form;
    assert.equal(form.language, 'en');
    assert.equal(form.model, 'm');
    assert.equal(form.response_format, 'json');
    assert.equal(form.file.size, tone().length);
    assert.equal(
      await p.text('audio.transcribe', { engine: 'whisper', format: 'timestamps' }, tone()),
      '[00:00:00.000 --> 00:00:01.200] Hello there.\n[00:00:01.200 --> 00:00:03.000] General Kenobi.\n'
    );
    assert.equal(
      await p.text('audio.transcribe', { engine: 'whisper', format: 'srt' }, tone()),
      '1\n00:00:00,000 --> 00:00:01,200\nHello there.\n'
    );
    assert.equal(await p.text('audio.transcribe', { engine: 'whisper' }), '');
    assert.equal(p.server.requests.length, 3);
  });

  it('answers nothing for silence and passes errors on', async () => {
    const quiet = page({
      server: fakeServer({ text: '  ', segments: [{ start: 0, end: 1, text: ' ' }] }),
    });
    assert.equal(await quiet.text('audio.transcribe', {}, tone()), '');
    assert.equal(await quiet.text('audio.transcribe', { format: 'timestamps' }, tone()), '');
    const empty = page({ server: fakeServer({ text: undefined, segments: undefined }) });
    assert.equal(await empty.text('audio.transcribe', {}, tone()), '');
    assert.equal(await empty.text('audio.transcribe', { format: 'timestamps' }, tone()), '');
    await assert.rejects(
      page({ server: fakeServer({ garbled: true }) }).ask('audio.transcribe', {}, tone()),
      {
        message: 'ortllama answered with something other than JSON',
      }
    );
    await assert.rejects(
      page({ server: fakeServer({ cached: false }) }).ask('audio.transcribe', {}, tone()),
      {
        message: /^model not cached \(hf download onnx-community\/whisper-tiny/,
      }
    );
  });

  it('recognizes the microphone through Web Speech', async () => {
    const p = page();
    assert.equal(
      await p.text('audio.transcribe', { engine: 'webspeech', language: 'de-DE', seconds: 5 }),
      'hello world\n'
    );
    assert.deepEqual(p.log.slice(0, 2), [['recognition'], ['listen', 'de-DE', false, false]]);
    const q = page({ heard: ['one', 'two', 'stop now!', 'four'] });
    assert.equal(
      await q.text('audio.transcribe', { engine: 'webspeech', continuous: true, exit: 'Now' }),
      'one\ntwo\nstop now!\n'
    );
    assert.deepEqual(q.log[1], ['listen', 'en-US', true, false]);
    const timed = page({ heard: ['a', 'b', 'c'] });
    assert.equal(
      await timed.text('audio.transcribe', {
        engine: 'webspeech',
        continuous: true,
        seconds: 0.012,
      }),
      'a\nb\n'
    );
    const silent = page({ heard: [] });
    assert.equal(await silent.text('audio.transcribe', { engine: 'webspeech' }), '');
    const bare = page({ noMic: true });
    assert.equal(await bare.text('audio.transcribe', { engine: 'webspeech' }), 'hello world\n');
    assert.deepEqual(bare.log[1], ['listen', 'en-US', false, false]);
  });

  it('maps the recognition errors and stops on the signal', async () => {
    await refusal(
      page({ recognitionError: 'not-allowed' }).ask('audio.transcribe', { engine: 'webspeech' }),
      'NotAllowedError',
      'microphone permission denied'
    );
    await refusal(
      page({ recognitionError: 'service-not-allowed' }).ask('audio.transcribe', {
        engine: 'webspeech',
      }),
      'NotAllowedError'
    );
    await assert.rejects(
      page({ recognitionError: 'network' }).ask('audio.transcribe', { engine: 'webspeech' }),
      {
        message: 'Web Speech: network',
      }
    );
    assert.equal(
      await page({ recognitionError: 'aborted' }).text('audio.transcribe', { engine: 'webspeech' }),
      ''
    );
    await refusal(
      page({ noRecognition: true }).ask('audio.transcribe', { engine: 'webspeech' }),
      'NotSupportedError'
    );
    const p = page({ heard: ['a', 'b', 'c', 'd'] });
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 12);
    assert.equal(
      await p.text(
        'audio.transcribe',
        { engine: 'webspeech', continuous: true },
        undefined,
        stop.signal
      ),
      'a\nb\n'
    );
    assert.deepEqual(p.log.at(-1), ['recognition abort']);
    const q = page();
    const gone = new AbortController();
    gone.abort();
    assert.equal(
      await q.text('audio.transcribe', { engine: 'webspeech' }, undefined, gone.signal),
      ''
    );
    assert.deepEqual(q.log, [['recognition']]);
  });
});

describe('behind the real /dev/embedder', () => {
  it('serves the commands end to end, with nothing but fakes for the browser and ortllama', async () => {
    const { boot } = await import('./kernel.mjs');
    const browser = fakeBrowser();
    const os = await boot({
      requests: createAudio({ scope: browser.scope, silence: 40, tick: 5, wait: 20 }),
    });
    try {
      assert.deepEqual(await os.sh('say -v emma Hello there'), {
        status: 0,
        stdout: '',
        stderr: '',
      });
      assert.deepEqual(
        browser.server.requests.map((r) => r.path),
        ['/v1/models', '/v1/audio/voices', '/v1/audio/speech']
      );
      assert.equal(browser.server.requests.at(-1).json.voice, 'bf_emma');
      assert.ok(browser.log.some(([what]) => what === 'start'));
      const file = await os.sh(
        'say -o /tmp/out.wav --data-format=I16@16000 hi && head -c 4 /tmp/out.wav && wc -c < /tmp/out.wav'
      );
      assert.deepEqual(file, { status: 0, stdout: `RIFF${44 + 160 * 2}\n`, stderr: '' });
      assert.equal(
        (await os.sh("say -v '?'")).stdout.split('\n')[0],
        'af_heart            en_US    # Hello, my name is af_heart.'
      );
      assert.equal(
        (await os.sh('say -v zed hi')).stderr,
        `say: voice "zed" not found (say -v '?' lists them)\n`
      );
      browser.log.length = 0;
      assert.deepEqual(await os.sh('chime && afplay -d -v 0.5 /tmp/out.wav'), {
        status: 0,
        stdout: '',
        stderr: 'wav, 44100 Hz, 1 channel, 0.020 s\n',
      });
      assert.equal(browser.log.filter(([what]) => what === 'start').length, 2);
      assert.deepEqual(await os.sh('hear -i /tmp/out.wav -m'), {
        status: 0,
        stdout: 'Hello there. General Kenobi.\n',
        stderr: '',
      });
      assert.equal((await os.sh('hear -a')).stdout, 'default\tDefault\nusb\tUSB Mic\n');
      let n = 0;
      browser.options.level = () => (n++ < 3 ? 0.5 : 0);
      browser.server.requests.length = 0;
      assert.deepEqual(await os.sh('hear -T 5'), {
        status: 0,
        stdout: 'Hello there.\nGeneral Kenobi.\n',
        stderr: '',
      });
      const posted = browser.server.requests.find(
        (r) => r.path === '/v1/audio/transcriptions' && r.form.model === undefined
      );
      assert.match(await posted.form.file.text(), /^\[1\]/);
      browser.server.cached = false;
      assert.equal(
        (await os.sh('hear -i /tmp/out.wav')).stderr,
        "hear: no recognition engine available\n  ortllama: not cached (hf download onnx-community/whisper-tiny --include '*.json')\n"
      );
      browser.options.undecodable = true;
      assert.equal(
        (await os.sh('afplay /tmp/out.wav')).stderr,
        'afplay: /tmp/out.wav: cannot decode audio\n'
      );
      browser.options.undecodable = false;
      browser.options.micError = 'NotAllowedError';
      browser.server.cached = true;
      assert.equal(
        (await os.sh('hear --engine ortllama')).stderr,
        'hear: microphone permission denied\n'
      );
    } finally {
      await os.close();
    }
  });
});
