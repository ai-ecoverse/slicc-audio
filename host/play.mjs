import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  encoded,
  exec,
  Failure,
  first,
  number,
  parseArgs,
  scratch,
  UsageError,
  unsupported,
  write,
} from './common.mjs';
import { meta } from './upgrade.mjs';
import { chime } from './wav.mjs';

const PLAY_PS = [
  'Add-Type -AssemblyName PresentationCore',
  '$p = New-Object System.Windows.Media.MediaPlayer',
  '$p.Open([Uri]::new([System.IO.Path]::GetFullPath($env:SLICC_AUDIO_FILE)))',
  '$wait = 0',
  'while (-not $p.NaturalDuration.HasTimeSpan) {',
  "  if ($wait -ge 200) { throw 'cannot decode audio' }",
  '  Start-Sleep -Milliseconds 50',
  '  $wait++',
  '}',
  '$rate = [double]$env:SLICC_AUDIO_RATE',
  '$p.Volume = [double]$env:SLICC_AUDIO_VOLUME',
  '$p.Play()',
  '$p.SpeedRatio = $rate',
  'Start-Sleep -Milliseconds ([int]($p.NaturalDuration.TimeSpan.TotalMilliseconds / $rate))',
  '$p.Close()',
];

function atempo(rate) {
  const parts = [];
  let r = rate;
  while (r < 0.5) {
    parts.push('atempo=0.5');
    r /= 0.5;
  }
  parts.push(`atempo=${r}`);
  return parts.join(',');
}

export function players(platform, file, { volume = 1, rate = 1 } = {}) {
  if (platform === 'darwin') return [{ file: 'afplay', args: [file] }];
  if (platform === 'win32') {
    return ['powershell.exe', 'pwsh.exe'].map((exe) => ({
      file: exe,
      args: encoded(PLAY_PS),
      env: {
        SLICC_AUDIO_FILE: resolve(file),
        SLICC_AUDIO_VOLUME: String(volume),
        SLICC_AUDIO_RATE: String(rate),
      },
    }));
  }
  const list = [];
  if (rate === 1) {
    list.push({
      file: 'paplay',
      args: [...(volume === 1 ? [] : [`--volume=${Math.round(volume * 65536)}`]), file],
    });
    list.push({
      file: 'pw-play',
      args: [...(volume === 1 ? [] : ['--volume', String(volume)]), file],
    });
    if (volume === 1) list.push({ file: 'aplay', args: ['-q', file] });
  }
  list.push({
    file: 'ffplay',
    args: [
      '-nodisp',
      '-autoexit',
      '-loglevel',
      'error',
      ...(volume === 1 ? [] : ['-volume', String(Math.round(volume * 100))]),
      ...(rate === 1 ? [] : ['-af', atempo(rate)]),
      file,
    ],
  });
  return list;
}

export async function playFile({ name, file, options = {}, raw, platform, env, fds }) {
  const list = players(platform, file, options);
  const found = first(
    list.map((p) => p.file),
    platform,
    env
  );
  if (!found)
    throw new Failure(`no audio player found (tried ${list.map((p) => p.file).join(', ')})`);
  const tool = list.find((p) => p.file === found.file);
  const args = platform === 'darwin' && raw ? raw : tool.args;
  if (options.debug && platform !== 'darwin')
    write(fds[2], `${name}: ${tool.file} ${args.join(' ')}\n`);
  const result = await exec(found.path, args, {
    env: tool.env ? { ...env, ...tool.env } : env,
    stdin: 'ignore',
    stdout: fds[1],
    stderr: fds[2],
    seconds: platform === 'darwin' ? undefined : options.time,
  });
  if (result.error) throw new Failure(`${tool.file}: ${result.error.message}`);
  if (result.code !== 0) throw new Failure(`${tool.file} failed (exit ${result.code})`);
}

const PLAY_SPEC = [
  { flags: ['-h', '--help', '-help'], key: 'help' },
  { flags: ['-v', '--volume'], key: 'volume', value: true },
  { flags: ['-t', '--time'], key: 'time', value: true },
  { flags: ['-r', '--rate'], key: 'rate', value: true },
  { flags: ['-q', '--rQuality'], key: 'quality', value: true },
  { flags: ['-d', '--debug'], key: 'debug' },
  { flags: ['--leaks'], key: 'leaks' },
];

export function report(name, error, usage, fds) {
  if (error instanceof UsageError) {
    write(fds[2], `${name}: ${error.message}\n${usage}`);
    return 2;
  }
  if (error instanceof Failure) {
    write(fds[2], `${name}: ${error.message}\n`);
    return 1;
  }
  throw error;
}

export async function scplay({ name = 'scplay', argv, env, platform, fds }) {
  const usage = `usage: ${name} [-v volume] [-t time] [-r rate] [-q quality] [-d] file\n`;
  try {
    const m = await meta({ name, argv, env, platform, fds });
    if (m?.usage) throw new UsageError(m.usage);
    if (m) return m.code;
    const { opts, rest } = parseArgs(argv, PLAY_SPEC);
    if (opts.help) {
      write(fds[1], usage);
      return 0;
    }
    if (opts.leaks && platform !== 'darwin') throw unsupported('--leaks', platform);
    const options = {
      volume: opts.volume === undefined ? 1 : number('-v', opts.volume, 0, 1),
      rate: opts.rate === undefined ? 1 : number('-r', opts.rate, 0.25, 4),
      time:
        opts.time === undefined ? undefined : number('-t', opts.time, 0, 86400, { above: true }),
      quality: opts.quality === undefined ? 0 : number('-q', opts.quality, 0, 1),
      debug: !!opts.debug,
    };
    if (!Number.isInteger(options.quality)) throw new UsageError(`-q ${opts.quality}: 0 or 1`);
    if (rest.length !== 1) throw new UsageError(rest.length ? 'only one file' : 'no file');
    const file = rest[0];
    if (!existsSync(file)) throw new Failure(`cannot open ${file}: No such file`);
    await playFile({ name, file, options, raw: argv, platform, env, fds });
    return 0;
  } catch (error) {
    return report(name, error, usage, fds);
  }
}

export async function scchime({ name = 'scchime', argv, env, platform, fds }) {
  const usage = `usage: ${name}\n`;
  try {
    const m = await meta({ name, argv, env, platform, fds });
    if (m?.usage) throw new UsageError(m.usage);
    if (m) return m.code;
    const { opts, rest } = parseArgs(argv, [{ flags: ['-h', '--help'], key: 'help' }]);
    if (opts.help) {
      write(fds[1], usage);
      return 0;
    }
    if (rest.length) throw new UsageError(`unexpected argument: ${rest[0]}`);
    const tmp = scratch();
    try {
      const file = tmp.file('chime.wav');
      writeFileSync(file, chime());
      await playFile({ name, file, platform, env, fds });
    } finally {
      tmp.done();
    }
    return 0;
  } catch (error) {
    return report(name, error, usage, fds);
  }
}
