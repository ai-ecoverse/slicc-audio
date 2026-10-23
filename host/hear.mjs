import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { Failure, number, parseArgs, scratch, lang as tag, UsageError, write } from './common.mjs';
import {
  checked,
  listed,
  loadOrtllama,
  loopback,
  models,
  offline,
  ollamaBase,
  ortllamaMissing,
  ortllamaStatus,
  ortllamaTools,
  serve,
  status,
  transcription,
  Unavailable,
  warm,
  warmOrtllama,
  withOrtllama,
} from './engines.mjs';
import { devices, ffmpegOf, record, source } from './mic.mjs';
import { report } from './play.mjs';
import { meta, metaFlags, noMeta } from './upgrade.mjs';
import { chime } from './wav.mjs';
import {
  ensureModel,
  modelPath,
  toWav,
  whisperHints,
  whisperRun,
  whisperTools,
} from './whisper.mjs';

const SPEC = [
  { flags: ['-h', '--help'], key: 'help' },
  { flags: ['-i', '--input', '--file'], key: 'input', value: true },
  { flags: ['-l', '--locale'], key: 'lang', value: true },
  { flags: ['-T', '-t', '--timeout'], key: 'timeout', value: true },
  { flags: ['-d', '-n', '--input-device-id'], key: 'device', value: true },
  { flags: ['-x', '--exit'], key: 'exit', value: true },
  { flags: ['-m', '--mode'], key: 'mode' },
  { flags: ['-p', '--punctuation'], key: 'punctuation' },
  { flags: ['--timestamps'], key: 'timestamps' },
  { flags: ['-S', '--subtitle'], key: 'subtitle' },
  { flags: ['--device'], key: 'onDevice' },
  { flags: ['--engine'], key: 'engine', value: true },
  { flags: ['--model'], key: 'model', value: true },
  { flags: ['-a', '--audio-input-devices', '--devices'], key: 'devices' },
  { flags: ['-s', '--supported'], key: 'supported' },
  { flags: ['--status'], key: 'status' },
  { flags: ['--warmup'], key: 'warmup' },
];

export const ENGINES = ['whisper', 'ortllama', 'ollama'];

export const LANGUAGES =
  'en zh de es ru ko fr ja pt tr pl ca nl ar sv it id hi fi vi he uk el ms cs ro da hu ta no th ur hr bg lt la mi ml cy sk te fa lv bn sr az sl kn et mk br eu is hy ne mn bs kk sq sw gl mr pa si km sn yo so af oc ka be tg sd gu am yi lo uz fo ht ps tk nn mt sa lb my bo tl mg as tt haw ln ha ba jw su yue'.split(
    ' '
  );

function usageOf(name) {
  return (
    `usage: ${name} [-i file] [-l lang] [-T seconds] [-d device] [-x word] [-m] [-p] [--timestamps | -S] [--device]\n` +
    `       ${name} -a | -s | --status | --warmup\n`
  );
}

function stamp(seconds) {
  const ms = Math.round(seconds * 1000);
  const h = String(Math.floor(ms / 3600000)).padStart(2, '0');
  const m = String(Math.floor(ms / 60000) % 60).padStart(2, '0');
  const s = String(Math.floor(ms / 1000) % 60).padStart(2, '0');
  return `${h}:${m}:${s}.${String(ms % 1000).padStart(3, '0')}`;
}

function format(ctx) {
  if (ctx.subtitle) return 'srt';
  return ctx.timestamps ? 'verbose_json' : 'json';
}

function fromApi(ctx, body) {
  const kind = format(ctx);
  if (kind === 'srt') return { srt: body.toString('utf8') };
  let json;
  try {
    json = JSON.parse(body.toString('utf8'));
  } catch {
    throw new Failure('the server answered with something other than JSON');
  }
  if (kind === 'verbose_json') {
    return {
      lines: (json.segments ?? [])
        .filter((s) => s.text?.trim())
        .map((s) => `[${stamp(s.start)} --> ${stamp(s.end)}] ${s.text.trim()}`),
    };
  }
  return {
    lines: String(json.text ?? '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean),
  };
}

const engines = {
  whisper: {
    async open(ctx) {
      const tools = whisperTools(ctx.platform, ctx.env);
      const model = await ensureModel(ctx);
      return {
        async transcribe(file, recorded) {
          const tmp = scratch();
          try {
            let wav = file;
            if (!recorded) {
              wav = tmp.file('input.wav');
              await toWav({
                name: ctx.name,
                ffmpeg: tools.ffmpeg,
                input: file,
                output: wav,
                env: ctx.env,
              });
            }
            return await whisperRun({
              name: ctx.name,
              cli: tools.cli,
              model,
              wav,
              language: ctx.language,
              format: format(ctx),
              env: ctx.env,
            });
          } finally {
            tmp.done();
          }
        },
        close() {},
      };
    },
    async status(ctx) {
      let tools;
      try {
        tools = whisperTools(ctx.platform, ctx.env);
      } catch (error) {
        return error.message;
      }
      const where = modelPath(ctx.model, ctx.platform, ctx.env);
      if (!existsSync(where.path)) return `model not downloaded (${ctx.name} --warmup)`;
      return `ready (${tools.cli.file}, ${tools.ffmpeg.file}, ${basename(where.path)})`;
    },
    async tools(ctx) {
      whisperTools(ctx.platform, ctx.env);
    },
    async warmup(ctx) {
      await ensureModel(ctx);
      write(ctx.fds[1], `whisper: ${await engines.whisper.status(ctx)}\n`);
      return 0;
    },
  },
  ortllama: {
    async open(ctx) {
      const server = await serve(ctx.ortllama, ctx.env);
      try {
        const state = await ortllamaState(ctx, server.url);
        if (state.missing) throw new Unavailable(`model not cached (${state.missing})`);
      } catch (error) {
        await server.close();
        throw error;
      }
      return {
        async transcribe(file) {
          const res = await transcription(server.url, request(ctx, file));
          return fromApi(
            ctx,
            checked(res, () => ortllamaMissing(res))
          );
        },
        close: () => server.close(),
      };
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
    async open(ctx) {
      const base = ollamaBase(ctx.env);
      if (ctx.onDevice && !loopback(base))
        throw new Unavailable(`${base} isn't on this device (--device)`);
      if (!ctx.model) {
        throw new Unavailable(
          `needs --model, a transcription model on a server at ${base} with /v1/audio/transcriptions`
        );
      }
      const list = await models(base);
      if (list.offline) throw offline(base);
      if (list.data && !listed(list.data, ctx.model))
        throw new Unavailable(`model not pulled (ollama pull ${ctx.model})`);
      return {
        async transcribe(file) {
          const res = await transcription(base, request(ctx, file));
          if (res.offline) throw offline(base);
          const body = checked(
            res,
            () => new Unavailable(`no /v1/audio/transcriptions for ${ctx.model} at ${base}`)
          );
          return fromApi(ctx, body);
        },
        close() {},
      };
    },
    async status(ctx) {
      const base = ollamaBase(ctx.env);
      const list = await models(base);
      if (list.offline) return offline(base).message;
      if (!ctx.model) return `needs --model (a transcription model at ${base})`;
      if (list.data && listed(list.data, ctx.model)) return `ready (${ctx.model} at ${base})`;
      return `model not pulled (ollama pull ${ctx.model})`;
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
      write(ctx.fds[1], `ollama pull ${ctx.model ?? '<model>'}\n`);
      return 1;
    },
  },
};

function request(ctx, file) {
  return {
    file: readFileSync(file),
    name: basename(file),
    model: ctx.model,
    language: ctx.language,
    format: format(ctx),
  };
}

async function ortllamaState(ctx, base) {
  return ortllamaStatus(base, {
    role: 'transcribe',
    model: ctx.model,
    probe: () =>
      transcription(base, {
        file: chime(),
        name: 'probe.wav',
        model: ctx.model ?? 'transcribe',
        format: 'json',
      }),
  });
}

function noEngine(reasons) {
  return new Failure(
    [
      'no recognition engine available',
      ...reasons.map(([engine, why]) => `  ${engine}: ${why}`),
    ].join('\n')
  );
}

function ending(line, word) {
  const words = line
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s'-]+$/u, '')
    .trim()
    .split(/\s+/);
  return words.at(-1) === word.toLowerCase().replace(/[^\p{L}\p{N}'-]+$/u, '');
}

function emit(ctx, result) {
  if (result.srt !== undefined) {
    if (!result.srt.trim()) return false;
    write(ctx.fds[1], result.srt.endsWith('\n') ? result.srt : `${result.srt}\n`);
    return true;
  }
  const lines = [];
  for (const line of result.lines) {
    lines.push(line);
    if (ctx.exit && ending(line, ctx.exit)) {
      ctx.stop = true;
      break;
    }
  }
  if (!lines.length) return false;
  write(ctx.fds[1], ctx.mode ? `${lines.join(' ')}\n` : `${lines.join('\n')}\n`);
  return true;
}

async function ensureOpen(ctx, state) {
  while (!state.open) {
    if (state.index >= ctx.engines.length) throw noEngine(state.reasons);
    const e = ctx.engines[state.index];
    try {
      state.open = await engines[e].open(ctx);
      state.engine = e;
    } catch (error) {
      if (!(error instanceof Unavailable)) throw error;
      state.reasons.push([e, error.message]);
      state.index++;
    }
  }
}

async function attempt(ctx, state, file, recorded) {
  for (;;) {
    await ensureOpen(ctx, state);
    try {
      return await state.open.transcribe(file, recorded);
    } catch (error) {
      if (!(error instanceof Unavailable)) throw error;
      state.reasons.push([state.engine, error.message]);
      await state.open.close();
      state.open = undefined;
      state.index++;
    }
  }
}

async function fromMic(ctx, state) {
  const ffmpeg = ffmpegOf(ctx.platform, ctx.env);
  await ensureOpen(ctx, state);
  const input = await source({ ...ctx, ffmpeg });
  const deadline = Date.now() + ctx.timeout * 1000;
  const tmp = scratch();
  let any = false;
  try {
    let n = 0;
    while (!ctx.stop) {
      const left = n === 0 ? ctx.timeout : Math.floor((deadline - Date.now()) / 100) / 10;
      if (left <= 0) break;
      const file = tmp.file(`mic-${n++}.wav`);
      const take = await record({
        name: ctx.name,
        ffmpeg,
        input,
        seconds: left,
        file,
        env: ctx.env,
      });
      if (take.spoke && existsSync(file) && emit(ctx, await attempt(ctx, state, file, true)))
        any = true;
      if (!ctx.exit || !take.paused) break;
    }
  } finally {
    tmp.done();
  }
  return any;
}

function contextOf(base, opts, rest) {
  if (rest.length) throw new UsageError(`unexpected argument: ${rest[0]}`);
  const engine = opts.engine ?? base.env.SLICC_AUDIO_ENGINE;
  if (engine !== undefined && engine !== '' && !ENGINES.includes(engine)) {
    throw new UsageError(`--engine ${engine}: one of ${ENGINES.join(', ')}`);
  }
  if (opts.timestamps && opts.subtitle) throw new UsageError('--timestamps and -S are exclusive');
  if ((opts.timestamps || opts.subtitle) && opts.input === undefined) {
    throw new UsageError(`${opts.subtitle ? '-S' : '--timestamps'} needs -i file`);
  }
  return {
    ...base,
    engines: engine ? [engine] : ENGINES,
    language: opts.lang === undefined ? undefined : tag(opts.lang).split('-')[0],
    timeout: opts.timeout === undefined ? 30 : number('-T', opts.timeout, 0, 600, { above: true }),
    exit: opts.exit,
    mode: !!opts.mode,
    timestamps: !!opts.timestamps,
    subtitle: !!opts.subtitle,
    onDevice: !!opts.onDevice,
    model: opts.model ?? (base.env.SLICC_AUDIO_MODEL || undefined),
    device: opts.device,
  };
}

async function listen(ctx, input) {
  const { platform, env, fds } = ctx;
  const tmp = scratch();
  try {
    let file = input;
    if (input === '-') {
      file = tmp.file('stdin');
      writeFileSync(file, readFileSync(fds[0]));
    } else if (input !== undefined && !existsSync(input)) {
      throw new Failure(`cannot open ${input}: No such file`);
    } else if (input === undefined && !ffmpegOf(platform, env)) {
      const why = `ffmpeg not found, which records the microphone (${whisperHints(platform).ffmpeg})`;
      throw noEngine(ctx.engines.map((e) => [e, why]));
    }
    const state = { index: 0, reasons: [] };
    let any;
    try {
      any = file ? emit(ctx, await attempt(ctx, state, file, false)) : await fromMic(ctx, state);
    } finally {
      await state.open?.close();
    }
    if (!any) throw new Failure('no speech detected');
    return 0;
  } finally {
    tmp.done();
  }
}

async function main(base, argv) {
  const { opts, order, rest } = parseArgs(argv, [...SPEC, metaFlags(['-v'])]);
  if (opts.help) {
    write(base.fds[1], usageOf(base.name));
    return 0;
  }
  noMeta(opts, order);
  const ctx = contextOf(base, opts, rest);
  const { name, platform, env, fds } = ctx;
  if (opts.supported) {
    write(fds[1], `${LANGUAGES.join('\n')}\n`);
    return 0;
  }
  if (opts.devices) {
    const list = await devices({ name, ffmpeg: ffmpegOf(platform, env), platform, env });
    write(fds[1], list.map(([id, label]) => `${id}\t${label}\n`).join(''));
    return 0;
  }
  if (opts.status) return status(engines, ctx);
  if (opts.warmup) return warm(engines, ctx, noEngine);
  return listen(ctx, opts.input);
}

export async function schear({
  name = 'schear',
  argv,
  env,
  platform,
  fds,
  ortllama = loadOrtllama,
}) {
  try {
    const m = await meta({ name, argv, env, platform, fds, version: ['-v'] });
    if (m.code !== undefined) return m.code;
    return await main({ name, env: m.env, platform, fds, ortllama }, argv);
  } catch (error) {
    return report(name, error, usageOf(name), fds);
  }
}
