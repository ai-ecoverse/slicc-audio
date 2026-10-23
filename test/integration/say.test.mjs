import assert from 'node:assert/strict';
import { join } from 'node:path';
import { beforeEach, describe, it } from 'node:test';
import { scsay } from '../../host/say.mjs';
import { fakeServer, missingModule, readFileSync, run, temp, writeFileSync } from './fakes.mjs';

const unix = ['spd-say', 'espeak-ng', 'espeak', 'paplay'];
const USAGE =
  "usage: scsay [-v voice] [-r rate] [-l lang] [-o file [--file-format=fmt] [--data-format=fmt] [--channels=n]] [-i] [-f file | text ...]\n       scsay -v '?' | --list | --status | --warmup\n";

const server = await fakeServer();
beforeEach(() => server.reset());

const ollama = () => ({ OLLAMA_HOST: `${server.url}/ollama` });

function voicesOf(names) {
  const langs = { a: 'en-US', b: 'en-GB', e: 'es-ES' };
  return names.map((id) => ({
    id,
    model: 'onnx-community/Kokoro-82M-v1.0-ONNX',
    engine: 'kokoro',
    language: langs[id[0]],
    gender: id[1] === 'f' ? 'female' : 'male',
  }));
}

describe('scsay on macOS', () => {
  it('hands the text to say on stdin, with -r as words per minute and -l as a voice', async () => {
    const r = await run(scsay, {
      platform: 'darwin',
      argv: [
        '-r',
        '2',
        '-l',
        'en-GB',
        '-i',
        '-n',
        'x',
        '-a',
        '1',
        '--progress',
        '--quality',
        '1',
        '--bit-rate',
        '9',
        'hello',
        'there',
      ],
      names: ['say'],
    });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(
      r.calls.map((c) => [c.name, c.args, c.stdin]),
      [
        ['say', ['-v', '?'], ''],
        [
          'say',
          [
            '-r',
            '350',
            '-i',
            '-n',
            'x',
            '-a',
            '1',
            '--progress',
            '--quality',
            '1',
            '--bit-rate',
            '9',
            '-v',
            'Daniel',
            '-f',
            '-',
          ],
          'hello there',
        ],
      ]
    );
  });

  it('passes -v, -o and the formats through, and writes WAV for -o -', async () => {
    const out = join(temp('mac'), 'out.m4a');
    let r = await run(scsay, {
      platform: 'darwin',
      argv: ['-v', 'Alb', '-o', out, '--file-format=m4af', '--data-format=aac', '-r', '200'],
      names: ['say'],
      stdin: 'from stdin',
    });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(
      r.calls.map((c) => [c.args, c.stdin]),
      [
        [
          [
            '-v',
            'Alb',
            '-o',
            out,
            '--file-format=m4af',
            '--data-format=aac',
            '-r',
            '200',
            '-f',
            '-',
          ],
          'from stdin',
        ],
      ]
    );
    r = await run(scsay, { platform: 'darwin', argv: ['-o', '-', 'hi'], names: ['say'] });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.calls[0].args.slice(0, 1), ['-o']);
    assert.deepEqual(r.calls[0].args.slice(2), [
      '--file-format=WAVE',
      '--data-format=LEI16',
      '-f',
      '-',
    ]);
    assert.equal(r.stdoutRaw.toString('ascii', 0, 4), 'RIFF');
    r = await run(scsay, { platform: 'darwin', argv: ['-v', '?'], names: ['say'] });
    assert.match(r.stdout, /^Albert {14}en_US/);
    r = await run(scsay, { platform: 'darwin', argv: ['--file-format=?'], names: ['say'] });
    assert.deepEqual([r.stdout, r.calls[0].args], ['say formats\n', ['--file-format=?']]);
    r = await run(scsay, { platform: 'darwin', argv: ['--list'], names: ['say'] });
    assert.equal(
      r.stdout,
      'Albert (en-US) [platform]\nDaniel (en-GB) [platform]\nEddy (English (UK)) (en-GB) [platform]\n'
    );
    r = await run(scsay, { platform: 'darwin', argv: ['-l', 'xx', 'hi'], names: ['say'] });
    assert.deepEqual([r.code, r.stderr], [1, 'scsay: no say voice for xx\n']);
    r = await run(scsay, {
      platform: 'darwin',
      argv: ['hi'],
      names: ['say'],
      env: { FAKE_FAIL_say: 'say broke' },
    });
    assert.deepEqual([r.code, r.stderr], [1, 'say broke\nscsay: say failed (exit 3)\n']);
  });
});

describe('scsay on Linux', () => {
  it('prefers spd-say, with the text after --, then espeak-ng and espeak on stdin', async () => {
    let r = await run(scsay, { argv: ['-r', '2', '-v', 'span', 'hola'], names: unix });
    assert.deepEqual(
      r.calls.map((c) => [c.name, c.args]),
      [
        ['spd-say', ['-L']],
        ['spd-say', ['-w', '-r', '100', '-y', 'Spanish', '--', 'hola']],
      ]
    );
    r = await run(scsay, { argv: ['-r', '0.1', '-l', 'es-ES', 'hola'], names: unix });
    assert.deepEqual(r.calls[0].args, ['-w', '-r', '-90', '-l', 'es-ES', '--', 'hola']);
    for (const tool of ['espeak-ng', 'espeak']) {
      r = await run(scsay, {
        argv: ['-r', '9', '-v', 'america', 'secret', 'words'],
        names: [tool],
      });
      assert.equal(r.code, 0, r.stderr);
      assert.deepEqual(
        r.calls.map((c) => [c.name, c.args, c.stdin]),
        [
          [tool, ['--voices'], ''],
          [tool, ['--stdin', '-s', '450', '-v', 'English_(America)'], 'secret words'],
        ]
      );
    }
    r = await run(scsay, { argv: ['-r', '300', '-l', 'en_US', 'hi'], names: ['espeak-ng'] });
    assert.deepEqual(r.calls[0].args, ['--stdin', '-s', '300', '-v', 'en-us']);
    r = await run(scsay, { argv: ['-v', 'nobody', 'hi'], names: ['espeak-ng'] });
    assert.deepEqual(
      [r.code, r.stderr],
      [1, 'scsay: voice "nobody" not found (scsay -v \'?\' lists them)\n']
    );
  });

  it('writes files with espeak-ng -w, converted to the format asked for', async () => {
    const dir = temp('out');
    let r = await run(scsay, { argv: ['-o', join(dir, 'speech'), 'hi'], names: unix });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.calls[0].name, 'espeak-ng');
    assert.equal(r.calls[0].args[1], '-w');
    const aiff = readFileSync(join(dir, 'speech.aiff'));
    assert.equal(aiff.toString('ascii', 0, 4) + aiff.toString('ascii', 8, 16), 'FORMAIFFCOMM');
    assert.equal(aiff.readUInt16BE(26), 16);
    r = await run(scsay, {
      argv: ['-o', join(dir, 'a.caf'), '--data-format=LEF32@8000', '--channels=2', 'hi'],
      names: ['espeak'],
    });
    assert.equal(r.code, 0, r.stderr);
    const caf = readFileSync(join(dir, 'a.caf'));
    assert.equal(caf.toString('ascii', 0, 4), 'caff');
    assert.equal(caf.readDoubleBE(20), 8000);
    assert.equal(caf.readUInt32BE(32), 3);
    assert.equal(caf.readUInt32BE(44), 2);
    r = await run(scsay, {
      argv: ['-o', join(dir, 'b.out'), '--file-format=WAVE', '--data-format=I24', 'hi'],
      names: unix,
    });
    const wav = readFileSync(join(dir, 'b.out'));
    assert.deepEqual(
      [wav.toString('ascii', 8, 12), wav.readUInt16LE(34), wav.readUInt32LE(24)],
      ['WAVE', 24, 24000]
    );
    r = await run(scsay, {
      argv: ['-o', join(dir, 'c.wav'), '--data-format=UI8', 'hi'],
      names: unix,
    });
    assert.equal(readFileSync(join(dir, 'c.wav')).readUInt16LE(34), 8);
    r = await run(scsay, {
      argv: ['-o', join(dir, 'd.aif'), '--data-format=BEI32', 'hi'],
      names: unix,
    });
    assert.equal(readFileSync(join(dir, 'd.aif')).readUInt16BE(26), 32);
    r = await run(scsay, {
      argv: ['-o', join(dir, 'e.caf'), '--data-format=BEF64', 'hi'],
      names: unix,
    });
    assert.equal(readFileSync(join(dir, 'e.caf')).readUInt32BE(48), 64);
    r = await run(scsay, { argv: ['-o', '-', 'hi'], names: unix });
    assert.equal(r.stdoutRaw.toString('ascii', 0, 4), 'RIFF');
    r = await run(scsay, {
      argv: ['-o', 'x.wav', 'hi'],
      names: ['spd-say'],
      ortllama: missingModule,
    });
    assert.match(
      r.stderr,
      /platform: espeak-ng and espeak not found, and spd-say can't write a file/
    );
  });

  it('prints each line before speaking it with -i, and reads -f files and stdin', async () => {
    const file = join(temp('text'), 'speech.txt');
    writeFileSync(file, 'one\ntwo\n');
    let r = await run(scsay, { argv: ['-i', '-f', file], names: unix });
    assert.equal(r.stdout, 'one\ntwo\n');
    assert.deepEqual(
      r.calls.map((c) => c.args.at(-1)),
      ['one', 'two']
    );
    r = await run(scsay, {
      argv: ['--interactive=bold', '--input-file=-'],
      names: ['espeak-ng'],
      stdin: 'a\nb',
    });
    assert.deepEqual(
      r.calls.map((c) => c.stdin),
      ['a', 'b']
    );
    r = await run(scsay, { names: ['espeak-ng'], stdin: 'piped' });
    assert.equal(r.calls[0].stdin, 'piped');
    r = await run(scsay, { names: ['espeak-ng'], stdin: '  \n' });
    assert.deepEqual([r.code, r.calls], [0, []]);
    r = await run(scsay, { argv: ['-f', '/no/file'], names: ['espeak-ng'] });
    assert.deepEqual([r.code, r.stderr], [1, 'scsay: cannot open /no/file: No such file\n']);
    r = await run(scsay, {
      argv: ['hi'],
      names: ['espeak-ng'],
      env: { FAKE_FAIL_espeak_ng: 'no sound' },
    });
    assert.deepEqual([r.code, r.stderr], [1, 'no sound\nscsay: espeak-ng failed (exit 3)\n']);
  });

  it("lists the voices, and refuses macOS's options", async () => {
    let r = await run(scsay, { argv: ['-v', '?'], names: unix });
    assert.equal(
      r.stdout,
      'English (America)   en_US    # Hello, my name is English (America).\nSpanish             es       # Hello, my name is Spanish.\n'
    );
    r = await run(scsay, { argv: ['--list'], names: ['espeak-ng'] });
    assert.equal(
      r.stdout,
      'English_(America) (en-us) [platform]\nSpanish_(Spain) (es) [platform]\n'
    );
    for (const [argv, message] of [
      [['-n', 'x', 'hi'], "-n isn't supported on linux"],
      [['-a', '1', 'hi'], "-a isn't supported on linux"],
      [['--progress', 'hi'], "--progress isn't supported on linux"],
      [['--bit-rate', '1', 'hi'], "--bit-rate isn't supported on linux"],
      [['--quality', '1', 'hi'], "--quality isn't supported on linux"],
      [['-r', '0', 'hi'], '-r 0: a multiple from 0.1 to 10, or words per minute up to 1000'],
      [['-r', '1001', 'hi'], '-r 1001: a multiple from 0.1 to 10, or words per minute up to 1000'],
      [['-l', 'e', 'hi'], '-l e: not a language tag'],
      [['--engine=web', 'hi'], '--engine web: one of platform, ortllama, ollama'],
      [['-o', 'a.wav', '--channels=3', 'hi'], '--channels 3: 1 or 2'],
      [['-o', 'a.wav', '--file-format=m4af', 'hi'], '--file-format m4af: no encoder for it'],
      [['-o', 'a.wav', '--data-format=aac', 'hi'], '--data-format aac: no encoder for it'],
      [
        ['-o', 'a.aiff', '--data-format=LEI16', 'hi'],
        '--data-format LEI16: no encoder for it in AIFF',
      ],
      [['-o', 'a.wav', '--data-format=I16@10', 'hi'], '--data-format I16@10: bad sample rate'],
      [['--data-format=I16', 'hi'], '--file-format, --data-format and --channels need -o'],
      [['--list=yes'], '--list takes no value'],
      [['-z'], 'unknown option: -z'],
    ]) {
      r = await run(scsay, { argv, names: unix });
      assert.deepEqual(
        [r.code, r.stderr, r.calls],
        [2, `scsay: ${message}\n${USAGE}`, []],
        argv.join(' ')
      );
    }
    r = await run(scsay, { argv: ['--file-format=?'] });
    assert.equal(r.stdout, 'WAVE  .wav\nAIFF  .aiff .aif\ncaff  .caf\n');
    r = await run(scsay, { argv: ['--file-format=AIFF', '--data-format=?'] });
    assert.equal(r.stdout, 'AIFF  BEI8 BEI16 BEI24 BEI32\n');
    r = await run(scsay, { argv: ['--data-format=?'] });
    assert.equal(r.stdout.split('\n').length, 4);
    r = await run(scsay, { argv: ['-h'] });
    assert.deepEqual([r.code, r.stdout], [0, USAGE]);
  });
});

describe('scsay on Windows', () => {
  it('runs System.Speech in powershell.exe, with the text on stdin and the rest in the environment', async () => {
    let r = await run(scsay, {
      platform: 'win32',
      argv: ['-v', 'hazel', '-r', '3', 'secret'],
      names: ['powershell.exe', 'pwsh.exe'],
    });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(
      r.calls.map((c) => [
        c.name,
        c.stdin,
        c.env.SLICC_AUDIO_MODE,
        c.env.SLICC_AUDIO_VOICE,
        c.env.SLICC_AUDIO_RATE,
      ]),
      [
        ['powershell.exe', '', 'list', undefined, undefined],
        ['powershell.exe', 'secret', 'speak', 'Microsoft Hazel Desktop', '10'],
      ]
    );
    assert.ok(!r.calls[1].args.includes('secret'));
    assert.match(
      Buffer.from(r.calls[1].args[3], 'base64').toString('utf16le'),
      /SpeechSynthesizer/
    );
    r = await run(scsay, {
      platform: 'win32',
      argv: ['-l', 'en-US', '-r', '0.5', 'x'],
      names: ['powershell.exe'],
    });
    assert.deepEqual(
      [r.calls[1].env.SLICC_AUDIO_VOICE, r.calls[1].env.SLICC_AUDIO_RATE],
      ['Microsoft David Desktop', '-6']
    );
    r = await run(scsay, { platform: 'win32', argv: ['-l', 'de', 'x'], names: ['powershell.exe'] });
    assert.deepEqual([r.code, r.stderr], [1, 'scsay: no installed voice for de\n']);
    r = await run(scsay, {
      platform: 'win32',
      argv: ['-v', 'zira', 'x'],
      names: ['powershell.exe'],
    });
    assert.equal(r.code, 1);
    const dir = temp('win');
    r = await run(scsay, {
      platform: 'win32',
      argv: ['-o', join(dir, 'a.wav'), 'x'],
      names: ['powershell.exe'],
    });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.calls[0].env.SLICC_AUDIO_OUT, /speech\.wav$/);
    assert.equal(readFileSync(join(dir, 'a.wav')).toString('ascii', 0, 4), 'RIFF');
    r = await run(scsay, { platform: 'win32', argv: ['-v', '?'], names: ['powershell.exe'] });
    assert.match(r.stdout, /^Microsoft David Desktop en_US {4}# /);
    r = await run(scsay, { platform: 'win32', argv: ['-n', 'x', 'hi'] });
    assert.match(r.stderr, /^scsay: -n isn't supported on windows\n/);
    r = await run(scsay, {
      platform: 'win32',
      argv: ['hi'],
      names: ['pwsh.exe'],
      ortllama: missingModule,
    });
    assert.match(r.stderr, /platform: powershell\.exe not found/);
  });
});

describe('scsay engines', () => {
  it('falls back to slicc-ortllama, then Ollama, then lists every engine', async () => {
    server.models.ortllama = ['speech'];
    let r = await run(scsay, {
      argv: ['-r', '9', 'hi'],
      names: ['paplay'],
      ortllama: server.ortllama,
    });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(server.started, [{ port: 0, host: '127.0.0.1' }]);
    assert.equal(server.closed, 1);
    assert.deepEqual(
      server.requests.map((q) => [q.tier, q.route, q.body]),
      [
        [
          'ortllama',
          '/v1/audio/speech',
          { input: 'hi', voice: 'af_heart', speed: 4, response_format: 'wav' },
        ],
      ]
    );
    assert.equal(r.calls[0].name, 'paplay');
    assert.equal(
      Buffer.from(Object.values(r.calls[0].files)[0], 'base64').toString('ascii', 0, 4),
      'RIFF'
    );
    server.reset();
    server.models.ollama = ['phonon'];
    r = await run(scsay, {
      argv: ['hi'],
      names: ['paplay'],
      ortllama: missingModule,
      env: ollama(),
    });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(
      server.requests.map((q) => [q.tier, q.body]),
      [['ollama', { model: 'phonon', input: 'hi', voice: 'default', response_format: 'wav' }]]
    );
    server.reset();
    server.models.ollama = ['other'];
    r = await run(scsay, {
      argv: ['-r', '2', '-v', 'x', 'hi'],
      names: ['paplay'],
      ortllama: server.ortllama,
      env: { ...ollama(), SLICC_AUDIO_MODEL: 'other' },
    });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(
      server.requests.map((q) => [q.tier, q.body]),
      [
        ['ortllama', undefined],
        ['ortllama', { input: 'hi', voice: 'x', speed: 2, response_format: 'wav', model: 'other' }],
        ['ollama', { model: 'other', input: 'hi', voice: 'x', response_format: 'wav', speed: 2 }],
      ]
    );
    server.reset();
    r = await run(scsay, { argv: ['hi'], names: [], ortllama: server.ortllama, env: ollama() });
    assert.equal(r.code, 1);
    assert.equal(
      r.stderr,
      [
        'scsay: no speech engine available',
        '  platform: spd-say, espeak-ng and espeak not found (install espeak-ng or speech-dispatcher)',
        "  ortllama: model not cached (hf download onnx-community/Kokoro-82M-v1.0-ONNX --include config.json 'voices/*')",
        '  ollama: model not pulled (ollama pull phonon)',
        '',
      ].join('\n')
    );
    r = await run(scsay, { argv: ['hi'], names: [], ortllama: missingModule });
    assert.match(
      r.stderr,
      /\n {2}ortllama: @ai-ecoverse\/slicc-ortllama not installed .*\n {2}ollama: no server at http:\/\/127\.0\.0\.1:9 \(install Ollama from https:\/\/ollama\.com, then ollama serve\)\n$/
    );
  });

  it('uses only the engine --engine or SLICC_AUDIO_ENGINE names, the option first', async () => {
    server.models.ortllama = ['speech'];
    let r = await run(scsay, {
      argv: ['--engine', 'ortllama', 'hi'],
      names: unix,
      ortllama: server.ortllama,
    });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(
      r.calls.map((c) => c.name),
      ['paplay']
    );
    r = await run(scsay, {
      argv: ['hi'],
      names: unix,
      ortllama: server.ortllama,
      env: { SLICC_AUDIO_ENGINE: 'ortllama' },
    });
    assert.deepEqual(
      r.calls.map((c) => c.name),
      ['paplay']
    );
    r = await run(scsay, {
      argv: ['--engine=platform', 'hi'],
      names: unix,
      ortllama: server.ortllama,
      env: { SLICC_AUDIO_ENGINE: 'ortllama' },
    });
    assert.deepEqual(
      r.calls.map((c) => c.name),
      ['spd-say']
    );
    r = await run(scsay, {
      argv: ['--engine=ollama', 'hi'],
      names: unix,
      ortllama: server.ortllama,
    });
    assert.deepEqual(
      [r.code, r.stderr],
      [
        1,
        'scsay: no speech engine available\n  ollama: no server at http://127.0.0.1:9 (install Ollama from https://ollama.com, then ollama serve)\n',
      ]
    );
  });

  it('fails without falling back when an engine errors', async () => {
    server.answer['ortllama /v1/audio/speech'] = {
      status: 501,
      body: { error: { message: 'install a phonemizer' } },
    };
    let r = await run(scsay, {
      argv: ['hi'],
      names: ['paplay'],
      ortllama: server.ortllama,
      env: ollama(),
    });
    assert.deepEqual([r.code, r.stderr], [1, 'scsay: install a phonemizer\n']);
    assert.deepEqual(
      server.requests.map((q) => q.tier),
      ['ortllama']
    );
    server.models.ollama = ['phonon'];
    server.answer['ollama /v1/audio/speech'] = { status: 400, body: 'plain failure' };
    r = await run(scsay, { argv: ['--engine=ollama', 'hi'], names: ['paplay'], env: ollama() });
    assert.deepEqual([r.code, r.stderr], [1, 'scsay: plain failure\n']);
  });

  it('picks Kokoro voices from -v and -l, and writes files with them', async () => {
    server.models.ortllama = ['speech', 'gradium/phonon'];
    server.voices = voicesOf(['af_bella', 'af_heart', 'bf_emma', 'ef_dora']);
    const dir = temp('k');
    let r = await run(scsay, {
      argv: ['--engine=ortllama', '-v', 'BEL', '-i', '-o', join(dir, 'x.wav'), 'hi'],
      ortllama: server.ortllama,
    });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, '');
    assert.deepEqual(
      server.requests.map((q) => [q.route, q.query, q.body?.voice]),
      [
        ['/v1/audio/voices', '', undefined],
        ['/v1/audio/speech', '', 'af_bella'],
      ]
    );
    server.requests = [];
    r = await run(scsay, {
      argv: ['--engine=ortllama', '--model', 'gradium/phonon', '-v', 'bel', '-o', '-', 'hi'],
      ortllama: server.ortllama,
    });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(
      server.requests.map((q) => [q.route, q.query, q.body?.voice]),
      [
        ['/v1/audio/voices', '?model=gradium%2Fphonon', undefined],
        ['/v1/audio/speech', '', 'bel'],
      ]
    );
    assert.equal(readFileSync(join(dir, 'x.wav')).toString('ascii', 0, 4), 'RIFF');
    for (const [lang, voice] of [
      ['en-GB', 'bf_emma'],
      ['es_MX', 'ef_dora'],
      ['en', 'af_heart'],
      ['pt-BR', 'pf_dora'],
    ]) {
      server.requests = [];
      r = await run(scsay, {
        argv: ['--engine=ortllama', '-l', lang, '-o', '-', 'hi'],
        ortllama: server.ortllama,
      });
      assert.equal(server.requests[0].body.voice, voice);
    }
    r = await run(scsay, {
      argv: ['--engine=ortllama', '-l', 'de', 'hi'],
      ortllama: server.ortllama,
    });
    assert.deepEqual(
      [r.code, r.stderr],
      [1, 'scsay: no speech engine available\n  ortllama: no Kokoro voice for de\n']
    );
    r = await run(scsay, {
      argv: ['--engine=ortllama', '-v', 'zz', 'hi'],
      ortllama: server.ortllama,
    });
    assert.deepEqual(
      [r.code, r.stderr],
      [1, 'scsay: voice "zz" not found (scsay -v \'?\' lists them)\n']
    );
    server.requests = [];
    r = await run(scsay, {
      argv: ['--engine=ortllama', '-i', 'one\ntwo'],
      names: ['paplay'],
      ortllama: server.ortllama,
    });
    assert.equal(r.stdout, 'one\ntwo\n');
    assert.deepEqual(
      server.requests.map((q) => q.body.input),
      ['one', 'two']
    );
    r = await run(scsay, {
      argv: ['--list'],
      names: [],
      ortllama: server.ortllama,
    });
    assert.equal(
      r.stdout,
      'af_bella (en-US) [ortllama]\naf_heart (en-US) [ortllama] [default]\nbf_emma (en-GB) [ortllama]\nef_dora (es-ES) [ortllama]\n'
    );
    r = await run(scsay, {
      argv: ['-v', '?'],
      names: [],
      ortllama: server.ortllama,
    });
    assert.match(r.stdout, /^af_bella {12}en_US {4}# Hello, my name is af_bella\.\n/);
    server.models.ollama = ['phonon'];
    r = await run(scsay, { argv: ['--list'], names: [], ortllama: missingModule, env: ollama() });
    assert.equal(r.stdout, 'default (en-US) [ollama] [default]\n');
    r = await run(scsay, { argv: ['--list'], names: [], ortllama: missingModule });
    assert.equal(r.code, 1);
    server.requests = [];
    server.models.ollama = ['phonon'];
    r = await run(scsay, { argv: ['--engine=ollama', '-i', '-o', '-', 'a\nb'], env: ollama() });
    assert.deepEqual([r.code, server.requests.map((q) => q.body.input)], [0, ['a\nb']]);
    r = await run(scsay, {
      argv: ['--engine=ollama', '-i', 'a\nb'],
      names: ['paplay'],
      env: ollama(),
    });
    assert.equal(r.stdout, 'a\nb\n');
  });

  it('reports --status and readies an engine with --warmup', async () => {
    let r = await run(scsay, {
      argv: ['--status'],
      names: ['espeak-ng'],
      ortllama: server.ortllama,
      env: ollama(),
    });
    assert.equal(
      r.stdout,
      [
        'platform: ready (espeak-ng)',
        "ortllama: not cached (hf download onnx-community/Kokoro-82M-v1.0-ONNX --include config.json 'voices/*')",
        'ollama: model not pulled (ollama pull phonon)',
        '',
      ].join('\n')
    );
    server.models = { ortllama: ['speech'], ollama: ['phonon:latest'] };
    r = await run(scsay, {
      argv: ['--status'],
      names: [],
      ortllama: server.ortllama,
      env: ollama(),
    });
    assert.equal(
      r.stdout,
      `platform: unavailable (spd-say, espeak-ng and espeak not found (install espeak-ng or speech-dispatcher))\nortllama: ready (speech)\nollama: ready (phonon at ${server.url}/ollama)\n`
    );
    r = await run(scsay, { argv: ['--status', '--engine=ortllama'], ortllama: missingModule });
    assert.equal(
      r.stdout,
      'ortllama: not installed (reinstall slicc-audio to get @ai-ecoverse/slicc-ortllama)\n'
    );
    r = await run(scsay, { argv: ['--status', '--engine=ollama'] });
    assert.equal(
      r.stdout,
      'ollama: no server at http://127.0.0.1:9 (install Ollama from https://ollama.com, then ollama serve)\n'
    );
    server.answer['ortllama /v1/models'] = { status: 200, body: { data: [] } };
    server.answer['ortllama /v1/audio/speech'] = { status: 200, body: 'RIFF' };
    r = await run(scsay, {
      argv: ['--status', '--engine=ortllama', '--model', 'x/y'],
      ortllama: server.ortllama,
    });
    assert.equal(r.stdout, 'ortllama: ready (x/y)\n');
    server.reset();

    r = await run(scsay, { argv: ['--warmup'], names: ['spd-say'], ortllama: server.ortllama });
    assert.deepEqual([r.code, r.stdout], [0, '']);
    r = await run(scsay, { argv: ['--warmup'], names: ['hf'], ortllama: server.ortllama });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(
      r.calls.map((c) => [c.name, c.args]),
      [
        [
          'hf',
          [
            'download',
            'onnx-community/Kokoro-82M-v1.0-ONNX',
            '--include',
            'config.json',
            'voices/*',
          ],
        ],
      ]
    );
    r = await run(scsay, {
      argv: ['--warmup'],
      names: ['hf'],
      ortllama: server.ortllama,
      env: { FAKE_FAIL_hf: 'offline' },
    });
    assert.equal(r.code, 1);
    r = await run(scsay, { argv: ['--warmup'], names: [], ortllama: server.ortllama });
    assert.deepEqual(
      [r.code, r.stderr],
      [
        1,
        "scsay: hf not found; run: hf download onnx-community/Kokoro-82M-v1.0-ONNX --include config.json 'voices/*'\n",
      ]
    );
    server.models.ortllama = ['speech'];
    r = await run(scsay, { argv: ['--warmup'], names: [], ortllama: server.ortllama });
    assert.deepEqual([r.code, r.stdout], [0, 'ortllama: ready (speech)\n']);
    r = await run(scsay, { argv: ['--warmup'], names: [], ortllama: missingModule, env: ollama() });
    assert.deepEqual([r.code, r.stdout], [1, 'ollama pull phonon\n']);
    server.models.ollama = ['phonon'];
    r = await run(scsay, { argv: ['--warmup'], names: [], ortllama: missingModule, env: ollama() });
    assert.deepEqual([r.code, r.stdout], [0, `ollama: ready (phonon at ${server.url}/ollama)\n`]);
    r = await run(scsay, { argv: ['--warmup'], names: [], ortllama: missingModule });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /^scsay: no speech engine available\n/);
  });

  it('sends long text in pieces of at most 4096 characters and joins the audio', async () => {
    server.models = { ortllama: ['speech'], ollama: ['phonon'] };
    server.inputs = [];
    const sentence = 'This sentence is part of a long article. ';
    const text = sentence.repeat(250);
    const dir = temp('long');
    let r = await run(scsay, {
      argv: ['--engine=ortllama', '-o', join(dir, 'a.wav'), text],
      ortllama: server.ortllama,
    });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(server.inputs.length >= 3);
    assert.ok(server.inputs.every((n) => n <= 4096));
    assert.equal(
      server.inputs.reduce((a, b) => a + b, 0),
      text.length
    );
    const wav = readFileSync(join(dir, 'a.wav'));
    assert.equal(wav.readUInt32LE(40), server.inputs.length * 2400 * 2);
    server.inputs = [];
    r = await run(scsay, {
      argv: ['--engine=ollama', 'x'.repeat(9000)],
      names: ['paplay'],
      env: ollama(),
    });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(server.inputs, [4096, 4096, 808]);
    server.inputs = undefined;
  });

  it('reads -- --upgrade as text, and hides its install directory from the tools', async () => {
    const r = await run(scsay, {
      argv: ['--', '--upgrade'],
      names: ['espeak-ng'],
      env: { SCSAY_INSTALL_DIR: '/x', SCHEAR_INSTALL_DIR: '/y' },
    });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(
      [r.calls[0].stdin, r.calls[0].env.SCSAY_INSTALL_DIR, r.calls[0].env.SCHEAR_INSTALL_DIR],
      ['--upgrade', undefined, undefined]
    );
  });
});
