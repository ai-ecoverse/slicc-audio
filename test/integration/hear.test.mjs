import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { beforeEach, describe, it } from 'node:test';
import { schear } from '../../host/hear.mjs';
import {
  existsSync,
  fakeServer,
  missingModule,
  onWindows,
  posix,
  readFileSync,
  run,
  temp,
  tone,
  writeFileSync,
} from './fakes.mjs';

const USAGE =
  'usage: schear [-i file] [-l lang] [-T seconds] [-d device] [-x word] [-m] [-p] [--timestamps | -S] [--device]\n       schear -a | -s | --status | --warmup\n';
const whisper = ['ffmpeg', 'whisper-cli'];
const model = Buffer.from('ggml model bytes');

const server = await fakeServer();
beforeEach(() => server.reset());

function clip() {
  const file = join(temp('clip'), 'clip.m4a');
  writeFileSync(file, tone());
  return file;
}

function cached(name = 'base') {
  const cache = temp('cache');
  writeFileSync(join(cache, `ggml-${name}.bin`), model);
  return cache;
}

const hf = () => ({ HF_ENDPOINT: `${server.url}/hf` });
const ollama = () => ({ OLLAMA_HOST: `${server.url}/ollama` });

describe('schear with whisper.cpp', posix, () => {
  it('converts the file with ffmpeg and transcribes it with whisper-cli', async () => {
    const file = clip();
    const cache = cached();
    const r = await run(schear, {
      argv: ['-i', file, '-l', 'en-US', '-p'],
      names: whisper,
      env: { SLICC_AUDIO_CACHE: cache, FAKE_TRANSCRIPT: 'hello|world' },
    });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, 'hello\nworld\n');
    const [ffmpeg, cli] = r.calls;
    const tmp = ffmpeg.args.at(-1);
    assert.deepEqual(ffmpeg.args, [
      '-nostdin',
      '-loglevel',
      'error',
      '-i',
      file,
      '-ar',
      '16000',
      '-ac',
      '1',
      '-c:a',
      'pcm_s16le',
      '-f',
      'wav',
      tmp,
    ]);
    assert.deepEqual(cli.args, [
      '-m',
      join(cache, 'ggml-base.bin'),
      '-f',
      tmp,
      '-l',
      'en',
      '-np',
      '-nt',
    ]);
    assert.ok(!existsSync(tmp));
  });

  it('joins lines with -m, keeps timestamps, writes SRT, and stops at the -x word', async () => {
    const file = clip();
    const env = { SLICC_AUDIO_CACHE: cached(), FAKE_TRANSCRIPT: 'one two|three, Over!|four' };
    let r = await run(schear, { argv: ['-i', file, '-m'], names: whisper, env });
    assert.equal(r.stdout, 'one two three, Over! four\n');
    assert.deepEqual(r.calls[1].args.slice(4), ['-l', 'auto', '-np', '-nt']);
    r = await run(schear, { argv: ['-i', file, '--timestamps'], names: whisper, env });
    assert.equal(
      r.stdout,
      '[00:00:00.000 --> 00:00:01.000] one two\n[00:00:01.000 --> 00:00:02.000] three, Over!\n[00:00:02.000 --> 00:00:03.000] four\n'
    );
    assert.deepEqual(r.calls[1].args.slice(6), ['-np']);
    r = await run(schear, { argv: ['--file', file, '-S'], names: whisper, env });
    assert.equal(r.stdout, '1\n00:00:00,000 --> 00:00:01,000\nhello world\n');
    assert.deepEqual(r.calls[1].args.slice(6), ['-np', '-nt', '-osrt']);
    r = await run(schear, { argv: ['-i', file, '-x', 'over'], names: whisper, env });
    assert.equal(r.stdout, 'one two\nthree, Over!\n');
    r = await run(schear, { argv: ['-i', '-'], names: whisper, env, stdin: 'audio' });
    assert.equal(r.code, 0);
    assert.match(r.calls[0].args[4], /stdin$/);
    r = await run(schear, {
      argv: ['-i', file],
      names: ['ffmpeg', 'whisper-cpp'],
      env: { ...env, FAKE_TRANSCRIPT: '' },
    });
    assert.deepEqual([r.code, r.stderr], [1, 'schear: no speech detected\n']);
    r = await run(schear, {
      argv: ['-i', file],
      names: whisper,
      env: { ...env, FAKE_FAIL_whisper_cli: 'bad model' },
    });
    assert.deepEqual([r.code, r.stderr], [1, 'schear: bad model\n']);
    r = await run(schear, {
      argv: ['-i', file],
      names: whisper,
      env: { ...env, FAKE_FAIL_ffmpeg: 'cannot decode' },
    });
    assert.deepEqual([r.code, r.stderr], [1, 'schear: cannot decode\n']);
  });

  it('downloads a named model once, checked against the hub, and takes a path', async () => {
    const file = clip();
    const cache = temp('cache');
    server.models.hf = { 'ggml-tiny.bin': { data: model } };
    let r = await run(schear, {
      argv: ['-i', file, '--model', 'tiny'],
      names: whisper,
      env: { ...hf(), SLICC_AUDIO_CACHE: cache },
    });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /schear: downloading ggml-tiny\.bin: 100%\n/);
    assert.deepEqual(readFileSync(join(cache, 'ggml-tiny.bin')), model);
    assert.equal(r.calls[1].args[1], join(cache, 'ggml-tiny.bin'));
    server.requests = [];
    r = await run(schear, {
      argv: ['-i', file],
      names: whisper,
      env: { ...hf(), SLICC_AUDIO_CACHE: cache, SLICC_AUDIO_MODEL: 'tiny' },
    });
    assert.deepEqual([r.code, server.requests], [0, []]);
    server.models.hf = {
      'ggml-base.bin': { data: model, etag: createHash('sha256').update('other').digest('hex') },
    };
    r = await run(schear, {
      argv: ['-i', file],
      names: whisper,
      env: { ...hf(), SLICC_AUDIO_CACHE: cache },
    });
    assert.equal(r.code, 1);
    assert.match(
      r.stderr,
      /schear: ggml-base\.bin: SHA-256 [0-9a-f]{64} doesn't match the hub's [0-9a-f]{64}\n$/
    );
    assert.ok(!existsSync(join(cache, 'ggml-base.bin')));
    assert.ok(!existsSync(join(cache, 'ggml-base.bin.part')));
    assert.deepEqual(r.calls, []);
    r = await run(schear, {
      argv: ['-i', file, '--model', 'small'],
      names: whisper,
      env: { ...hf(), SLICC_AUDIO_CACHE: cache },
    });
    assert.deepEqual(
      [r.code, r.stderr],
      [
        1,
        `schear: cannot download ${server.url}/hf/ggerganov/whisper.cpp/resolve/main/ggml-small.bin: HTTP 404\n`,
      ]
    );
    r = await run(schear, {
      argv: ['-i', file, '--model', 'small'],
      names: whisper,
      env: { SLICC_AUDIO_CACHE: cache },
    });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /^schear: cannot download http:\/\/127\.0\.0\.1:9\/.*: /);
    server.models.hf = { 'ggml-base.bin': { data: model, cut: 4 } };
    r = await run(schear, {
      argv: ['-i', file],
      names: whisper,
      env: { ...hf(), SLICC_AUDIO_CACHE: cache },
    });
    assert.deepEqual(
      [r.code, r.stderr],
      [
        1,
        `schear: cannot download ${server.url}/hf/ggerganov/whisper.cpp/resolve/main/ggml-base.bin: other side closed\n`,
      ]
    );
    assert.ok(!existsSync(join(cache, 'ggml-base.bin')));
    assert.ok(!existsSync(join(cache, 'ggml-base.bin.part')));
    assert.deepEqual(r.calls, []);
    const own = join(temp('own'), 'mine.bin');
    writeFileSync(own, model);
    r = await run(schear, { argv: ['-i', file, '--model', own], names: whisper });
    assert.equal(r.calls[1].args[1], own);
    r = await run(schear, { argv: ['-i', file, '--model', '/no/model.bin'], names: whisper });
    assert.deepEqual([r.code, r.stderr], [1, 'schear: cannot open /no/model.bin: No such file\n']);
    r = await run(schear, { argv: ['-i', file, '--model', '..'], names: whisper });
    assert.deepEqual([r.code, r.stderr], [1, 'schear: --model ..: not a whisper.cpp model name\n']);
  });
});

describe('schear engines', () => {
  it('falls back to slicc-ortllama and then to an OpenAI-compatible server', posix, async () => {
    const file = clip();
    server.models.ortllama = ['transcribe'];
    let r = await run(schear, {
      argv: ['-i', file, '-l', 'fr'],
      names: ['ffmpeg'],
      ortllama: server.ortllama,
    });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, 'hello from the server\n');
    assert.deepEqual(server.started, [{ port: 0, host: '127.0.0.1' }]);
    assert.equal(server.closed, 1);
    const post = server.requests.find((q) => q.route === '/v1/audio/transcriptions');
    assert.deepEqual(post.body, {
      file: { filename: 'clip.m4a', size: tone().length },
      language: 'fr',
      response_format: 'json',
    });
    r = await run(schear, {
      argv: ['-i', file, '--timestamps'],
      names: [],
      ortllama: server.ortllama,
    });
    assert.equal(
      r.stdout,
      '[00:00:00.000 --> 00:00:01.200] hello\n[00:00:01.200 --> 00:00:03.000] world.\n'
    );
    r = await run(schear, { argv: ['-i', file, '-S'], names: [], ortllama: server.ortllama });
    assert.equal(r.stdout, '1\n00:00:00,000 --> 00:00:01,500\nhello\n');
    server.reset();
    server.models.ollama = ['whisper-large'];
    r = await run(schear, {
      argv: ['-i', file, '--model', 'whisper-large'],
      names: [],
      ortllama: missingModule,
      env: ollama(),
    });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(
      server.requests.map((q) => [q.tier, q.route, q.body?.model]),
      [
        ['ollama', '/v1/models', undefined],
        ['ollama', '/v1/audio/transcriptions', 'whisper-large'],
      ]
    );
  });

  it('lists every engine, with its hint, when none is available', posix, async () => {
    const file = clip();
    let r = await run(schear, { argv: ['-i', file], names: [], ortllama: server.ortllama });
    assert.equal(r.code, 1);
    assert.equal(
      r.stderr,
      [
        'schear: no recognition engine available',
        "  whisper: whisper-cli not found (your distribution's whisper-cpp package, or a build from github.com/ggml-org/whisper.cpp, and ffmpeg)",
        "  ortllama: model not cached (hf download onnx-community/whisper-tiny --include '*.json')",
        '  ollama: needs --model, a transcription model on a server at http://127.0.0.1:9 with /v1/audio/transcriptions',
        '',
      ].join('\n')
    );
    r = await run(schear, {
      platform: 'darwin',
      argv: ['-i', file, '--model', 'm'],
      names: ['ffmpeg'],
      ortllama: missingModule,
    });
    assert.match(
      r.stderr,
      /^schear: no recognition engine available\n {2}whisper: whisper-cli not found \(brew install whisper-cpp\)\n {2}ortllama: @ai-ecoverse\/slicc-ortllama not installed .*\n {2}ollama: no server at http:\/\/127\.0\.0\.1:9 \(install Ollama from https:\/\/ollama\.com, then ollama serve\)\n$/
    );
    r = await run(schear, {
      platform: 'darwin',
      argv: ['-i', file, '--engine', 'whisper'],
      names: [],
    });
    assert.equal(
      r.stderr,
      'schear: no recognition engine available\n  whisper: whisper-cli not found (brew install whisper-cpp ffmpeg)\n'
    );
    r = await run(schear, {
      platform: 'win32',
      argv: ['-i', file, '--engine', 'whisper'],
      names: ['whisper-cli.exe'],
    });
    assert.equal(
      r.stderr,
      'schear: no recognition engine available\n  whisper: ffmpeg not found (winget install Gyan.FFmpeg)\n'
    );
    r = await run(schear, {
      argv: ['-i', file],
      names: [],
      ortllama: missingModule,
      env: { ...ollama(), SLICC_AUDIO_MODEL: 'nope' },
    });
    assert.match(r.stderr, /\n {2}ollama: model not pulled \(ollama pull nope\)\n$/);
    server.models.ollama = ['speech-only'];
    r = await run(schear, {
      argv: ['-i', file, '--engine=ollama', '--model', 'speech-only'],
      env: { ...ollama(), OLLAMA_HOST: `${server.url}/ollama` },
    });
    server.answer['ollama /v1/audio/transcriptions'] = {
      status: 404,
      body: { error: { message: 'no route' } },
    };
    r = await run(schear, {
      argv: ['-i', file, '--engine=ollama', '--model', 'speech-only'],
      env: ollama(),
    });
    assert.equal(
      r.stderr,
      `schear: no recognition engine available\n  ollama: no /v1/audio/transcriptions for speech-only at ${server.url}/ollama\n`
    );
    r = await run(schear, {
      argv: ['-i', file, '--engine=ollama', '--model', 'speech-only', '--device'],
      env: { OLLAMA_HOST: 'gpu.example' },
    });
    assert.equal(
      r.stderr,
      "schear: no recognition engine available\n  ollama: http://gpu.example:11434 isn't on this device (--device)\n"
    );
  });

  it('falls through to the next engine when one answers 404, and fails on any other error', async () => {
    const file = clip();
    server.models = { ortllama: ['transcribe'], ollama: ['w'] };
    server.answer['ortllama /v1/audio/transcriptions'] = {
      status: 404,
      body: { error: { message: 'gone: hf download x/y' } },
    };
    let r = await run(schear, {
      argv: ['-i', file, '--model', 'w'],
      names: [],
      ortllama: server.ortllama,
      env: ollama(),
    });
    assert.deepEqual([r.code, r.stdout], [0, 'hello from the server\n']);
    server.requests = [];
    server.answer['ortllama /v1/audio/transcriptions'] = {
      status: 400,
      body: { error: { message: 'cannot decode clip.m4a' } },
    };
    r = await run(schear, {
      argv: ['-i', file],
      names: [],
      ortllama: server.ortllama,
      env: ollama(),
    });
    assert.deepEqual([r.code, r.stderr], [1, 'schear: cannot decode clip.m4a\n']);
    assert.ok(!server.requests.some((q) => q.tier === 'ollama' && q.route !== '/v1/models'));
  });

  it('uses --engine or SLICC_AUDIO_ENGINE, and checks its arguments', posix, async () => {
    const file = clip();
    server.models.ortllama = ['transcribe'];
    let r = await run(schear, {
      argv: ['-i', file],
      names: whisper,
      ortllama: server.ortllama,
      env: { SLICC_AUDIO_ENGINE: 'ortllama' },
    });
    assert.deepEqual([r.code, r.calls], [0, []]);
    r = await run(schear, {
      argv: ['-i', file, '--engine', 'whisper'],
      names: whisper,
      ortllama: server.ortllama,
      env: { SLICC_AUDIO_ENGINE: 'ortllama', SLICC_AUDIO_CACHE: cached() },
    });
    assert.deepEqual([r.code, r.calls.map((c) => c.name)], [0, whisper]);
    r = await run(schear, { argv: ['-i', '/no/clip.wav'], names: whisper });
    assert.deepEqual([r.code, r.stderr], [1, 'schear: cannot open /no/clip.wav: No such file\n']);
    for (const [argv, message] of [
      [['-T', '0'], '-T 0: more than 0 and at most 600'],
      [['-t', '601'], '-T 601: more than 0 and at most 600'],
      [['--timestamps'], '--timestamps needs -i file'],
      [['-S'], '-S needs -i file'],
      [['-i', file, '-S', '--timestamps'], '--timestamps and -S are exclusive'],
      [['--engine', 'enhanced'], '--engine enhanced: one of whisper, ortllama, ollama'],
      [['-l', '12'], '-l 12: not a language tag'],
      [['extra'], 'unexpected argument: extra'],
      [['-q'], 'unknown option: -q'],
    ]) {
      r = await run(schear, { argv, names: whisper });
      assert.deepEqual(
        [r.code, r.stderr, r.calls],
        [2, `schear: ${message}\n${USAGE}`, []],
        argv.join(' ')
      );
    }
    r = await run(schear, { argv: ['--help'] });
    assert.deepEqual([r.code, r.stdout], [0, USAGE]);
    r = await run(schear, { argv: ['-s'] });
    assert.ok(r.stdout.startsWith('en\nzh\nde\n'));
    assert.ok(r.stdout.endsWith('\nyue\n'));
  });
});

describe('schear and the microphone', () => {
  it('records with ffmpeg until the first pause after speech, per platform', async () => {
    const env = { SLICC_AUDIO_CACHE: cached(), FAKE_TRANSCRIPT: 'testing' };
    const tail = [
      '-af',
      'silencedetect=noise=-30dB:d=1',
      '-ar',
      '16000',
      '-ac',
      '1',
      '-c:a',
      'pcm_s16le',
      '-y',
    ];
    for (const [platform, extra, names, input] of [
      ['darwin', {}, whisper, ['-f', 'avfoundation', '-i', ':0']],
      ['darwin', { argv: ['-d', '1'] }, whisper, ['-f', 'avfoundation', '-i', ':1']],
      [
        'linux',
        { env: { FAKE_PULSE: '1' } },
        [...whisper, 'pactl'],
        ['-f', 'pulse', '-i', 'default'],
      ],
      ['linux', {}, [...whisper, 'pactl'], ['-f', 'alsa', '-i', 'default']],
      ['linux', { argv: ['-n', 'hw:1'] }, whisper, ['-f', 'alsa', '-i', 'hw:1']],
      [
        'win32',
        {},
        ['ffmpeg.exe', 'whisper-cli.exe'],
        ['-f', 'dshow', '-i', 'audio=Microphone (Realtek)'],
      ],
      [
        'win32',
        { argv: ['--input-device-id', 'Line In'] },
        ['ffmpeg.exe', 'whisper-cli.exe'],
        ['-f', 'dshow', '-i', 'audio=Line In'],
      ],
    ].filter(([platform]) => !onWindows || platform === 'win32')) {
      const r = await run(schear, {
        platform,
        argv: ['-T', '7', ...(extra.argv ?? [])],
        names,
        env: { ...env, ...extra.env },
      });
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.stdout, 'testing\n');
      const rec = r.calls.find((c) => c.args.includes('silencedetect=noise=-30dB:d=1'));
      assert.deepEqual(
        rec.args.slice(0, -1),
        ['-hide_banner', '-loglevel', 'info', ...input, '-t', '7', ...tail],
        platform
      );
      assert.equal(readFileSync(join(r.log, 'quit'), 'utf8'), 'q');
      assert.deepEqual(r.calls.at(-1).args.slice(0, 2), [
        '-m',
        join(env.SLICC_AUDIO_CACHE, 'ggml-base.bin'),
      ]);
      assert.equal(r.calls.at(-1).args[3], rec.args.at(-1));
    }
  });

  it(
    'keeps listening across pauses with -x, and says so when nothing was spoken',
    posix,
    async () => {
      const env = {
        SLICC_AUDIO_CACHE: cached(),
        FAKE_MIC: 'speech,speech,speech',
        FAKE_TRANSCRIPT: 'go on',
      };
      let r = await run(schear, {
        argv: ['-x', 'stop'],
        names: whisper,
        env: { ...env, FAKE_MIC: 'speech,silence' },
      });
      assert.deepEqual([r.code, r.stdout], [0, 'go on\n']);
      r = await run(schear, {
        argv: ['-x', 'stop', '-T', '30'],
        names: whisper,
        env: { ...env, FAKE_TRANSCRIPT: 'please stop.' },
      });
      assert.deepEqual([r.code, r.stdout], [0, 'please stop.\n']);
      assert.equal(r.calls.filter((c) => c.name === 'ffmpeg').length, 1);
      r = await run(schear, { names: whisper, env: { ...env, FAKE_MIC: 'silence' } });
      assert.deepEqual([r.code, r.stderr], [1, 'schear: no speech detected\n']);
      r = await run(schear, { names: ['whisper-cli'], env });
      assert.equal(
        r.stderr,
        [
          'schear: no recognition engine available',
          "  whisper: ffmpeg not found, which records the microphone (your distribution's ffmpeg package)",
          "  ortllama: ffmpeg not found, which records the microphone (your distribution's ffmpeg package)",
          "  ollama: ffmpeg not found, which records the microphone (your distribution's ffmpeg package)",
          '',
        ].join('\n')
      );
      server.models.ortllama = ['transcribe'];
      r = await run(schear, {
        names: ['ffmpeg'],
        ortllama: server.ortllama,
        env: { FAKE_MIC: 'speech' },
      });
      assert.deepEqual([r.code, r.stdout], [0, 'hello from the server\n']);
      r = await run(schear, { names: whisper, env: { ...env, FAKE_FAIL_ffmpeg: 'no device' } });
      assert.deepEqual([r.code, r.stderr], [1, 'schear: no device\n']);
      r = await run(schear, {
        platform: 'win32',
        argv: ['--engine', 'whisper'],
        names: ['ffmpeg.exe', 'whisper-cli.exe'],
        env: { ...env, FAKE_FAIL_ffmpeg_exe: '' },
      });
      assert.equal(r.code, 0);
    }
  );

  it('lists the microphones with -a', posix, async () => {
    let r = await run(schear, { platform: 'darwin', argv: ['-a'], names: ['ffmpeg'] });
    assert.deepEqual([r.code, r.stdout], [0, '0\tMacBook Pro Microphone\n1\tUSB Mic\n']);
    r = await run(schear, {
      argv: ['--audio-input-devices'],
      names: ['pactl', 'arecord'],
      env: { FAKE_PULSE: '1' },
    });
    assert.equal(r.stdout, 'alsa_input.usb-mic\talsa_input.usb-mic\n');
    r = await run(schear, { argv: ['-a'], names: ['pactl', 'arecord'] });
    assert.equal(r.stdout, 'default\tDefault ALSA Output\nhw:CARD=Mic,DEV=0\tUSB Mic, USB Audio\n');
    r = await run(schear, { argv: ['-a'], names: [] });
    assert.deepEqual(
      [r.code, r.stderr],
      [1, 'schear: neither pactl nor arecord found, which list the microphones\n']
    );
    r = await run(schear, { platform: 'darwin', argv: ['-a'], names: [] });
    assert.deepEqual(
      [r.code, r.stderr],
      [1, 'schear: ffmpeg not found, which lists the microphones\n']
    );
  });

  it('lists the dshow microphones with -a on Windows, and records from the first', async () => {
    let r = await run(schear, { platform: 'win32', argv: ['--devices'], names: ['ffmpeg.exe'] });
    assert.equal(r.stdout, 'Microphone (Realtek)\tMicrophone (Realtek)\nLine In\tLine In\n');
    r = await run(schear, {
      platform: 'win32',
      argv: [],
      names: ['whisper-cli.exe', 'ffmpeg.exe'],
      env: { SLICC_AUDIO_CACHE: cached() },
    });
    assert.equal(r.code, 0);
  });
});

describe('schear --status and --warmup', posix, () => {
  it('reports each engine', async () => {
    const cache = cached();
    server.models = { ortllama: [], ollama: ['w'] };
    let r = await run(schear, {
      argv: ['--status'],
      names: whisper,
      ortllama: server.ortllama,
      env: { ...ollama(), SLICC_AUDIO_CACHE: cache },
    });
    assert.equal(
      r.stdout,
      [
        'whisper: ready (whisper-cli, ffmpeg, ggml-base.bin)',
        "ortllama: not cached (hf download onnx-community/whisper-tiny --include '*.json')",
        `ollama: needs --model (a transcription model at ${server.url}/ollama)`,
        '',
      ].join('\n')
    );
    server.models.ortllama = ['transcribe'];
    r = await run(schear, {
      argv: ['--status', '--model', 'w'],
      names: whisper,
      ortllama: server.ortllama,
      env: ollama(),
    });
    assert.equal(
      r.stdout,
      [
        'whisper: model not downloaded (schear --warmup)',
        "ortllama: not cached (hf download onnx-community/whisper-tiny --include '*.json')",
        `ollama: ready (w at ${server.url}/ollama)`,
        '',
      ].join('\n')
    );
    r = await run(schear, {
      argv: ['--status'],
      names: [],
      ortllama: missingModule,
      env: { SLICC_AUDIO_MODEL: 'z', ...ollama() },
    });
    assert.match(
      r.stdout,
      /^whisper: whisper-cli not found .*\nortllama: not installed .*\nollama: model not pulled \(ollama pull z\)\n$/
    );
    r = await run(schear, { argv: ['--status', '--engine', 'ollama'], names: [] });
    assert.equal(
      r.stdout,
      'ollama: no server at http://127.0.0.1:9 (install Ollama from https://ollama.com, then ollama serve)\n'
    );
  });

  it('downloads the whisper model, runs hf, or prints what to run', async () => {
    const cache = temp('cache');
    server.models.hf = { 'ggml-base.bin': { data: model } };
    let r = await run(schear, {
      argv: ['--warmup'],
      names: whisper,
      env: { ...hf(), SLICC_AUDIO_CACHE: cache },
    });
    assert.deepEqual(
      [r.code, r.stdout],
      [0, 'whisper: ready (whisper-cli, ffmpeg, ggml-base.bin)\n']
    );
    assert.ok(existsSync(join(cache, 'ggml-base.bin')));
    r = await run(schear, { argv: ['--warmup'], names: ['hf'], ortllama: server.ortllama });
    assert.deepEqual(
      r.calls.map((c) => c.args),
      [['download', 'onnx-community/whisper-tiny', '--include', '*.json']]
    );
    server.models.ortllama = ['transcribe'];
    r = await run(schear, { argv: ['--warmup'], names: [], ortllama: server.ortllama });
    assert.deepEqual([r.code, r.stdout], [0, 'ortllama: ready (transcribe)\n']);
    r = await run(schear, {
      argv: ['--warmup'],
      names: [],
      ortllama: missingModule,
      env: ollama(),
    });
    assert.deepEqual([r.code, r.stdout], [1, 'ollama pull <model>\n']);
    server.models.ollama = ['w'];
    r = await run(schear, {
      argv: ['--warmup', '--model', 'w'],
      names: [],
      ortllama: missingModule,
      env: ollama(),
    });
    assert.deepEqual([r.code, r.stdout], [0, `ollama: ready (w at ${server.url}/ollama)\n`]);
    r = await run(schear, { argv: ['--warmup'], names: [], ortllama: missingModule });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /^schear: no recognition engine available\n/);
  });

  it('takes -v as a value of -d, not as the version', async () => {
    const r = await run(schear, {
      platform: 'darwin',
      argv: ['-d', '-v'],
      names: whisper,
      env: { SLICC_AUDIO_CACHE: cached() },
    });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.calls[0].args.includes(':-v'));
  });
});
