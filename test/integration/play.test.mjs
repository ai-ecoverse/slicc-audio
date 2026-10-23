import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { scchime, scplay } from '../../host/play.mjs';
import { run, temp, tone, writeFileSync } from './fakes.mjs';

const root = resolve(import.meta.dirname, '../..');
const linux = ['paplay', 'pw-play', 'aplay', 'ffplay'];

function sound() {
  const file = join(temp('sound'), 'a.wav');
  writeFileSync(file, tone());
  return file;
}

describe('scplay', () => {
  it('passes every afplay option through unchanged on macOS', async () => {
    const file = sound();
    const argv = ['-v', '0.5', file, '-t', '2', '-r', '1.5', '-q', '1', '-d', '--leaks'];
    const r = await run(scplay, { platform: 'darwin', argv, names: ['afplay', 'ffplay'] });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(
      r.calls.map((c) => [c.name, c.args]),
      [['afplay', argv]]
    );
  });

  it('tries paplay, pw-play, aplay, then ffplay elsewhere', async () => {
    const file = sound();
    for (const [names, used, args] of [
      [linux, 'paplay', [file]],
      [['pw-play', 'aplay', 'ffplay'], 'pw-play', [file]],
      [['aplay', 'ffplay'], 'aplay', ['-q', file]],
      [['ffplay'], 'ffplay', ['-nodisp', '-autoexit', '-loglevel', 'error', file]],
    ]) {
      for (const platform of ['linux', 'freebsd']) {
        const r = await run(scplay, { platform, argv: [file], names });
        assert.equal(r.code, 0, r.stderr);
        assert.deepEqual(
          r.calls.map((c) => [c.name, c.args]),
          [[used, args]]
        );
      }
    }
  });

  it('maps -v and -r, skipping the tools that cannot do them', async () => {
    const file = sound();
    let r = await run(scplay, { argv: ['-v', '0.5', file], names: linux });
    assert.deepEqual(r.calls[0].args, ['--volume=32768', file]);
    r = await run(scplay, { argv: ['--volume', '0.25', file], names: ['pw-play', 'aplay'] });
    assert.deepEqual([r.calls[0].name, r.calls[0].args], ['pw-play', ['--volume', '0.25', file]]);
    r = await run(scplay, { argv: ['-v', '0.5', file], names: ['aplay', 'ffplay'] });
    assert.deepEqual(r.calls[0].args, [
      '-nodisp',
      '-autoexit',
      '-loglevel',
      'error',
      '-volume',
      '50',
      file,
    ]);
    r = await run(scplay, { argv: ['-r', '2', file], names: linux });
    assert.deepEqual(r.calls[0].args, [
      '-nodisp',
      '-autoexit',
      '-loglevel',
      'error',
      '-af',
      'atempo=2',
      file,
    ]);
    r = await run(scplay, { argv: ['-r', '0.25', file], names: linux });
    assert.equal(r.calls[0].args.at(-2), 'atempo=0.5,atempo=0.5');
    r = await run(scplay, { argv: ['-r', '2', file], names: ['paplay', 'pw-play', 'aplay'] });
    assert.equal(r.code, 1);
    assert.equal(r.stderr, 'scplay: no audio player found (tried ffplay)\n');
    r = await run(scplay, { argv: ['-v', '0.5', file], names: ['aplay'] });
    assert.equal(r.stderr, 'scplay: no audio player found (tried paplay, pw-play, ffplay)\n');
    r = await run(scplay, { argv: [file], names: [] });
    assert.equal(
      r.stderr,
      'scplay: no audio player found (tried paplay, pw-play, aplay, ffplay)\n'
    );
  });

  it('stops the tool after -t seconds, prints it with -d and ignores -q off macOS', async () => {
    const file = sound();
    const started = Date.now();
    const r = await run(scplay, {
      argv: ['-t', '0.3', '-d', '-q', '1', file],
      names: ['paplay'],
      env: { FAKE_SLEEP_paplay: '20' },
    });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(Date.now() - started < 10000);
    assert.equal(r.stderr, `scplay: paplay ${file}\n`);
  });

  it('uses powershell.exe, else pwsh.exe, with the path in the environment on Windows', async () => {
    const file = sound();
    for (const names of [['powershell.exe', 'pwsh.exe'], ['pwsh.exe']]) {
      const r = await run(scplay, {
        platform: 'win32',
        argv: ['-v', '0.5', '-r', '2', file],
        names,
      });
      assert.equal(r.code, 0, r.stderr);
      const [call] = r.calls;
      assert.equal(call.name, names[0]);
      assert.deepEqual(call.args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-EncodedCommand']);
      assert.ok(!call.args.includes(file));
      const script = Buffer.from(call.args[3], 'base64').toString('utf16le');
      assert.match(script, /System\.Windows\.Media\.MediaPlayer/);
      assert.deepEqual(call.env, {
        SLICC_AUDIO_CACHE: r.env.SLICC_AUDIO_CACHE,
        SLICC_AUDIO_FILE: file,
        SLICC_AUDIO_VOLUME: '0.5',
        SLICC_AUDIO_RATE: '2',
      });
    }
    const r = await run(scplay, { platform: 'win32', argv: [file], names: [] });
    assert.equal(r.stderr, 'scplay: no audio player found (tried powershell.exe, pwsh.exe)\n');
  });

  it('exits 1 for a missing file or a failing tool, and 2 for a bad argument', async () => {
    const file = sound();
    let r = await run(scplay, { argv: ['/no/such.wav'], names: linux });
    assert.deepEqual(
      [r.code, r.stderr, r.calls],
      [1, 'scplay: cannot open /no/such.wav: No such file\n', []]
    );
    r = await run(scplay, { argv: [file], names: ['paplay'], env: { FAKE_FAIL_paplay: 'boom' } });
    assert.equal(r.code, 1);
    assert.equal(r.stderr, 'boom\nscplay: paplay failed (exit 3)\n');
    const usage = 'usage: scplay [-v volume] [-t time] [-r rate] [-q quality] [-d] file\n';
    for (const [argv, message] of [
      [['--leaks', file], "--leaks isn't supported on linux"],
      [[file, file], 'only one file'],
      [[], 'no file'],
      [['-v', '2', file], '-v 2: from 0 to 1'],
      [['-r', '5', file], '-r 5: from 0.25 to 4'],
      [['-q', '0.5', file], '-q 0.5: 0 or 1'],
      [['-t', '0', file], '-t 0: more than 0 and at most 86400'],
      [['-x', file], 'unknown option: -x'],
      [['-v'], '-v needs a value'],
    ]) {
      r = await run(scplay, { argv, names: linux });
      assert.deepEqual(
        [r.code, r.stderr, r.calls],
        [2, `scplay: ${message}\n${usage}`, []],
        argv.join(' ')
      );
    }
    for (const flag of ['-h', '--help', '-help']) {
      r = await run(scplay, { argv: [flag] });
      assert.deepEqual([r.code, r.stdout], [0, usage]);
    }
  });
});

describe('scchime', () => {
  it('plays the chime it synthesizes and deletes it', async () => {
    const r = await run(scchime, { names: linux });
    assert.equal(r.code, 0, r.stderr);
    const [call] = r.calls;
    assert.equal(call.name, 'paplay');
    const wav = Buffer.from(call.files[call.args[0]], 'base64');
    assert.ok(!existsSync(call.args[0]));
    assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
    assert.equal(wav.readUInt16LE(20), 1);
    assert.equal(wav.readUInt16LE(22), 1);
    assert.equal(wav.readUInt32LE(24), 44100);
    assert.equal(wav.readUInt16LE(34), 16);
    const samples = (wav.length - 44) / 2;
    assert.equal(samples, Math.round(0.45 * 44100));
    let peak = 0;
    for (let i = 0; i < samples; i++) peak = Math.max(peak, Math.abs(wav.readInt16LE(44 + i * 2)));
    assert.ok(Math.abs(20 * Math.log10(peak / 32767) + 6) < 0.01, String(peak));
    const shape = (n) => {
      const t = n / 44100;
      const second =
        t >= 0.1 ? Math.sin(2 * Math.PI * 1318.5 * (t - 0.1)) * Math.exp(-(t - 0.1) / 0.12) : 0;
      return Math.sin(2 * Math.PI * 880 * t) * Math.exp(-t / 0.12) + second;
    };
    let top = 0;
    for (let i = 0; i < samples; i++) top = Math.max(top, Math.abs(shape(i)));
    for (const n of [10, 1000, 4410, 5000, 12000]) {
      const want = Math.round((shape(n) / top) * 10 ** (-6 / 20) * 32767);
      assert.ok(Math.abs(wav.readInt16LE(44 + n * 2) - want) <= 1, `sample ${n}`);
    }
  });

  it('plays through afplay on macOS and takes no arguments', async () => {
    let r = await run(scchime, { platform: 'darwin', names: ['afplay'] });
    assert.equal(r.code, 0);
    assert.equal(r.calls[0].name, 'afplay');
    assert.equal(r.calls[0].args.length, 1);
    r = await run(scchime, { argv: ['loud'], names: linux });
    assert.deepEqual(
      [r.code, r.stderr],
      [2, 'scchime: unexpected argument: loud\nusage: scchime\n']
    );
    r = await run(scchime, { argv: ['--help'] });
    assert.deepEqual([r.code, r.stdout], [0, 'usage: scchime\n']);
  });
});

describe('every host command', () => {
  const version = JSON.parse(
    spawnSync('node', ['-p', 'JSON.stringify(require("./package.json"))'], {
      cwd: root,
      encoding: 'utf8',
    }).stdout
  ).version;

  it('prints its version, and the npm command for --upgrade when npm installed it', () => {
    for (const name of ['scsay', 'schear', 'scplay', 'scchime']) {
      let r = spawnSync(process.execPath, [join(root, 'host', `${name}.mjs`), '--version'], {
        encoding: 'utf8',
      });
      assert.deepEqual([r.status, r.stdout, r.stderr], [0, `${name} ${version}\n`, '']);
      r = spawnSync(process.execPath, [join(root, 'host', `${name}.mjs`), '--upgrade'], {
        encoding: 'utf8',
      });
      assert.deepEqual(
        [r.status, r.stdout],
        [0, 'npm install -g @ai-ecoverse/slicc-audio@latest\n']
      );
      r = spawnSync(process.execPath, [join(root, 'host', `${name}.mjs`), '--upgrade', 'now'], {
        encoding: 'utf8',
      });
      assert.equal(r.status, 2);
      assert.match(
        r.stderr,
        new RegExp(`^${name}: --upgrade takes no other arguments\nusage: ${name}`)
      );
    }
    const r = spawnSync(process.execPath, [join(root, 'host', 'schear.mjs'), '-v'], {
      encoding: 'utf8',
    });
    assert.equal(r.stdout, `schear ${version}\n`);
  });
});
