import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import {
  encoded,
  exec,
  Failure,
  failed,
  first,
  lookup,
  parseArgs,
  scratch,
  lang as tag,
  UsageError,
  unsupported,
  write,
} from './common.mjs';
import {
  checked,
  kokoroVoice,
  listed,
  loadOrtllama,
  matchVoice,
  models,
  offline,
  ollamaBase,
  ortllamaMissing,
  ortllamaStatus,
  ortllamaTools,
  ortllamaVoices,
  speech,
  status,
  Unavailable,
  warm,
  warmOrtllama,
  withOrtllama,
} from './engines.mjs';
import { playFile, report } from './play.mjs';
import { meta, metaFlags, noMeta } from './upgrade.mjs';
import {
  convert,
  dataFormat,
  dataFormatList,
  decodeWav,
  encode,
  fileFormat,
  fileFormatList,
  formatOf,
  resample,
} from './wav.mjs';

const SPEC = [
  { flags: ['-h', '--help'], key: 'help' },
  { flags: ['-v', '--voice'], key: 'voice', value: true },
  { flags: ['-r', '--rate'], key: 'rate', value: true },
  { flags: ['-l', '--lang'], key: 'lang', value: true },
  { flags: ['-o', '--output-file', '--out'], key: 'output', value: true },
  { flags: ['--file-format'], key: 'fileFormat', value: true },
  { flags: ['--data-format'], key: 'dataFormat', value: true },
  { flags: ['--channels'], key: 'channels', value: true },
  { flags: ['-i', '--interactive'], key: 'interactive', value: 'optional' },
  { flags: ['-f', '--input-file'], key: 'input', value: true },
  { flags: ['--list'], key: 'list' },
  { flags: ['--status'], key: 'status' },
  { flags: ['--warmup'], key: 'warmup' },
  { flags: ['--engine'], key: 'engine', value: true },
  { flags: ['--model'], key: 'model', value: true },
  { flags: ['-n', '--network-send'], key: 'network', value: true },
  { flags: ['-a', '--audio-device'], key: 'device', value: true },
  { flags: ['--progress'], key: 'progress' },
  { flags: ['--bit-rate'], key: 'bitRate', value: true },
  { flags: ['--quality'], key: 'quality', value: true },
];

const PASS = new Set([
  'voice',
  'output',
  'fileFormat',
  'dataFormat',
  'channels',
  'interactive',
  'network',
  'device',
  'progress',
  'bitRate',
  'quality',
]);

const MAC_ONLY = [
  ['network', '-n'],
  ['device', '-a'],
  ['progress', '--progress'],
  ['bitRate', '--bit-rate'],
  ['quality', '--quality'],
];

export const ENGINES = ['platform', 'ortllama', 'ollama'];

const SAY_PS = [
  'Add-Type -AssemblyName System.Speech',
  '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
  "if ($env:SLICC_AUDIO_MODE -eq 'list') {",
  '  foreach ($v in $s.GetInstalledVoices()) {',
  '    $i = $v.VoiceInfo',
  '    [Console]::Out.WriteLine($i.Name + "`t" + $i.Culture.Name)',
  '  }',
  '  exit 0',
  '}',
  '$in = [Console]::OpenStandardInput()',
  '$buffer = New-Object System.IO.MemoryStream',
  '$in.CopyTo($buffer)',
  '$text = (New-Object System.Text.UTF8Encoding $false).GetString($buffer.ToArray())',
  'if ($env:SLICC_AUDIO_VOICE) { $s.SelectVoice($env:SLICC_AUDIO_VOICE) }',
  'if ($env:SLICC_AUDIO_RATE) { $s.Rate = [int]$env:SLICC_AUDIO_RATE }',
  'if ($env:SLICC_AUDIO_OUT) { $s.SetOutputToWaveFile($env:SLICC_AUDIO_OUT) } else { $s.SetOutputToDefaultAudioDevice() }',
  '$s.Speak($text)',
  '$s.Dispose()',
];

function usageOf(name) {
  return (
    `usage: ${name} [-v voice] [-r rate] [-l lang] [-o file [--file-format=fmt] [--data-format=fmt] [--channels=n]] [-i] [-f file | text ...]\n` +
    `       ${name} -v '?' | --list | --status | --warmup\n`
  );
}

export function rateOf(value) {
  const n = Number(value);
  if (value !== '' && Number.isFinite(n) && n >= 0.1 && n <= 10) return n;
  if (value !== '' && Number.isFinite(n) && n > 10 && n <= 1000) return n / 175;
  throw new UsageError(`-r ${value}: a multiple from 0.1 to 10, or words per minute up to 1000`);
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

function locale(value) {
  return value.replace('-', '_');
}

function macParse(text) {
  const voices = [];
  for (const line of text.split('\n')) {
    const m = /^(.+?)\s+([a-z]{2,3}_[A-Za-z0-9]+)\s+#\s?(.*)$/.exec(line);
    if (m) voices.push({ name: m[1], lang: m[2], sample: m[3] });
  }
  return voices;
}

function spdParse(text) {
  return text
    .split('\n')
    .slice(1)
    .map((line) => /^\s*(.+?)\s+(\S+)\s+(\S+)\s*$/.exec(line))
    .filter(Boolean)
    .map((m) => ({ name: m[1], lang: locale(m[2]) }));
}

function espeakParse(text) {
  return text
    .split('\n')
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter((cols) => cols.length >= 5)
    .map((cols) => ({ name: cols[3], lang: locale(cols[1]) }));
}

function winParse(text) {
  return text
    .split(/\r?\n/)
    .filter((line) => line.includes('\t'))
    .map((line) => {
      const [name, culture] = line.split('\t');
      return { name, lang: locale(culture) };
    });
}

function byLocale(voices, wanted) {
  const want = locale(wanted).toLowerCase();
  return (
    voices.find((v) => v.lang.toLowerCase() === want) ??
    voices.find((v) => v.lang.toLowerCase().split('_')[0] === want.split('_')[0])
  );
}

function platformTool(ctx) {
  const { platform, env, output } = ctx;
  if (platform === 'darwin') {
    const path = lookup('say', platform, env);
    if (!path) throw new Unavailable('say not found');
    return { file: 'say', path };
  }
  if (platform === 'win32') {
    const path = lookup('powershell.exe', platform, env);
    if (!path) throw new Unavailable('powershell.exe not found');
    return { file: 'powershell.exe', path };
  }
  const found = first(
    output ? ['espeak-ng', 'espeak'] : ['spd-say', 'espeak-ng', 'espeak'],
    platform,
    env
  );
  if (found) return found;
  throw new Unavailable(
    output
      ? "espeak-ng and espeak not found, and spd-say can't write a file (install espeak-ng)"
      : 'spd-say, espeak-ng and espeak not found (install espeak-ng or speech-dispatcher)'
  );
}

async function platformVoices(ctx, tool) {
  const { env } = ctx;
  let args = [];
  let parse = espeakParse;
  let extra = {};
  if (tool.file === 'say') {
    args = ['-v', '?'];
    parse = macParse;
  } else if (tool.file === 'spd-say') {
    args = ['-L'];
    parse = spdParse;
  } else if (tool.file === 'powershell.exe') {
    args = encoded(SAY_PS);
    parse = winParse;
    extra = { SLICC_AUDIO_MODE: 'list' };
  } else args = ['--voices'];
  const result = await exec(tool.path, args, { env: { ...env, ...extra } });
  if (result.code !== 0) throw failed(ctx.name, tool.file, result);
  return parse(result.stdout.toString('utf8'));
}

async function deliver(ctx, wav) {
  const { output, fds, data, channels } = ctx;
  if (output.path === '-') {
    write(
      fds[1],
      convert(wav, { format: 'WAVE', data: { ...dataFormat(data, 'WAVE') }, channels })
    );
    return;
  }
  writeFileSync(
    output.path,
    convert(wav, { format: output.format, data: dataFormat(data, output.format), channels })
  );
}

async function speakWav(ctx, wav) {
  const tmp = scratch();
  try {
    const file = tmp.file('speech.wav');
    writeFileSync(file, wav);
    await playFile({ name: ctx.name, file, platform: ctx.platform, env: ctx.env, fds: ctx.fds });
  } finally {
    tmp.done();
  }
}

async function macSpeak(ctx, tool, text) {
  const { args: given, voice, lang, rate, env, fds, output } = ctx;
  const args = [];
  for (const entry of given) {
    if (entry.key === 'rate') args.push('-r', String(Math.round(rate * 175)));
    else if (output?.path === '-' && ['output', 'fileFormat', 'dataFormat'].includes(entry.key))
      continue;
    else if (PASS.has(entry.key)) args.push(...entry.raw);
  }
  if (lang && !voice) {
    const pick = byLocale(await platformVoices(ctx, tool), lang);
    if (!pick) throw new Failure(`no say voice for ${lang}`);
    args.push('-v', pick.name);
  }
  const tmp = output?.path === '-' ? scratch() : undefined;
  try {
    if (tmp) args.push('-o', tmp.file('speech.wav'), '--file-format=WAVE', '--data-format=LEI16');
    args.push('-f', '-');
    const result = await exec(tool.path, args, {
      env,
      input: text,
      stdout: fds[1],
      stderr: fds[2],
    });
    if (result.code !== 0) throw failed(ctx.name, 'say', result);
    if (tmp) await deliver(ctx, readFileSync(tmp.file('speech.wav')));
  } finally {
    tmp?.done();
  }
}

async function unixSpeak(ctx, tool, text) {
  const { rate, voice, lang, env, fds, output } = ctx;
  let name;
  if (voice) {
    const pick = matchVoice(await platformVoices(ctx, tool), voice);
    if (!pick) throw new Failure(`voice "${voice}" not found (${ctx.name} -v '?' lists them)`);
    name = pick.name;
  }
  const tmp = output ? scratch() : undefined;
  try {
    let args;
    let input;
    if (tool.file === 'spd-say') {
      args = ['-w'];
      if (rate !== undefined)
        args.push('-r', String(clamp(Math.round((rate - 1) * 100), -100, 100)));
      if (name) args.push('-y', name);
      else if (lang) args.push('-l', lang);
      args.push('--', text);
    } else {
      args = ['--stdin'];
      if (rate !== undefined) args.push('-s', String(clamp(Math.round(175 * rate), 80, 450)));
      if (name) args.push('-v', name);
      else if (lang) args.push('-v', lang.toLowerCase());
      if (tmp) args.push('-w', tmp.file('speech.wav'));
      input = text;
    }
    const result = await exec(tool.path, args, { env, input, stdout: 'ignore', stderr: fds[2] });
    if (result.code !== 0) throw failed(ctx.name, tool.file, result);
    if (tmp) await deliver(ctx, readFileSync(tmp.file('speech.wav')));
  } finally {
    tmp?.done();
  }
}

async function winSpeak(ctx, tool, text) {
  const { rate, voice, lang, env, fds, output } = ctx;
  const extra = { SLICC_AUDIO_MODE: 'speak' };
  if (voice || lang) {
    const voices = await platformVoices(ctx, tool);
    const pick = voice ? matchVoice(voices, voice) : byLocale(voices, lang);
    if (!pick) {
      throw new Failure(
        voice
          ? `voice "${voice}" not found (${ctx.name} -v '?' lists them)`
          : `no installed voice for ${lang}`
      );
    }
    extra.SLICC_AUDIO_VOICE = pick.name;
  }
  if (rate !== undefined) {
    extra.SLICC_AUDIO_RATE = String(
      clamp(Math.round(10 * (Math.log(rate) / Math.log(3))), -10, 10)
    );
  }
  const tmp = output ? scratch() : undefined;
  try {
    if (tmp) extra.SLICC_AUDIO_OUT = tmp.file('speech.wav');
    const result = await exec(tool.path, encoded(SAY_PS), {
      env: { ...env, ...extra },
      input: text,
      stdout: 'ignore',
      stderr: fds[2],
    });
    if (result.code !== 0) throw failed(ctx.name, tool.file, result);
    if (tmp) await deliver(ctx, readFileSync(tmp.file('speech.wav')));
  } finally {
    tmp?.done();
  }
}

export const MAX_INPUT = 4096;

export function chunks(text, max = MAX_INPUT) {
  const out = [];
  let current = '';
  const push = (piece) => {
    if (current.length + piece.length > max && current) {
      out.push(current);
      current = '';
    }
    current += piece;
  };
  for (const sentence of text.match(/[^.!?\n]*[.!?\n]*\s*/g)) {
    if (sentence.length <= max) {
      push(sentence);
      continue;
    }
    for (const word of sentence.match(/\S*\s*/g)) {
      for (let at = 0; at < word.length; at += max) push(word.slice(at, at + max));
    }
  }
  if (current.trim()) out.push(current);
  return out;
}

async function synth(line, request) {
  const parts = chunks(line);
  if (parts.length === 1) return request(parts[0]);
  const decoded = [];
  for (const part of parts) decoded.push(decodeWav(await request(part)));
  const rate = decoded[0].rate;
  const samples = decoded.map((d) => resample(d.samples, d.rate, rate));
  const all = new Float32Array(samples.reduce((n, s) => n + s.length, 0));
  let at = 0;
  for (const s of samples) {
    all.set(s, at);
    at += s.length;
  }
  return encode(all, {
    format: 'WAVE',
    data: { endian: 'LE', kind: 'F', bits: 32 },
    channels: 1,
    rate,
  });
}

function lines(ctx, text) {
  return ctx.interactive && !ctx.output ? text.split(/\r?\n/).filter((l) => l.trim()) : [text];
}

const engines = {
  platform: {
    async speak(ctx, text) {
      const tool = platformTool(ctx);
      if (tool.file === 'say') return macSpeak(ctx, tool, text);
      for (const line of lines(ctx, text)) {
        if (ctx.interactive && !ctx.output) write(ctx.fds[1], `${line}\n`);
        if (tool.file === 'powershell.exe') await winSpeak(ctx, tool, line);
        else await unixSpeak(ctx, tool, line);
      }
    },
    async voices(ctx) {
      return platformVoices(ctx, platformTool(ctx));
    },
    async status(ctx) {
      try {
        return `ready (${platformTool(ctx).file})`;
      } catch (error) {
        return `unavailable (${error.message})`;
      }
    },
    async tools(ctx) {
      platformTool(ctx);
    },
    async warmup() {
      return 0;
    },
  },
  ortllama: {
    async speak(ctx, text) {
      await withOrtllama(ctx.ortllama, ctx.env, async (base) => {
        const voice = await kokoroChoice(ctx, base);
        for (const line of lines(ctx, text)) {
          const request = {
            input: line,
            voice,
            speed: clamp(ctx.rate ?? 1, 0.25, 4),
            response_format: 'wav',
          };
          if (ctx.model) request.model = ctx.model;
          const wav = await synth(line, async (input) => {
            const res = await speech(base, { ...request, input });
            return checked(res, () => ortllamaMissing(res));
          });
          if (ctx.interactive && !ctx.output) write(ctx.fds[1], `${line}\n`);
          if (ctx.output) await deliver(ctx, wav);
          else await speakWav(ctx, wav);
        }
      });
    },
    async voices(ctx) {
      return withOrtllama(ctx.ortllama, ctx.env, (base) => ortllamaVoices(base, ctx.model));
    },
    async status(ctx) {
      try {
        const state = await withOrtllama(ctx.ortllama, ctx.env, (base) => ortllamaState(ctx, base));
        return state.ready ? `ready (${state.ready})` : `not cached (${state.missing})`;
      } catch (error) {
        if (error instanceof Unavailable) return error.status;
        throw error;
      }
    },
    async tools(ctx) {
      await ortllamaTools(ctx.ortllama, ctx.env);
    },
    async warmup(ctx) {
      const state = await withOrtllama(ctx.ortllama, ctx.env, (base) => ortllamaState(ctx, base));
      if (state.ready) {
        write(ctx.fds[1], `ortllama: ready (${state.ready})\n`);
        return 0;
      }
      return warmOrtllama({
        name: ctx.name,
        command: state.missing,
        platform: ctx.platform,
        env: ctx.env,
        fds: ctx.fds,
      });
    },
  },
  ollama: {
    async speak(ctx, text) {
      const base = ollamaBase(ctx.env);
      const model = ctx.model ?? 'phonon';
      for (const line of lines(ctx, text)) {
        const request = {
          model,
          input: line,
          voice: ctx.voice ?? 'default',
          response_format: 'wav',
        };
        if ((ctx.rate ?? 1) !== 1) request.speed = clamp(ctx.rate, 0.25, 4);
        const wav = await synth(line, async (input) => {
          const res = await speech(base, { ...request, input });
          if (res.offline) throw offline(base);
          return checked(res, () => new Unavailable(`model not pulled (ollama pull ${model})`));
        });
        if (ctx.interactive && !ctx.output) write(ctx.fds[1], `${line}\n`);
        if (ctx.output) await deliver(ctx, wav);
        else await speakWav(ctx, wav);
      }
    },
    async voices(ctx) {
      await engines.ollama.tools(ctx);
      return [{ name: 'default', lang: 'en_US', default: true }];
    },
    async status(ctx) {
      const base = ollamaBase(ctx.env);
      const model = ctx.model ?? 'phonon';
      const list = await models(base);
      if (list.offline) return offline(base).message;
      if (list.data && listed(list.data, model)) return `ready (${model} at ${base})`;
      return `model not pulled (ollama pull ${model})`;
    },
    async tools(ctx) {
      const base = ollamaBase(ctx.env);
      if ((await models(base)).offline) throw offline(base);
    },
    async warmup(ctx) {
      const state = await engines.ollama.status(ctx);
      if (state.startsWith('ready')) {
        write(ctx.fds[1], `ollama: ${state}\n`);
        return 0;
      }
      write(ctx.fds[1], `ollama pull ${ctx.model ?? 'phonon'}\n`);
      return 1;
    },
  },
};

async function ortllamaState(ctx, base) {
  return ortllamaStatus(base, {
    role: 'speech',
    model: ctx.model,
    probe: () => speech(base, { model: ctx.model ?? 'speech', input: ' ', response_format: 'wav' }),
  });
}

async function kokoroChoice(ctx, base) {
  if (ctx.voice) {
    const voices = await ortllamaVoices(base, ctx.model);
    if (!voices.length) return ctx.voice;
    const pick = matchVoice(voices, ctx.voice);
    if (!pick) throw new Failure(`voice "${ctx.voice}" not found (${ctx.name} -v '?' lists them)`);
    return pick.name;
  }
  if (ctx.lang) {
    const voice = kokoroVoice(ctx.lang);
    if (!voice) throw new Unavailable(`no Kokoro voice for ${ctx.lang}`);
    return voice;
  }
  return 'af_heart';
}

function noEngine(ctx, reasons) {
  return new Failure(
    [`no speech engine available`, ...reasons.map(([engine, why]) => `  ${engine}: ${why}`)].join(
      '\n'
    )
  );
}

function readText(ctx, rest, opts) {
  if (rest.length) return rest.join(' ');
  if (opts.input !== undefined && opts.input !== '-') {
    if (!existsSync(opts.input)) throw new Failure(`cannot open ${opts.input}: No such file`);
    return readFileSync(opts.input, 'utf8');
  }
  return readFileSync(ctx.fds[0], 'utf8');
}

async function listVoices(ctx, opts) {
  const errors = [];
  for (const engine of ctx.engines) {
    if (engine === 'platform' && ctx.platform === 'darwin' && opts.voice === '?') {
      let tool;
      try {
        tool = platformTool(ctx);
      } catch (error) {
        errors.push([engine, error.message]);
        continue;
      }
      const result = await exec(tool.path, ['-v', '?'], {
        env: ctx.env,
        stdout: ctx.fds[1],
        stderr: ctx.fds[2],
      });
      if (result.code !== 0) throw failed(ctx.name, 'say', result);
      return 0;
    }
    let voices;
    try {
      voices = await engines[engine].voices(ctx);
    } catch (error) {
      if (!(error instanceof Unavailable)) throw error;
      errors.push([engine, error.message]);
      continue;
    }
    const out = voices.map((v) => {
      if (opts.voice === '?') {
        return `${v.name.padEnd(19)} ${v.lang.padEnd(8)} # Hello, my name is ${v.name}.\n`;
      }
      return `${v.name} (${v.lang.replace('_', '-')}) [${engine}]${v.default ? ' [default]' : ''}\n`;
    });
    write(ctx.fds[1], out.join(''));
    return 0;
  }
  throw noEngine(ctx, errors);
}

function engineOf(opts, env) {
  const engine = opts.engine ?? env.SLICC_AUDIO_ENGINE;
  if (engine !== undefined && engine !== '' && !ENGINES.includes(engine)) {
    throw new UsageError(`--engine ${engine}: one of ${ENGINES.join(', ')}`);
  }
  return engine || undefined;
}

function channelsOf(value) {
  if (value === undefined) return 1;
  if (value !== '1' && value !== '2') throw new UsageError(`--channels ${value}: 1 or 2`);
  return Number(value);
}

function outputOf(opts, mac) {
  if (opts.output === undefined) {
    if (!mac && (opts.fileFormat ?? opts.dataFormat ?? opts.channels) !== undefined) {
      throw new UsageError('--file-format, --data-format and --channels need -o');
    }
    return undefined;
  }
  if (opts.output === '-') {
    dataFormat(opts.dataFormat, 'WAVE');
    return { path: '-', format: 'WAVE' };
  }
  if (mac) return formatOf(opts.output, opts.fileFormat);
  const output = formatOf(opts.output, opts.fileFormat && fileFormat(opts.fileFormat));
  dataFormat(opts.dataFormat, output.format);
  return output;
}

function contextOf(base, opts, order) {
  const { env, platform } = base;
  const mac = platform === 'darwin';
  if (!mac)
    for (const [key, flag] of MAC_ONLY)
      if (opts[key] !== undefined) throw unsupported(flag, platform);
  const engine = engineOf(opts, env);
  return {
    ...base,
    args: order,
    engine,
    engines: engine ? [engine] : ENGINES,
    voice: opts.voice === '?' ? undefined : opts.voice,
    rate: opts.rate === undefined ? undefined : rateOf(opts.rate),
    lang: opts.lang === undefined ? undefined : tag(opts.lang),
    interactive: opts.interactive !== undefined,
    model: opts.model ?? (env.SLICC_AUDIO_MODEL || undefined),
    data: opts.dataFormat,
    channels: channelsOf(opts.channels),
  };
}

async function formats(ctx, opts) {
  const { platform, env, fds, engine } = ctx;
  const say =
    platform === 'darwin' &&
    engine !== 'ortllama' &&
    engine !== 'ollama' &&
    lookup('say', platform, env);
  if (say) {
    const args = ctx.args
      .filter((e) => e.key === 'fileFormat' || e.key === 'dataFormat')
      .flatMap((e) => e.raw);
    const result = await exec(say, args, { env, stdout: fds[1], stderr: fds[2] });
    return result.code === 0 ? 0 : 1;
  }
  if (opts.fileFormat === '?') write(fds[1], fileFormatList());
  else write(fds[1], dataFormatList(opts.fileFormat && fileFormat(opts.fileFormat)));
  return 0;
}

async function speakWith(ctx, text) {
  const reasons = [];
  for (const e of ctx.engines) {
    try {
      await engines[e].speak(ctx, text);
      return 0;
    } catch (error) {
      if (!(error instanceof Unavailable)) throw error;
      reasons.push([e, error.message]);
    }
  }
  throw noEngine(ctx, reasons);
}

async function main(base, argv) {
  const { opts, order, rest } = parseArgs(argv, [...SPEC, metaFlags()]);
  if (opts.help) {
    write(base.fds[1], usageOf(base.name));
    return 0;
  }
  noMeta(opts, order);
  const ctx = contextOf(base, opts, order);
  if (opts.fileFormat === '?' || opts.dataFormat === '?') return formats(ctx, opts);
  ctx.output = outputOf(opts, base.platform === 'darwin');
  if (opts.voice === '?' || opts.list) return listVoices(ctx, opts);
  if (opts.status) return status(engines, ctx);
  if (opts.warmup) return warm(engines, ctx, (reasons) => noEngine(ctx, reasons));
  const text = readText(ctx, rest, opts);
  if (!text.trim()) return 0;
  return speakWith(ctx, text);
}

export async function scsay({ name = 'scsay', argv, env, platform, fds, ortllama = loadOrtllama }) {
  try {
    const m = await meta({ name, argv, env, platform, fds });
    if (m.code !== undefined) return m.code;
    return await main({ name, env: m.env, platform, fds, ortllama }, argv);
  } catch (error) {
    return report(name, error, usageOf(name), fds);
  }
}
