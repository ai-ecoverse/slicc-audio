import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { boot, bootOld, fakePage, pkg } from './kernel.mjs';

const SAY_READY =
  'ortllama: ready (onnx-community/Kokoro-82M-v1.0-ONNX)\nplatform: ready (Web Speech, 2 voices)\n';
const HEAR_READY = 'ortllama: ready (onnx-community/whisper-tiny)\nplatform: ready (Web Speech)\n';
const SAY_USAGE = (me) =>
  `usage: ${me} [-v voice] [-r rate] [-l lang] [-o file [--file-format=fmt] [--data-format=fmt] [--channels=n]] [-i] [-f file | text ...]\n       ${me} -v '?' | --list | --status | --warmup\n`;
const HEAR_USAGE = (me) =>
  `usage: ${me} [-i file] [-l lang] [-T seconds] [-d device] [-x word] [-m] [-p] [--timestamps | -S] [--device]\n       ${me} -a | -s | --status | --warmup\n`;
const PLAY_USAGE = (me) => `usage: ${me} [-v volume] [-t time] [-r rate] [-q quality] [-d] file\n`;
const PAIRS = [
  ['say', 'scsay'],
  ['hear', 'schear'],
  ['afplay', 'scplay'],
  ['chime', 'scchime'],
];
const NAMES = PAIRS.flat();

const page = fakePage();
const world = {};

function reset() {
  Object.assign(world, {
    say: SAY_READY,
    hear: HEAR_READY,
    warm: 'ortllama: ready (onnx-community/Kokoro-82M-v1.0-ONNX)\n',
    voices: {
      kokoro: 'af_heart\ten_US\t1\nbf_emma\ten_GB\t0\n',
      webspeech: 'Google US English\ten_US\t1\n',
    },
    transcripts: ['hello world\n'],
    fail: undefined,
    hang: false,
  });
  page.calls = [];
}

page.answer = async (call) => {
  const { kind, options } = call;
  if (world.fail && !options.status && (world.fail.kind ?? kind) === kind) throw world.fail.error;
  if (options.status) return kind === 'audio.say' ? world.say : world.hear;
  if (options.warmup) return world.warm;
  if (world.hang) {
    await new Promise((resolve) => call.signal.addEventListener('abort', resolve));
    world.aborted = call.signal.reason?.message;
    return '';
  }
  if (kind === 'audio.voices') return world.voices[options.engine];
  if (kind === 'audio.record') return options.devices ? 'default\tDefault\nusb\tUSB Mic\n' : 'REC';
  if (kind === 'audio.transcribe') {
    if (options.supported) return options.engine === 'webspeech' ? 'en-US\n' : 'en\nde\n';
    return world.transcripts.length > 1 ? world.transcripts.shift() : world.transcripts[0];
  }
  if (kind === 'audio.say') {
    if (options.output) return 'AUDIO';
    if (options.interactive) return call.body.toString().replace(/\n+$/, '\n');
    return '';
  }
  if (options.debug) return 'wav, 44100 Hz, 1 channel, 0.450 s\n';
  return '';
};

const named = (name, message) => Object.assign(new Error(message), { name });

let os;

async function sh(script, opts) {
  page.calls = [];
  return os.sh(script, opts);
}

const requests = () =>
  page.calls.filter((c) => !c.options.status).map((c) => [c.kind, c.options, c.body.toString()]);

before(async () => {
  os = await boot({ requests: page });
  await os.sh(
    "printf 'RIFFdata' > /tmp/clip.wav && printf 'some text' > /tmp/text.txt && head -c 3145728 /dev/zero > /tmp/big.wav"
  );
});

after(() => os?.close());

beforeEach(reset);

describe('on the kernel', () => {
  it('lists all eight commands and has /dev/embedder', async () => {
    const result = await sh(`command -v ${NAMES.join(' ')} && test -c /dev/embedder`);
    assert.equal(result.stdout, NAMES.map((n) => `/usr/bin/${n}\n`).join(''));
    assert.equal(result.status, 0);
  });

  it('prints the version and the pnpm upgrade, alone', async () => {
    for (const name of NAMES) {
      assert.deepEqual(await sh(`${name} --version`), {
        status: 0,
        stdout: `${pkg.version}\n`,
        stderr: '',
      });
      assert.deepEqual(await sh(`${name} --upgrade`), {
        status: 0,
        stdout: 'pnpm add -g @ai-ecoverse/slicc-audio@latest\n',
        stderr: '',
      });
      const extra = await sh(`${name} --version --upgrade`);
      assert.equal(extra.status, 2, name);
      assert.match(
        extra.stderr,
        new RegExp(`^${name}: --version takes no other arguments\nusage: ${name}`)
      );
    }
    assert.equal((await sh('hear -v')).stdout, `${pkg.version}\n`);
    assert.match((await sh('hear -v -m')).stderr, /^hear: -v takes no other arguments/);
    assert.match(
      (await sh('say --upgrade=x hi')).stderr,
      /^say: --upgrade takes no other arguments/
    );
    assert.equal(page.calls.length, 0);
  });

  it('prints the usage of each name, its own', async () => {
    for (const [a, b] of PAIRS) {
      for (const name of [a, b]) {
        const usage =
          a === 'say'
            ? SAY_USAGE(name)
            : a === 'hear'
              ? HEAR_USAGE(name)
              : a === 'afplay'
                ? PLAY_USAGE(name)
                : `usage: ${name}\n`;
        assert.deepEqual(await sh(`${name} --help`), { status: 0, stdout: usage, stderr: '' });
        assert.deepEqual(await sh(`${name} -h`), { status: 0, stdout: usage, stderr: '' });
      }
    }
    assert.equal((await sh('afplay -help')).stdout, PLAY_USAGE('afplay'));
    assert.match((await sh('say --help=x')).stderr, /^say: --help takes no value/);
  });
});

describe('say', () => {
  it('asks for the status, then speaks the arguments through Kokoro', async () => {
    assert.deepEqual(await sh('say hello   world'), { status: 0, stdout: '', stderr: '' });
    assert.deepEqual(
      page.calls.map((c) => [c.kind, c.options, c.body.toString()]),
      [
        ['audio.say', { status: true }, ''],
        ['audio.say', { engine: 'kokoro' }, 'hello world'],
      ]
    );
    assert.equal(page.calls[1].stamp.kind, 'audio.say');
    await sh('scsay -- -v x');
    assert.deepEqual(requests(), [['audio.say', { engine: 'kokoro' }, '-v x']]);
  });

  it('reads the text from stdin, -f and --input-file', async () => {
    for (const script of [
      'printf "from stdin" | say',
      'printf "from stdin" | say -f -',
      "printf 'from stdin' > /tmp/in.txt && say -f /tmp/in.txt",
      'printf "from stdin" > /tmp/in.txt && say --input-file=/tmp/in.txt',
    ]) {
      assert.equal((await sh(script)).status, 0, script);
      assert.deepEqual(requests(), [['audio.say', { engine: 'kokoro' }, 'from stdin']], script);
    }
    assert.deepEqual(await sh('say -f /tmp/none'), {
      status: 1,
      stdout: '',
      stderr: 'say: cannot open /tmp/none: No such file\n',
    });
  });

  it('speaks nothing for empty text', async () => {
    for (const script of ['say ""', "printf ' \\n' | say", 'say < /dev/null']) {
      assert.deepEqual(await sh(script), { status: 0, stdout: '', stderr: '' }, script);
    }
    assert.deepEqual(page.calls, []);
  });

  it('sends the voice, language, rate and model', async () => {
    await sh('say -v Emma -l en_gb -r 2.5 --model=x/kokoro hi');
    assert.deepEqual(requests(), [
      [
        'audio.say',
        { engine: 'kokoro', voice: 'Emma', lang: 'en-GB', rate: 2.5, model: 'x/kokoro' },
        'hi',
      ],
    ]);
    assert.deepEqual(page.calls[0].options, { status: true, model: 'x/kokoro' });
    await sh('say --voice=af --lang=ES-mx --rate=350 hi');
    assert.deepEqual(requests()[0][1], { engine: 'kokoro', voice: 'af', lang: 'es-MX', rate: 2 });
    await sh('say -r 0.1 -l pt-BR-ab1 hi');
    assert.deepEqual(requests()[0][1], { engine: 'kokoro', lang: 'pt-BR-ab1', rate: 0.1 });
    await sh('say -r 175 -v "a\\"b\\\\c" hi');
    assert.deepEqual(requests()[0][1], { engine: 'kokoro', voice: 'a"b\\c', rate: 1 });
    await sh('say -r .5 hi; say -r 1000 hi; say -r 007 hi');
    assert.deepEqual(
      page.calls.filter((c) => !c.options.status).map((c) => c.options.rate),
      [0.5, 5.714, 7]
    );
  });

  it('refuses bad values with exit 2', async () => {
    const cases = [
      ['say -r 0.05 hi', '-r 0.05: a multiple from 0.1 to 10, or words per minute up to 1000'],
      ['say -r 1001 hi', '-r 1001: a multiple from 0.1 to 10, or words per minute up to 1000'],
      ['say -r fast hi', '-r fast: a multiple from 0.1 to 10, or words per minute up to 1000'],
      ['say -r 1.2.3 hi', '-r 1.2.3: a multiple from 0.1 to 10, or words per minute up to 1000'],
      [
        'say -r 99999999999 hi',
        '-r 99999999999: a multiple from 0.1 to 10, or words per minute up to 1000',
      ],
      ['say -l english hi', '-l english: not a language tag'],
      ['say -l en-x hi', '-l en-x: not a language tag'],
      ['say -l en-a_b hi', '-l en-a_b: not a language tag'],
      ['say --lang=e1 hi', '--lang e1: not a language tag'],
      ['say --engine=ollama hi', '--engine ollama: one of ortllama, platform'],
      ['say --channels=3 -o x.wav hi', '--channels 3: 1 or 2'],
      ['say -o x --file-format=mp3 hi', '--file-format mp3: no encoder for it'],
      ['say -o x.wav --data-format=aac hi', '--data-format aac: no encoder for it'],
      ['say -o x.wav --data-format=I12 hi', '--data-format I12: no encoder for it'],
      ['say -o x.wav --data-format=I16@ hi', '--data-format I16@: no encoder for it'],
      ['say -o x.wav --data-format=I16@2x hi', '--data-format I16@2x: no encoder for it'],
      ['say -o x.wav --data-format=BEI16 hi', '--data-format BEI16: no encoder for it in WAVE'],
      ['say -o x.aiff --data-format=F32 hi', '--data-format F32: no encoder for it in AIFF'],
      ['say -o x.wav --data-format=I16@999 hi', '--data-format I16@999: bad sample rate'],
      ['say -o x.wav --data-format=I16@400000 hi', '--data-format I16@400000: bad sample rate'],
      ['say --data-format=I16 hi', '--file-format, --data-format and --channels need -o'],
      ['say --channels=2 hi', '--file-format, --data-format and --channels need -o'],
      ['say -o x.wav --engine=platform hi', "-o: Web Speech can't write a file"],
      ['say -v', '-v needs a value'],
      ['say --list=x', '--list takes no value'],
      ['say --status=1', '--status takes no value'],
      ['say --warmup=1', '--warmup takes no value'],
      ['say -i=x hi', 'unknown option: -i=x'],
      ['say -x hi', 'unknown option: -x'],
      ['say --voice="$(printf "a\\tb")" hi', '--voice: no control characters in a value'],
    ];
    for (const [script, message] of cases) {
      assert.deepEqual(
        await sh(script),
        { status: 2, stdout: '', stderr: `say: ${message}\n${SAY_USAGE('say')}` },
        script
      );
    }
    assert.deepEqual(page.calls, []);
  });

  it("refuses the options a browser can't do", async () => {
    for (const [option, what] of [
      ['-n host', '-n (network send)'],
      ['--network-send=host', '--network-send (network send)'],
      ['-a 1', '-a (audio device)'],
      ['--audio-device 1', '--audio-device (audio device)'],
      ['--progress', '--progress (progress reports)'],
      ['--bit-rate 64000', '--bit-rate (AAC bit rate)'],
      ['--quality 127', '--quality (AAC quality)'],
    ]) {
      assert.deepEqual(await sh(`say ${option} hi`), {
        status: 2,
        stdout: '',
        stderr: `say: ${what} isn't supported in SLICC\n${SAY_USAGE('say')}`,
      });
    }
  });

  it('falls back to Web Speech, and lists every engine when none is there', async () => {
    world.say = 'ortllama: not cached (hf download k)\nplatform: ready (Web Speech, 2 voices)\n';
    await sh('say -v Goo -r 2 -i hi');
    assert.deepEqual(requests(), [
      ['audio.say', { engine: 'webspeech', voice: 'Goo', rate: 2, interactive: true }, 'hi'],
    ]);
    world.say =
      'ortllama: not cached (hf download k)\nplatform: unavailable (no speechSynthesis in this browser)\n';
    assert.deepEqual(await sh('say secret words'), {
      status: 1,
      stdout: '',
      stderr:
        'say: no speech engine available\n  ortllama: not cached (hf download k)\n  platform: unavailable (no speechSynthesis in this browser)\n',
    });
    world.say = SAY_READY;
    await sh('say --engine=platform hi');
    assert.deepEqual(requests()[0][1], { engine: 'webspeech' });
    world.say = 'ortllama: ready (k)\nplatform: unavailable (x)\n';
    assert.equal(
      (await sh('say --engine platform hi')).stderr,
      'say: no speech engine available\n  platform: unavailable (x)\n'
    );
  });

  it('prints each line with -i, as the page streams them', async () => {
    assert.deepEqual(await sh("printf 'one\\ntwo\\n' | say -i"), {
      status: 0,
      stdout: 'one\ntwo\n',
      stderr: '',
    });
    assert.deepEqual(requests()[0][1], { engine: 'kokoro', interactive: true });
    await sh('say --interactive=bg hi');
    assert.deepEqual(requests()[0][1], { engine: 'kokoro', interactive: true });
  });

  it('writes a file with -o, by extension or --file-format, and only through Kokoro', async () => {
    const cases = [
      [
        '-o /tmp/a.wav',
        '/tmp/a.wav',
        { format: 'WAVE', endian: 'LE', kind: 'I', bits: 16, channels: 1 },
      ],
      [
        '--out=/tmp/a.AIF',
        '/tmp/a.AIF',
        { format: 'AIFF', endian: 'BE', kind: 'I', bits: 16, channels: 1 },
      ],
      [
        '--output-file /tmp/a.aiff --channels=2',
        '/tmp/a.aiff',
        { format: 'AIFF', endian: 'BE', kind: 'I', bits: 16, channels: 2 },
      ],
      [
        '-o /tmp/a.caf --data-format=LEF32@22050',
        '/tmp/a.caf',
        { format: 'caff', endian: 'LE', kind: 'F', bits: 32, channels: 1, rate: 22050 },
      ],
      [
        '-o /tmp/plain',
        '/tmp/plain.aiff',
        { format: 'AIFF', endian: 'BE', kind: 'I', bits: 16, channels: 1 },
      ],
      [
        '-o /tmp/b.aiff --file-format=wave --data-format=I8',
        '/tmp/b.aiff',
        { format: 'WAVE', endian: 'LE', kind: 'UI', bits: 8, channels: 1 },
      ],
      [
        '-o /tmp/c --file-format=CAFF --data-format=F64@48000',
        '/tmp/c',
        { format: 'caff', endian: 'BE', kind: 'F', bits: 64, channels: 1, rate: 48000 },
      ],
      [
        '-o /tmp/d.wav --data-format=UI8',
        '/tmp/d.wav',
        { format: 'WAVE', endian: 'LE', kind: 'UI', bits: 8, channels: 1 },
      ],
    ];
    for (const [args, path, output] of cases) {
      assert.deepEqual(
        await sh(`say ${args} -i hello && cat ${path}`),
        { status: 0, stdout: 'AUDIO', stderr: '' },
        args
      );
      assert.deepEqual(requests(), [['audio.say', { engine: 'kokoro', output }, 'hello']], args);
    }
    assert.deepEqual(await sh('say -o - --data-format=LEI24 --file-format=AIFF hi'), {
      status: 0,
      stdout: 'AUDIO',
      stderr: '',
    });
    assert.deepEqual(requests()[0][1].output, {
      format: 'WAVE',
      endian: 'LE',
      kind: 'I',
      bits: 24,
      channels: 1,
    });
    assert.deepEqual(await sh('say -o /nowhere/x.wav hi'), {
      status: 1,
      stdout: '',
      stderr: 'say: cannot write /nowhere/x.wav\n',
    });
    world.say = 'ortllama: not cached (hf download k)\nplatform: ready (Web Speech, 2 voices)\n';
    assert.deepEqual(await sh('say -o /tmp/e.wav hi; test -e /tmp/e.wav'), {
      status: 1,
      stdout: '',
      stderr: 'say: no speech engine available\n  ortllama: not cached (hf download k)\n',
    });
  });

  it('keeps an existing file, and leaves no partial one, when the page fails', async () => {
    world.fail = { error: named('Error', 'ortllama: model not cached') };
    assert.deepEqual(
      await sh(
        'printf OLD > /tmp/prev.wav; say -o /tmp/prev.wav secret; cat /tmp/prev.wav; for f in /tmp/.prev*; do test -e "$f" && echo left; done; true'
      ),
      { status: 0, stdout: 'OLD', stderr: 'say: ortllama: model not cached\n' }
    );
    world.fail = undefined;
    assert.deepEqual(await sh('say -o /tmp/prev.wav hi && cat /tmp/prev.wav'), {
      status: 0,
      stdout: 'AUDIO',
      stderr: '',
    });
    assert.deepEqual(await sh('cd /tmp && say -o here.wav hi && cat here.wav'), {
      status: 0,
      stdout: 'AUDIO',
      stderr: '',
    });
  });

  it('removes the file when the page fails', async () => {
    world.fail = { error: named('Error', 'ortllama: model not cached') };
    assert.deepEqual(await sh('say -o /tmp/f.wav secret; test -e /tmp/f.wav'), {
      status: 1,
      stdout: '',
      stderr: 'say: ortllama: model not cached\n',
    });
  });

  it('lists the formats', async () => {
    assert.deepEqual(await sh("say --file-format='?'"), {
      status: 0,
      stdout: 'WAVE  .wav\nAIFF  .aiff .aif\ncaff  .caf\n',
      stderr: '',
    });
    assert.equal(
      (await sh("say --data-format='?'")).stdout,
      'WAVE  LEUI8 LEI16 LEI24 LEI32 LEF32 LEF64\nAIFF  BEI8 BEI16 BEI24 BEI32\ncaff  LEI8 LEI16 LEI24 LEI32 LEF32 LEF64 BEI8 BEI16 BEI24 BEI32 BEF32 BEF64\n'
    );
    assert.equal(
      (await sh("say --file-format=AIFF --data-format='?'")).stdout,
      'AIFF  BEI8 BEI16 BEI24 BEI32\n'
    );
    assert.equal(
      (await sh("say --file-format=wave --data-format='?'")).stdout,
      'WAVE  LEUI8 LEI16 LEI24 LEI32 LEF32 LEF64\n'
    );
    assert.equal(
      (await sh("say --file-format=caff --data-format='?'")).stdout.slice(0, 10),
      'caff  LEI8'
    );
    assert.deepEqual(page.calls, []);
  });

  it("lists the voices with -v '?' and --list", async () => {
    assert.deepEqual(await sh("say -v '?'"), {
      status: 0,
      stdout:
        'af_heart            en_US    # Hello, my name is af_heart.\nbf_emma             en_GB    # Hello, my name is bf_emma.\n',
      stderr: '',
    });
    assert.deepEqual(requests(), [['audio.voices', { engine: 'kokoro' }, '']]);
    assert.equal(
      (await sh('say --list --model m')).stdout,
      'af_heart (en-US) [kokoro] [default]\nbf_emma (en-GB) [kokoro]\n'
    );
    assert.deepEqual(requests(), [['audio.voices', { engine: 'kokoro', model: 'm' }, '']]);
    assert.equal(
      (await sh('say --list --engine=platform')).stdout,
      'Google US English (en-US) [web speech] [default]\n'
    );
    world.voices.kokoro = 'odd\tx\t0\n\n';
    assert.equal((await sh('say --list')).stdout, 'odd (x) [kokoro]\n');
  });

  it('prints the status of the engines', async () => {
    assert.deepEqual(await sh('say --status'), { status: 0, stdout: SAY_READY, stderr: '' });
    assert.equal(
      (await sh('say --status --engine=ortllama')).stdout,
      SAY_READY.split('\n')[0] + '\n'
    );
  });

  it('warms Kokoro up, running hf when it is on PATH', async () => {
    assert.deepEqual(await sh('say --warmup'), {
      status: 0,
      stdout: 'ortllama: ready (onnx-community/Kokoro-82M-v1.0-ONNX)\n',
      stderr: '',
    });
    assert.deepEqual(await sh('say --warmup --engine=platform'), {
      status: 0,
      stdout: '',
      stderr: '',
    });
    world.warm = "hf download k --include 'voices/*'\nhf\ndownload\nk\n--include\nvoices/*\n";
    assert.deepEqual(await sh('say --warmup'), {
      status: 1,
      stdout: '',
      stderr: "say: hf not found; run: hf download k --include 'voices/*'\n",
    });
    world.warm = 'touch /tmp/pwned x\ntouch\n/tmp/pwned\nx\n';
    assert.deepEqual(await sh('say --warmup; echo $?; test -e /tmp/pwned && echo ran; true'), {
      status: 0,
      stdout: '1\n',
      stderr: 'say: ortllama: touch /tmp/pwned x\n',
    });
    world.warm = 'hf login\nhf\nlogin\n';
    assert.equal((await sh('hear --warmup')).stderr, 'hear: ortllama: hf login\n');
    world.warm = "hf download k --include 'voices/*'\nhf\ndownload\nk\n--include\nvoices/*\n";
    const fake =
      'mkdir -p /usr/local/bin && printf \'#!/bin/sh\\nfor a; do echo "[$a]"; done\\nexit $HF_EXIT\\n\' > /usr/local/bin/hf && chmod +x /usr/local/bin/hf';
    assert.equal((await sh(fake)).status, 0);
    try {
      assert.deepEqual(await sh('HF_EXIT=0 say --warmup'), {
        status: 0,
        stdout: '',
        stderr: '[download]\n[k]\n[--include]\n[voices/*]\n',
      });
      assert.equal((await sh('HF_EXIT=3 hear --warmup --model w')).status, 1);
      assert.deepEqual(page.calls[0].options, { warmup: true, model: 'w' });
    } finally {
      await sh('rm /usr/local/bin/hf');
    }
  });

  it('adds the hint when the voice is not there, and never shows the text', async () => {
    world.fail = { error: named('NotFoundError', 'voice "zed" not found') };
    assert.deepEqual(await sh('say -v zed my secret text'), {
      status: 1,
      stdout: '',
      stderr: `say: voice "zed" not found (say -v '?' lists them)\n`,
    });
    assert.equal(
      (await sh('scsay -v zed hi')).stderr,
      `scsay: voice "zed" not found (scsay -v '?' lists them)\n`
    );
  });
});

describe('hear', () => {
  it('transcribes a file through Whisper', async () => {
    for (const flag of ['-i', '--input', '--file']) {
      assert.deepEqual(await sh(`hear ${flag} /tmp/clip.wav`), {
        status: 0,
        stdout: 'hello world\n',
        stderr: '',
      });
      assert.deepEqual(requests(), [
        ['audio.transcribe', { engine: 'whisper', format: 'text' }, 'RIFFdata'],
      ]);
    }
    assert.deepEqual(page.calls[0].options, { status: true });
    assert.equal(
      (await sh('cat /tmp/clip.wav | hear -i - -l de-at --locale DE --model m -p')).stdout,
      'hello world\n'
    );
    assert.deepEqual(requests(), [
      [
        'audio.transcribe',
        { engine: 'whisper', language: 'de', model: 'm', format: 'text' },
        'RIFFdata',
      ],
    ]);
    await sh('hear -i /tmp/clip.wav --timestamps');
    assert.equal(requests()[0][1].format, 'timestamps');
    world.transcripts = ['1\n00:00:00,000 --> 00:00:01,000\nHi.\n\n'];
    assert.equal(
      (await sh('hear -i /tmp/clip.wav -S')).stdout,
      '1\n00:00:00,000 --> 00:00:01,000\nHi.\n\n'
    );
    assert.equal(requests()[0][1].format, 'srt');
    world.transcripts = ['\n  \n'];
    assert.deepEqual(await sh('hear --subtitle -i /tmp/clip.wav'), {
      status: 1,
      stdout: '',
      stderr: 'hear: no speech detected\n',
    });
  });

  it('joins lines with -m and stops at the -x word', async () => {
    world.transcripts = ['  one  \n\ntwo\nthree, Over!\nfour\n'];
    assert.equal((await sh('hear -i /tmp/clip.wav -m')).stdout, 'one two three, Over! four\n');
    assert.equal(
      (await sh('hear -i /tmp/clip.wav --exit over')).stdout,
      'one\ntwo\nthree, Over!\n'
    );
    assert.equal((await sh('hear -i /tmp/clip.wav -m -x OVER.')).stdout, 'one two three, Over!\n');
    world.transcripts = ['no newline'];
    assert.equal((await sh('hear -i /tmp/clip.wav')).stdout, 'no newline\n');
  });

  it('fails without speech, a file or Whisper', async () => {
    world.transcripts = [''];
    assert.deepEqual(await sh('hear -i /tmp/clip.wav'), {
      status: 1,
      stdout: '',
      stderr: 'hear: no speech detected\n',
    });
    assert.deepEqual(await sh('hear -i /tmp/none.wav'), {
      status: 1,
      stdout: '',
      stderr: 'hear: cannot open /tmp/none.wav: No such file\n',
    });
    assert.deepEqual(await sh('hear -i /tmp/clip.wav --engine builtin'), {
      status: 1,
      stdout: '',
      stderr: "hear: Web Speech can't transcribe a file (-i needs --engine ortllama)\n",
    });
    world.hear = 'ortllama: not cached (hf download w)\nplatform: ready (Web Speech)\n';
    assert.deepEqual(await sh('hear -i /tmp/clip.wav'), {
      status: 1,
      stdout: '',
      stderr: 'hear: no recognition engine available\n  ortllama: not cached (hf download w)\n',
    });
  });

  it('records the microphone and transcribes the recording', async () => {
    assert.deepEqual(await sh('hear -l en_us -d usb'), {
      status: 0,
      stdout: 'hello world\n',
      stderr: '',
    });
    assert.deepEqual(requests(), [
      ['audio.record', { seconds: 30, pause: true, device: 'usb' }, ''],
      ['audio.transcribe', { engine: 'whisper', language: 'en-US', format: 'text' }, 'REC'],
    ]);
    for (const args of ['-T 2.5', '-t 2.5', '--timeout=2.5', '--timeout 2.5']) {
      await sh(`hear ${args} -n mic1`);
      assert.deepEqual(requests()[0][1], { seconds: 2.5, pause: true, device: 'mic1' }, args);
    }
    await sh('hear --input-device-id=x --engine=enhanced');
    assert.equal(requests()[0][1].device, 'x');
  });

  it('keeps listening across pauses with -x, one line per pause, until the word', async () => {
    world.transcripts = ['first\n', '\n', 'second line\n', 'and stop\n', 'never\n'];
    assert.deepEqual(await sh('hear -x STOP -T 600'), {
      status: 0,
      stdout: 'first\nsecond line\nand stop\n',
      stderr: '',
    });
    const asked = requests();
    assert.deepEqual(
      asked.map(([kind]) => kind),
      [
        'audio.record',
        'audio.transcribe',
        'audio.record',
        'audio.transcribe',
        'audio.record',
        'audio.transcribe',
        'audio.record',
        'audio.transcribe',
      ]
    );
    assert.equal(asked[0][1].seconds, 600);
    for (const [, options] of asked.filter(([kind]) => kind === 'audio.record')) {
      assert.ok(options.seconds >= 590 && options.seconds <= 600, String(options.seconds));
    }
    world.transcripts = ['a\n', 'b\n'];
    const answer = page.answer;
    page.answer = async (call) => {
      if (call.kind === 'audio.record') await new Promise((resolve) => setTimeout(resolve, 700));
      return answer(call);
    };
    try {
      const timed = await sh('hear -x stop -T 1');
      assert.equal(timed.status, 0);
      assert.match(timed.stdout, /^a\n(b\n)*$/);
    } finally {
      page.answer = answer;
    }
  });

  it('falls back to Web Speech on the microphone, unless --device', async () => {
    world.hear =
      'ortllama: no server at http://11435.kernel.localhost (x)\nplatform: ready (Web Speech)\n';
    assert.deepEqual(await sh('hear -l fr -T 9 -x fin -m'), {
      status: 0,
      stdout: 'hello world\n',
      stderr: '',
    });
    assert.deepEqual(requests(), [
      [
        'audio.transcribe',
        { engine: 'webspeech', seconds: 9, language: 'fr', continuous: true, exit: 'fin' },
        '',
      ],
    ]);
    await sh('hear');
    assert.deepEqual(requests(), [['audio.transcribe', { engine: 'webspeech', seconds: 30 }, '']]);
    world.transcripts = [''];
    assert.deepEqual(await sh('hear'), {
      status: 1,
      stdout: '',
      stderr: 'hear: no speech detected\n',
    });
    assert.deepEqual(await sh('hear --device'), {
      status: 1,
      stdout: '',
      stderr:
        'hear: no recognition engine available\n  ortllama: no server at http://11435.kernel.localhost (x)\n',
    });
    assert.deepEqual(await sh('hear --device --engine=platform'), {
      status: 1,
      stdout: '',
      stderr: 'hear: no recognition engine available\n',
    });
  });

  it('lists devices and languages, and prints the status', async () => {
    assert.deepEqual(await sh('hear -a'), {
      status: 0,
      stdout: 'default\tDefault\nusb\tUSB Mic\n',
      stderr: '',
    });
    assert.deepEqual(page.calls[0].options, { devices: true });
    for (const flag of ['--audio-input-devices', '--devices'])
      assert.equal((await sh(`hear ${flag}`)).status, 0);
    assert.equal((await sh('hear -s')).stdout, 'en\nde\n');
    assert.deepEqual(page.calls[0].options, { supported: true, engine: 'whisper' });
    assert.equal((await sh('hear --supported --engine platform')).stdout, 'en-US\n');
    assert.equal((await sh('hear --status')).stdout, HEAR_READY);
    assert.equal((await sh('hear --status --device')).stdout, HEAR_READY.split('\n')[0] + '\n');
    assert.equal(
      (await sh('hear --status --engine builtin')).stdout,
      'platform: ready (Web Speech)\n'
    );
    assert.equal((await sh('hear --warmup --engine platform')).status, 0);
    world.warm = 'ortllama: ready (onnx-community/whisper-tiny)\n';
    assert.equal((await sh('hear --warmup')).stdout, world.warm);
  });

  it('refuses bad arguments with exit 2', async () => {
    for (const [script, message] of [
      ['hear -T 0', '-T 0: more than 0 and at most 600'],
      ['hear -t 601', '-T 601: more than 0 and at most 600'],
      ['hear --timeout=x', '-T x: more than 0 and at most 600'],
      ['hear --timestamps', '--timestamps needs -i file'],
      ['hear -S', '-S needs -i file'],
      ['hear -i x --timestamps -S', '--timestamps and -S are exclusive'],
      ['hear --engine=ollama', '--engine ollama: one of ortllama, platform'],
      ['hear words', 'unexpected argument: words'],
      ['hear -q', 'unknown option: -q'],
      ['hear -i', '-i needs a value'],
      ['hear -m=1', 'unknown option: -m=1'],
      ['hear --mode=1', '--mode takes no value'],
      ['hear -l 12', '-l 12: not a language tag'],
    ]) {
      assert.deepEqual(
        await sh(script),
        { status: 2, stdout: '', stderr: `hear: ${message}\n${HEAR_USAGE('hear')}` },
        script
      );
    }
  });
});

describe('afplay and chime', () => {
  it('plays a file, with every option, in any order', async () => {
    assert.deepEqual(await sh('afplay /tmp/clip.wav'), { status: 0, stdout: '', stderr: '' });
    assert.deepEqual(requests(), [['audio.play', {}, 'RIFFdata']]);
    await sh('afplay -v 0.25 /tmp/clip.wav -t 1.5 -r .5 -q 1');
    assert.deepEqual(requests()[0][1], { volume: 0.25, rate: 0.5, time: 1.5, quality: 1 });
    await sh('scplay --volume=1 --time 86400 --rate=4 --rQuality=0 /tmp/clip.wav');
    assert.deepEqual(requests()[0][1], { volume: 1, rate: 4, time: 86400, quality: 0 });
    assert.deepEqual(await sh('afplay -d /tmp/clip.wav'), {
      status: 0,
      stdout: '',
      stderr: 'wav, 44100 Hz, 1 channel, 0.450 s\n',
    });
    assert.deepEqual(requests()[0][1], { debug: true });
    await sh('afplay --debug -v 0 /tmp/clip.wav');
    assert.deepEqual(requests()[0][1], { volume: 0, debug: true });
  });

  it('streams a body larger than the request window', async () => {
    assert.equal((await sh('afplay /tmp/big.wav')).status, 0);
    assert.equal(page.calls[0].body.length, 3145728);
  });

  it('refuses bad arguments with exit 2', async () => {
    for (const [script, message] of [
      ['afplay', 'no file'],
      ['afplay a b', 'only one file'],
      ['afplay -v 1.5 x', '-v 1.5: from 0 to 1'],
      ['afplay -v -1 x', '-v -1: from 0 to 1'],
      ['afplay -t 0 x', '-t 0: more than 0 and at most 86400'],
      ['afplay -t 86401 x', '-t 86401: more than 0 and at most 86400'],
      ['afplay -r 0.2 x', '-r 0.2: from 0.25 to 4'],
      ['afplay -r 4.5 x', '-r 4.5: from 0.25 to 4'],
      ['afplay -q 2 x', '-q 2: 0 or 1'],
      ['afplay --leaks x', "--leaks (leaks analysis) isn't supported in SLICC"],
      ['afplay -z x', 'unknown option: -z'],
      ['afplay -d=1 x', 'unknown option: -d=1'],
      ['afplay --debug=1 x', '--debug takes no value'],
      ['afplay x -v', '-v needs a value'],
    ]) {
      assert.deepEqual(
        await sh(script),
        { status: 2, stdout: '', stderr: `afplay: ${message}\n${PLAY_USAGE('afplay')}` },
        script
      );
    }
    assert.deepEqual(await sh('afplay /tmp/none.mp3'), {
      status: 1,
      stdout: '',
      stderr: 'afplay: cannot open /tmp/none.mp3: No such file\n',
    });
    assert.deepEqual(page.calls, []);
  });

  it('names the file the browser cannot decode', async () => {
    world.fail = { error: new Error('cannot decode audio') };
    assert.deepEqual(await sh('afplay /tmp/clip.wav'), {
      status: 1,
      stdout: '',
      stderr: 'afplay: /tmp/clip.wav: cannot decode audio\n',
    });
  });

  it('plays the chime the page makes', async () => {
    assert.deepEqual(await sh('chime'), { status: 0, stdout: '', stderr: '' });
    assert.deepEqual(requests(), [['audio.play', { sound: 'chime' }, '']]);
    for (const [script, message] of [
      ['chime now', 'unexpected argument: now'],
      ['scchime -v', 'unknown option: -v'],
      ['chime --version 1', '--version takes no other arguments'],
    ]) {
      const me = script.split(' ')[0];
      assert.deepEqual(await sh(script), {
        status: 2,
        stdout: '',
        stderr: `${me}: ${message}\nusage: ${me}\n`,
      });
    }
  });
});

describe('errors from /dev/embedder', () => {
  it('maps each errno to exit 1 with the page message', async () => {
    for (const [name, message] of [
      ['NotAllowedError', "needs a click in seven's page"],
      ['AbortError', 'microphone permission denied'],
      ['NotSupportedError', 'no speechSynthesis in this browser'],
      ['NotFoundError', 'no microphone'],
      ['TypeError', 'something broke'],
    ]) {
      world.fail = { error: named(name, `${message}\nsecond line`) };
      for (const script of [
        'afplay /tmp/clip.wav',
        'chime',
        'say secret',
        'hear',
        'hear -i /tmp/clip.wav',
        'say --list',
      ]) {
        const me = script.split(' ')[0];
        assert.deepEqual(
          await sh(script),
          { status: 1, stdout: '', stderr: `${me}: ${message}\n` },
          `${name} ${script}`
        );
      }
    }
  });

  it('fails a big body when the page refuses it part way', async () => {
    world.fail = { error: named('Error', 'the request is larger than 64 MiB') };
    assert.deepEqual(await sh('afplay /tmp/big.wav'), {
      status: 1,
      stdout: '',
      stderr: 'afplay: the request is larger than 64 MiB\n',
    });
  });

  it('says when the page does not answer a kind, or answers nothing', async () => {
    const narrow = fakePage(['audio.say']);
    narrow.answer = page.answer;
    const other = await boot({ requests: narrow });
    const bare = await boot();
    try {
      await other.sh("printf 'x' > /tmp/x.wav");
      assert.deepEqual(await other.sh('afplay /tmp/x.wav'), {
        status: 1,
        stdout: '',
        stderr: 'afplay: this embedder does not answer audio.play\n',
      });
      assert.deepEqual(await bare.sh('chime'), {
        status: 1,
        stdout: '',
        stderr: 'chime: no page answers requests for this session\n',
      });
    } finally {
      await other.close();
      await bare.close();
    }
  });

  it('cancels the request on a signal or a timeout, and leaves no scratch files', async () => {
    world.hang = true;
    const settled = async () => {
      for (let i = 0; i < 100 && !world.aborted; i++) await new Promise((r) => setTimeout(r, 20));
      return world.aborted;
    };
    for (const script of [
      'timeout 3 afplay /tmp/clip.wav',
      'timeout 3 say hi',
      'timeout 3 hear',
      'timeout 3 hear -i /tmp/clip.wav',
    ]) {
      world.aborted = undefined;
      const result = await sh(`${script}; echo $?; ls -d /tmp/tmp.* 2>/dev/null | wc -l`);
      assert.equal(result.stdout, '124\n0\n', script);
      assert.ok(['closed', 'interrupted'].includes(await settled()), `${script}: ${world.aborted}`);
    }
    for (const [signal, code] of [
      ['TERM', 143],
      ['HUP', 129],
    ]) {
      world.aborted = undefined;
      const result = await sh(`chime & p=$!; sleep 2; kill -${signal} $p; wait $p; echo $?`);
      assert.equal(result.stdout, `${code}\n`);
      assert.equal(await settled(), 'interrupted');
    }
    world.aborted = undefined;
    const record = await sh('hear --engine ortllama & p=$!; sleep 2; kill $p; wait $p; echo $?');
    assert.equal(record.stdout, '143\n');
    assert.ok(await settled());
  });
});

describe('on an older kernel', () => {
  it('refuses the commands where the kernel checks engines.slicc-kernel', async () => {
    const old = await bootOld();
    try {
      for (const name of NAMES) {
        const result = await old.sh(`${name} hi`);
        assert.equal(result.status, 126, name);
        assert.match(result.stderr, /needs slicc-kernel >=1\.153\.0; this kernel is 1\.152\./);
      }
    } finally {
      await old.close();
    }
  });

  it('fails every request without /dev/embedder, when the kernel lets it run', async () => {
    const manifest = { ...pkg, engines: { node: '>=24' } };
    const old = await bootOld({}, manifest);
    try {
      for (const script of [
        'say hi',
        'hear',
        'hear -i x',
        'afplay x',
        'chime',
        'scsay --status',
        'hear -a',
      ]) {
        const me = script.split(' ')[0];
        assert.deepEqual(
          await old.sh(script),
          {
            status: 1,
            stdout: '',
            stderr: `${me}: no audio in this kernel (needs slicc-kernel >= 1.153.0, for /dev/embedder)\n`,
          },
          script
        );
      }
      assert.equal((await old.sh('test -e /dev/embedder')).status, 1);
      assert.equal((await old.sh('say -h')).status, 0);
      assert.equal((await old.sh('chime --version')).stdout, `${pkg.version}\n`);
    } finally {
      await old.close();
    }
  });
});

describe('next to npm bins', () => {
  it('runs the sh sc* commands, not the host scripts in bin', async () => {
    const at = '/opt/tool/node_modules';
    const tool = await boot({ requests: page, commands: { append: [at] } }, { at });
    try {
      const where = await tool.sh('command -v scsay schear scplay scchime say');
      assert.equal(
        where.stdout,
        '/usr/bin/scsay\n/usr/bin/schear\n/usr/bin/scplay\n/usr/bin/scchime\n/usr/bin/say\n'
      );
      for (const name of ['scsay', 'schear', 'scplay', 'scchime']) {
        assert.deepEqual(await tool.sh(`${name} --upgrade`), {
          status: 0,
          stdout: 'pnpm add -g @ai-ecoverse/slicc-audio@latest\n',
          stderr: '',
        });
      }
      page.calls = [];
      assert.equal((await tool.sh('scchime')).status, 0);
      assert.deepEqual(
        page.calls.map((c) => c.options),
        [{ sound: 'chime' }]
      );
    } finally {
      await tool.close();
    }
  });
});
