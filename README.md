# slicc-audio

Audio commands for SLICC: `say` (text to speech), `hear` (speech to text), `afplay` (play a sound file) and `chime` (play a short notification sound), with the options of macOS `say` and `afplay` and of the [`hear`](https://github.com/sveinbjornt/hear) CLI wherever they make sense in a browser, plus [slicc 6](https://github.com/ai-ecoverse/slicc)'s extras.

`scsay`, `schear`, `scplay` and `scchime` are the same four commands under names that never shadow a host's own `say` or `afplay`. In SLICC they are `say`, `hear`, `afplay` and `chime`; on macOS, Linux and Windows they hand off to the platform's own tools, and when those are missing, to [whisper.cpp](https://github.com/ggml-org/whisper.cpp), [slicc-ortllama](https://github.com/ai-ecoverse/slicc-ortllama) or [Ollama](https://ollama.com) (see [On a host](#on-a-host)).

This README is the spec. The host commands (`scsay`, `schear`, `scplay`, `scchime` in `host/`) and the installers are implemented; the SLICC commands wait for the page bridge ([below](#commands)).

## Install

On macOS and Linux:

```sh
curl -fsSL https://get.sliccy.ai/slicc-audio | sh
```

On Windows, in PowerShell:

```powershell
irm https://get.sliccy.ai/slicc-audio.ps1 | iex
```

The same installers from the GitHub release, if the short URLs are unreachable:

```sh
curl -fsSL https://github.com/ai-ecoverse/slicc-audio/releases/latest/download/install.sh | sh
```

```powershell
irm https://github.com/ai-ecoverse/slicc-audio/releases/latest/download/install.ps1 | iex
```

Or with npm, on a machine with Node 24 or later:

```sh
npm install -g @ai-ecoverse/slicc-audio
```

or without installing, `npx -p @ai-ecoverse/slicc-audio scsay hello`.

In SLICC, the package declares its commands in `slicc.commands`, so installing it puts `say`, `hear`, `afplay`, `chime` and the four `sc` names in `/usr/bin`:

```sh
pnpm add -g @ai-ecoverse/slicc-audio
```

### The installers

The installers follow the convention slicc-open, slicc-capture, slicc-audio and slicc-man share ([ai-ecoverse/slicc-open#7](https://github.com/ai-ecoverse/slicc-open/issues/7)). Each release attaches `install.sh`, `install.ps1`, the package tarball `slicc-audio-<version>.tgz` (what `npm pack` makes, renamed) and `SHA256SUMS`, which covers the tarball, `install.sh` and `install.ps1`. Both installers work alike:

- **Node:** they use a Node 24 or later from `PATH`, else one they installed before, else they download the newest official Node 24+ LTS (`.tar.gz` on macOS and Linux, `.zip` on Windows, for x64 or arm64) from nodejs.org into `<data>/node`, after checking it against that release's `SHASUMS256.txt`. On musl Linux, which has no official Node build, `install.sh` says to install Node 24+ with the package manager and exits 1.
- **The package:** they download `SHA256SUMS` and the tarball, refuse a tarball whose SHA-256 doesn't match (exit 1), unpack it into `<data>/<version>`, and install its dependencies there with that Node's npm (`npm install --omit=dev --ignore-scripts --no-audit --no-fund`; `@ai-ecoverse/slicc-ortllama` is an optional dependency, so a failure there leaves only it out).
- **Launchers:** `scsay`, `schear`, `scplay` and `scchime` in the launcher directory, each running `<data>/<version>/host/<cmd>.mjs` with that Node and exporting `<CMD>_INSTALL_DIR` (`SCSAY_INSTALL_DIR` and so on) set to its own directory: `sh` scripts on macOS and Linux, and on Windows `<cmd>.ps1` next to a `<cmd>.cmd` for `cmd.exe`; both only start `node.exe` with the entry script and the arguments, and the `.cmd` switches to UTF-8 so non-ASCII paths work. The installers run each launcher with `--version`, print `<cmd> <version> installed to <launcher>` for each, and when the directory isn't on `PATH`, how to add it (`install.ps1` adds it to the user `PATH` itself).
- **Where:** the data directory is `${XDG_DATA_HOME:-$HOME/.local/share}/slicc-audio` on macOS and Linux and `%LOCALAPPDATA%\slicc-audio` on Windows; the launcher directory defaults to `$HOME/.local/bin` and `%LOCALAPPDATA%\slicc-audio\bin`.

| `install.sh` | `install.ps1` | |
| --- | --- | --- |
| `--version VERSION` | `-Version VERSION` | the release to install (default: the latest) |
| `--dir DIR` | `-Dir DIR` | where the launchers go |
| `--help` | `-Help` | print the usage and exit 0 |

Options reach `install.sh` after `sh -s --`, for example `curl -fsSL https://get.sliccy.ai/slicc-audio | sh -s -- --version 0.4.0 --dir ~/bin`, and `install.ps1` through a script block: `& ([scriptblock]::Create((irm https://get.sliccy.ai/slicc-audio.ps1))) -Version 0.4.0`. An unknown option or a missing value prints `install.sh: <what is wrong>` and the usage to stderr and exits 2; there are no environment overrides for the options. `SLICC_INSTALL_BASE_URL` is the download directory holding a release's assets (default `https://github.com/ai-ecoverse/slicc-audio/releases/latest/download`, or `…/download/v<version>` with `--version`), and `SLICC_NODE_DIST_BASE` (default `https://nodejs.org/dist`) replaces nodejs.org, for tests and mirrors.

## `--upgrade`

Every host command takes `--upgrade`. It runs the latest release's installer (`install.sh`, or `install.ps1` on Windows) with `--dir` set to the directory the command is installed in, so the new version replaces the old one in place, then prints `<cmd>: <old> → <new>` (for example `scopen: 1.2.0 → 1.3.0`), or `<cmd>: already up to date (<version>)`, to stdout and exits 0. If the installer fails, its stderr is passed through and the command exits 1. A command installed with npm prints `npm install -g @ai-ecoverse/<package>@latest` to run instead, and exits 0. In SLICC, `--upgrade` prints `pnpm add -g @ai-ecoverse/<package>@latest` to run, and exits 0; it installs nothing itself. `--upgrade` takes no other arguments.

For slicc-audio, `<package>` is `slicc-audio`, and the commands are `scsay`, `schear`, `scplay` and `scchime` on a host, and `say`, `hear`, `afplay`, `chime` and the four `sc*` names in SLICC.

The launcher the installer writes sets `<CMD>_INSTALL_DIR` (for example `SCSAY_INSTALL_DIR`) to its own directory; that is how the command knows the installer put it there (it removes the variable before it starts anything else), and without it the command counts as installed with npm. The installer is downloaded with Node's `fetch` from `https://github.com/ai-ecoverse/slicc-audio/releases/latest/download/` and run as `sh install.sh --dir DIR`, or `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File install.ps1 -Dir DIR` (else `pwsh.exe`); the line it prints, `<cmd> <version> installed to <launcher>`, names the new version. A failed download counts as the installer failing. `SLICC_INSTALL_BASE_URL`, when set, replaces that release URL for `--upgrade` and for the installers' own downloads.

Every host command also takes `--version`, which prints the version alone (for example `0.4.0`) to stdout and exits 0; it takes no other arguments either. The installers run each launcher with it once it is written, and also accept an older release's `<cmd> <version>`. In SLICC, `--version` prints the same.

## Commands

| command | does | engines, in order |
| --- | --- | --- |
| `say` | speaks text, or writes it to an audio file | Kokoro through slicc-ortllama, then the Web Speech API |
| `hear` | prints a transcript of the microphone or an audio file | Whisper through slicc-ortllama, then the Web Speech API (microphone only) |
| `afplay` | plays an audio file | Web Audio |
| `chime` | plays a short notification chime | Web Audio |
| `scsay`, `schear`, `scplay`, `scchime` | the same as `say`, `hear`, `afplay` and `chime` | |

In SLICC, slicc-ortllama runs inside the command, as on a host: the command starts its OpenAI-compatible server in-process on a free loopback port (`startServer({ port: 0 })`), sends it one request, and closes it. The models come from the Hugging Face cache ([below](#engines)). What needs the page, speaking through the Web Speech API, playing audio and recording the microphone, goes over the page bridge.

**The page bridge is to be settled.** The kernel's processes have no audio; seven's page does. How a command reaches it (a kernel device such as slicc-clipboard's `/dev/clipboard`, or something else) is one open question for slicc-audio, slicc-open and slicc-capture, to be answered once, in one slicc-kernel issue. This README describes what the commands do, not that device. Until it is settled, `afplay`, `chime`, speaking out loud and the microphone fail with `<cmd>: no audio in this kernel (needs the page bridge)` and exit 1, while `say -o` and `hear -i` work, since they need only slicc-ortllama.

Playing audio and the microphone need seven's tab and a user gesture there (Chrome's autoplay policy, and a click before the microphone permission prompt). How the page asks for that click is part of the bridge. Without one, the command fails with `<cmd>: needs a click in seven's page`; when the microphone permission is denied, with `hear: microphone permission denied`. Both exit 1.

### say

```
say [-v voice] [-r rate] [-l lang] [-o file [--file-format=fmt] [--data-format=fmt] [--channels=n]] [-i] [-f file | text ...]
say -v '?' | --list | --status | --warmup
```

- **Text:** the arguments, joined by spaces; else the file named by `-f file` (`--input-file=file`), where `-` is stdin; else stdin. Empty text speaks nothing and exits 0.
- **`-v voice`, `--voice=voice`:** a voice name, matched case-insensitively as a prefix, then as a substring, against the voices of the engine that speaks (Kokoro voices are ids such as `af_heart` and `bf_emma`). No match prints `say: voice "<name>" not found (say -v '?' lists them)` and exits 1. `-v '?'` lists the voices as macOS does, one per line: the name, the language as `en_US`, then `# ` and a sample sentence. `--list` lists them as slicc 6 did: `<name> (<lang>) [kokoro]` or `[web speech]`, with ` [default]` after the default.
- **`-r rate`, `--rate=rate`:** a value from 0.1 to 10 is a multiple of the normal rate (slicc 6); above 10 it is words per minute, up to 1000, as in macOS `say`, where 175 words per minute is the normal rate. Anything else exits 2.
- **`-l lang`, `--lang=lang`:** a BCP 47 language tag (`en-US`, `es-ES`; `en_US` works too). Without `-v`, it picks that language's default voice: for Kokoro `af_heart` (`en-US` and `en`), `bf_emma` (`en-GB`), `ef_dora` (`es`), `ff_siwis` (`fr`), `hf_alpha` (`hi`), `if_sara` (`it`) and `pf_dora` (`pt`); for Web Speech, the first voice of that language. Without `-l` the voice decides, and without either, the engine's default voice speaks.
- **`-o file`, `--output-file=file`, `--out=file`:** writes the speech to a file instead of playing it, and prints nothing. `-o -` writes it to stdout as WAV. The format comes from `--file-format` (`WAVE`, `AIFF` or `caff`), else the extension (`.wav`, `.aiff` or `.aif`, `.caf`); a name without one of those gets `.aiff` appended, as in macOS `say`. `--data-format` takes macOS's linear PCM notation: optional `LE` or `BE`, `I`, `UI` or `F`, a sample size of 8, 16, 24 or 32 (64 for `F`), and an optional `@samplerate`, such as `LEI16@22050` (the default for WAVE is `LEI16`, for AIFF and caff `BEI16`, at the engine's rate; another rate is resampled linearly). `--channels` is 1 or 2 (the mono speech in both). `--file-format=?` and `--data-format=?` list what they take. Only slicc-ortllama can write a file: Web Speech can't record, so `-o` never falls back to it.
- **`-i`, `--interactive[=markup]`:** prints each line of the text to stdout as it starts being spoken. Words aren't highlighted, so `markup` is accepted and ignored.
- **`--engine=name`:** `ortllama` or `platform` (Web Speech) only, instead of the order above.
- **`--model=id`:** the slicc-ortllama model, a Hub ID such as `onnx-community/Kokoro-82M-v1.0-ONNX` (default: ortllama's `speech` role).
- **`--status`:** one line per engine: `ortllama: ready (onnx-community/Kokoro-82M-v1.0-ONNX)`, or `ortllama: not cached (hf download …)`, and `platform: ready (Web Speech, <n> voices)` or `platform: unavailable (<why>)`. Exit 0.
- **`--warmup`:** when the Kokoro model isn't cached, runs the `hf download` command that slicc-ortllama names, if `hf` is on `PATH`; else prints it and exits 1.

The text never appears in an error, a log or a process's argv.

### hear

```
hear [-i file] [-l lang] [-T seconds] [-d device] [-x word] [-m] [-p] [--timestamps | -S] [--device]
hear -a | -s | --status | --warmup
```

- **`-i file`, `--input file`, `--file file`:** transcribes an audio file instead of the microphone, in any format slicc-ortllama decodes (WAV, mp3, FLAC, Ogg Vorbis and Opus, WebM Opus, M4A and MP4, where the browser's WebCodecs decodes AAC); `-` reads stdin. A file that isn't there prints `hear: cannot open <file>: No such file` and exits 1. Only Whisper transcribes files.
- **The microphone:** without `-i`, `hear` listens until a second of silence after speech, or until `-T` runs out, then prints the transcript. With `-x`, it keeps listening across pauses, printing one line per pause.
- **`-l lang`, `--locale lang`:** a BCP 47 language tag; the default is Whisper's detection (the Web Speech API takes the browser's language).
- **`-T seconds`, `-t seconds`, `--timeout seconds`:** the longest it listens, more than 0 and at most 600 (default 30). slicc 6 spelled it `-T` and hear `-t`; both work.
- **`-d device`, `-n device`, `--input-device-id device`:** the microphone, by an id `hear -a` prints.
- **`-a`, `--audio-input-devices`, `--devices`:** lists the microphones, one per line, as `<id>\t<label>`.
- **`-s`, `--supported`:** lists the languages the engine recognizes, one tag per line.
- **`-x word`, `--exit word`:** stops when a line ends with that word (case-insensitively, ignoring punctuation after it).
- **`-m`, `--mode`:** prints the transcript on one line, joining its lines with spaces.
- **`-p`, `--punctuation`:** Whisper always punctuates, so this changes nothing, and leaving it out doesn't strip the punctuation.
- **`--timestamps`:** files only; each segment on its own line, as `[00:00:01.200 --> 00:00:03.000] text`. hear spells it `-T`, which here is the timeout.
- **`-S`, `--subtitle`:** files only; the transcript as SRT.
- **`--device`:** recognizes on the device only, which leaves out the Web Speech API (Chrome sends its audio to a server). Whisper always runs on the device.
- **`--engine name`:** `ortllama` or `platform` (Web Speech) only. slicc 6's `enhanced` and `builtin` are the same two.
- **`--model id`:** the slicc-ortllama model, such as `onnx-community/whisper-base` (default: ortllama's `transcribe` role, `onnx-community/whisper-tiny`).
- **`--status`, `--warmup`:** as for `say`, for the Whisper model.
- **`-v`, `--version`:** the version alone, as `--version` does for every command.

The transcript goes to stdout, ending with a newline. Nothing recognized prints `hear: no speech detected` to stderr and exits 1. The audio and the transcript never appear in an error or a log.

### afplay

```
afplay [-v volume] [-t time] [-r rate] [-q quality] [-d] file
```

Options may come before or after the file, as in macOS `afplay`, and there is exactly one file. It plays any format the browser decodes (WAV, mp3, AAC and M4A, FLAC, Ogg, WebM), and returns when playback ends.

- **`-v volume`, `--volume volume`:** from 0 to 1 (default 1).
- **`-t time`, `--time time`:** stops after that many seconds.
- **`-r rate`, `--rate rate`:** from 0.25 to 4 (default 1).
- **`-q quality`, `--rQuality quality`:** 0 (default) changes the pitch with the rate; 1 keeps the pitch.
- **`-d`, `--debug`:** prints the file's format, sample rate, channels and duration to stderr before playing.

A file that isn't there prints `afplay: cannot open <file>: No such file`, one the browser can't decode `afplay: <file>: cannot decode audio`, and both exit 1.

### chime

```
chime
```

Plays the chime and returns when it ends. The chime is the same WAV everywhere, made in code rather than shipped: 0.45 seconds of 44.1 kHz 16-bit mono, an 880 Hz sine from the start and a 1318.5 Hz one from 0.1 s, each fading exponentially with a time constant of 0.12 s, peaking at −6 dBFS. It takes no other arguments.

### Help, errors and what doesn't work

`-h` and `--help` (`-help` for `afplay`, as on macOS) print the command's usage to stdout and exit 0. The usage lines above are the commands' own.

An unknown option, a missing or invalid value, or an argument a command doesn't take prints `<cmd>: <error>` and the usage line to stderr and exits 2. So do the options that can't work in a browser, each with what it is:

| command | option | why |
| --- | --- | --- |
| `say` | `-n`, `--network-send` | AUNetSend is macOS's |
| `say` | `-a`, `--audio-device` | the page plays through the browser's output |
| `say` | `--progress` | neither engine reports progress |
| `say` | `--bit-rate`, `--quality` | only for AAC, which isn't written |
| `say` | `--file-format` other than `WAVE`, `AIFF`, `caff`; `--data-format` other than linear PCM (`aac`, `alac`, `ulaw` …) | no encoder for them |
| `afplay` | `--leaks` | macOS's leaks analysis |

For example, `say: -n (network send) isn't supported in SLICC`.

A command whose engines are all unavailable prints `<cmd>: no <speech|recognition> engine available`, then one line per engine with why and how to get it, and exits 1. An engine that is there but fails prints `<cmd>: ` and its message, and exits 1, without trying the next one.

### Changes from slicc 6

- `say` no longer needs `-l`, and no longer switches to WAV on stdout when stdout isn't a terminal; `-o -` does that.
- `hear` no longer reads stdin when stdin isn't a terminal; `-i -` does that.
- A bad option or value exits 2, not 1.
- `chime` no longer plays `/shared/sounds/chime.mp3`.

## On a host

The package's `bin` is `scsay`, `schear`, `scplay` and `scchime`, small Node scripts in `host/`. The host's own `say`, `afplay` and the rest are never shadowed. They take the options above and hand off to these tools, the first one found on `PATH`:

| platform | `scsay` | `scplay`, `scchime` |
| --- | --- | --- |
| macOS | `say` | `afplay` |
| Linux and other Unix systems | `spd-say`, else `espeak-ng`, else `espeak` | `paplay`, else `pw-play`, else `aplay`, else `ffplay` |
| Windows | `powershell.exe` with System.Speech's `SpeechSynthesizer` | `powershell.exe`, else `pwsh.exe`, with WPF's `MediaPlayer` |

`schear` has no platform tool; see [Engines](#engines).

- **Spawning:** each tool runs with a fixed argv and no shell. The text to speak goes on stdin as UTF-8 (`say -f -`, `espeak-ng --stdin`; on Windows, the script goes in `-EncodedCommand` and reads the text from stdin), except for `spd-say`, which takes it after `--`. File paths reach the PowerShell scripts through the environment, not the command line. The tool's stderr passes through; a tool that fails exits the command with 1.
- **macOS:** every `say` and `afplay` option passes through unchanged, including the ones SLICC refuses (`-n`, `-a`, `--progress`, `--bit-rate`, `--quality`, every format `say` knows, `--leaks`). `-r` as a multiple becomes words per minute (× 175). `-l` without `-v` picks the first `say -v '?'` voice whose locale matches. `-o -` has `say` write WAVE to a temporary file, which then goes to stdout.
- **Rate:** `spd-say -r` gets (rate − 1) × 100, held between −100 and 100; `espeak-ng -s` 175 × rate words per minute, held between 80 and 450; System.Speech's `Rate` 10 × log₃(rate), rounded and held between −10 and 10.
- **Voices and languages:** `-v` is `spd-say -y`, `espeak-ng -v` and `SelectVoice` (after the same prefix-then-substring match); `-l` alone is `spd-say -l`, `espeak-ng -v <lang>` and the first installed voice of that culture. `-v '?'` and `--list` list `spd-say -L`, `espeak-ng --voices` and `GetInstalledVoices()`. On a host `--list` tags each voice with its engine, `[platform]`, `[ortllama]` or `[ollama]` (whose only voice is `default`), and `-v '?'` and `--list` use the first engine that has its tools.
- **Files:** `-o` on Linux uses `espeak-ng -w` (or `espeak -w`), since `spd-say` can't write one; on Windows, `SetOutputToWaveFile`. The WAV they write is then rewritten into the format asked for by the same code as in SLICC: `WAVE` takes little-endian `UI8`, `I16`, `I24`, `I32`, `F32` and `F64`, `AIFF` big-endian `I8` to `I32`, and `caff` either byte order of `I8` to `I32`, `F32` and `F64`; anything else exits 2. Outside macOS, `-n`, `-a`, `--progress`, `--bit-rate` and `--quality` exit 2 as in SLICC, so do `--file-format`, `--data-format` and `--channels` without `-o`, and `-i` prints each line before speaking it.
- **Playback:** `-v` is `paplay --volume` (× 65536), `pw-play --volume`, `ffplay -volume` (× 100) and `MediaPlayer.Volume`; `-r` is `ffplay -af atempo` and `MediaPlayer.SpeedRatio`. `aplay` takes neither, and `paplay` and `pw-play` take no rate, so with `-v` or `-r` other than 1, the tools that can't do it are skipped. `-t` stops the tool after that many seconds, everywhere but on macOS, where it passes through. `-q` passes through on macOS and is ignored elsewhere; `-d` passes through on macOS and prints the tool and its argv to stderr elsewhere.
- **`scchime`:** writes the chime's WAV to a temporary file, plays it like `scplay` does, and deletes it.

### Engines

`scsay` and `schear` try engines in this order, and use the first one that is available:

| | `scsay` | `schear` |
| --- | --- | --- |
| 1 | `platform`: the tool in the table above | `whisper`: whisper.cpp's `whisper-cli` (else `whisper-cpp`, Homebrew's older name), with `ffmpeg` |
| 2 | `ortllama`: Kokoro through slicc-ortllama | `ortllama`: Whisper through slicc-ortllama |
| 3 | `ollama`: an Ollama server | `ollama`: an Ollama server |

`--engine <name>` (or `SLICC_AUDIO_ENGINE`; the option wins) uses only that engine. `--model <id>` (or `SLICC_AUDIO_MODEL`) names the model for the engine that runs, so it is most useful with `--engine`; `platform` takes none. An engine is unavailable when its tool isn't on `PATH`, its package isn't installed, its server doesn't answer, or its model isn't there; it fails, without falling back, when it is there and then errors. When none is available:

```
schear: no recognition engine available
  whisper: whisper-cli not found (brew install whisper-cpp ffmpeg)
  ortllama: model not cached (hf download onnx-community/whisper-tiny --include …)
  ollama: no server at http://127.0.0.1:11434 (install Ollama from https://ollama.com, then ollama serve)
```

and exit 1. The hints are per platform: on Linux, the distribution's `whisper-cpp` package or a build from github.com/ggml-org/whisper.cpp, and `espeak-ng` or `speech-dispatcher`; on Windows, `whisper-bin-x64.zip` from the whisper.cpp releases and `winget install Gyan.FFmpeg`.

- **`whisper`:** `ffmpeg -nostdin -loglevel error -i <file> -ar 16000 -ac 1 -c:a pcm_s16le -f wav <tmp>` turns the input into 16 kHz mono WAV, then `whisper-cli -m <model> -f <tmp> -l <lang|auto> -np -nt` prints the transcript (without `-nt` for `--timestamps`, with `-osrt` for `-S`). The model is a ggml file: `--model` takes a name such as `tiny`, `base.en` or `large-v3-turbo`, or a path to a `.bin`; the default is `base`. A named model is downloaded on first use from `${HF_ENDPOINT:-https://huggingface.co}/ggerganov/whisper.cpp/resolve/main/ggml-<name>.bin` into the cache directory, `SLICC_AUDIO_CACHE`, else `~/Library/Caches/slicc-audio` on macOS, `${XDG_CACHE_HOME:-~/.cache}/slicc-audio` on Linux and `%LOCALAPPDATA%\slicc-audio\Cache` on Windows. The download goes to a `.part` file with its progress on stderr, and is renamed only when its SHA-256 matches the hub's `X-Linked-ETag`; otherwise it is deleted and the command exits 1.
- **`ortllama`:** `@ai-ecoverse/slicc-ortllama`, an optional dependency of this package, imported when needed. The command starts its server in-process (`startServer({ port: 0 })`, on 127.0.0.1), sends one request, and closes it (`close()`). `scsay` posts `{ input, voice, speed, response_format: "wav" }` to `/v1/audio/speech` (Kokoro, voice `af_heart` unless `-v` or `-l` says otherwise, `speed` the rate held between 0.25 and 4) and plays the WAV like `scplay`. Text longer than 4096 characters, the most slicc-ortllama and OpenAI's API take, goes in pieces of at most 4096, cut at sentence ends (else at spaces), and their audio is joined into one WAV; the `ollama` engine does the same. `schear` posts the file as multipart `file`, with `language` and `response_format` (`json`, `verbose_json` for `--timestamps`, `srt` for `-S`), to `/v1/audio/transcriptions`; slicc-ortllama decodes the formats itself. slicc-ortllama downloads nothing and reads only the Hugging Face cache (`HF_HUB_CACHE`, else `HF_HOME/hub`, else `~/.cache/huggingface/hub`); a model that isn't cached answers `404` with the `hf download` command that fetches it, and the command passes that command on. It runs on `onnxruntime-node` when that is installed, else on WebAssembly. `-v '?'`, `--list` and the `-v` match use slicc-ortllama's `GET /v1/audio/voices` (1.27.0 or later), with `?model=` when `--model` is set; a server without the endpoint leaves `-v` as given.
- **`ollama`:** the same OpenAI-compatible requests, to `OLLAMA_HOST` (`host`, `host:port` or a URL; default `http://127.0.0.1:11434`) under `/v1`. `scsay` asks for model `phonon` with voice `default` unless `--model` and `-v` say otherwise, and sends `speed` only when the rate isn't 1 (Phonon answers `400` to one). A model that isn't pulled counts as unavailable, with `ollama pull <model>` as the hint. Ollama 0.40.9 serves `/v1/audio/speech` but no `/v1/audio/transcriptions`, so for `schear` this engine needs `--model` and a server that has the endpoint; a `404` there counts as unavailable. Nothing in it is specific to Ollama: any server with OpenAI's audio endpoints at `OLLAMA_HOST` works, and `schear --device` leaves it out unless that host is a loopback address.
- **The microphone:** every `schear` engine records it with `ffmpeg` into a temporary 16 kHz mono WAV, from `-f avfoundation -i :<device|0>` on macOS, `-f pulse -i <device|default>` on Linux when `pactl info` works (else `-f alsa -i <device|default>`) and `-f dshow -i audio=<device>` on Windows (the first device `-a` lists by default). `-af silencedetect=noise=-30dB:d=1` marks the pauses: ffmpeg is stopped (with `q` on its stdin) at the first pause after speech, or after `-T`. `-a` lists the devices through ffmpeg's `-list_devices true` (avfoundation, dshow) or `pactl list short sources` (else `arecord -L`). Without `ffmpeg`, the microphone is unavailable to every engine. On macOS, the first recording makes the system ask whether the terminal may use the microphone.
- **`--status` and `--warmup`:** `--status` prints one line per engine, as in SLICC (`whisper: ready (whisper-cli, ffmpeg, ggml-base.bin)`, `whisper: model not downloaded (schear --warmup)`), and exits 0. `--warmup` readies the engine `--engine` names, else the first one in the order that has its tools: `whisper` downloads its model; `ortllama` runs the `hf download` command if `hf` is on `PATH`, else prints it and exits 1; `ollama` prints `ollama pull <model>` and exits 1; `platform` has nothing to fetch.

### Errors

- **No tool:** `scplay: no audio player found (tried paplay, pw-play, aplay, ffplay)`, the names tried on that platform, to stderr, exit 1. `scsay` and `schear` list their engines instead, as above.
- **A failing tool or engine:** its stderr or error message passes through, exit 1. A transcript or text to speak never does.
- **Arguments:** `-h` and `--help` print the usage to stdout and exit 0; an unknown option, a bad value, or an option the platform can't do prints `<cmd>: <error>` (such as `scsay: -a isn't supported on linux`) and the usage line to stderr, and exits 2.

**In SLICC, the SLICC commands win.** The package has both `bin` and `slicc.commands`, and both name `scsay`, `schear`, `scplay` and `scchime`, so, as for slicc-clipboard's `sccopy`, the kernel takes the `slicc.commands` entry and bios removes pnpm's `bin` link for those names.

## Development

```sh
npm install
npm run lint
npm test
npm run test:unit
```

- `npm run lint`: Biome, the no-comment check and the other [slicc-shared-web](https://github.com/ai-ecoverse/slicc-shared-web) checks.
- `npm test`: the integration tests in `test/integration/`. `repo.test.mjs` checks the workflow, the release config, the hooks, what git tracks and what `npm pack` ships. `say.test.mjs`, `hear.test.mjs` and `play.test.mjs` run `host/` against fake `say`, `afplay`, `spd-say`, `espeak-ng`, `espeak`, `paplay`, `pw-play`, `aplay`, `ffplay`, `ffmpeg`, `whisper-cli`, `whisper-cpp`, `pactl`, `arecord`, `hf`, `powershell.exe` and `pwsh.exe` on a temporary `PATH`, with the platform forced, so each branch is checked on any machine: the tool picked, its argv and stdin, the fallbacks, the engine order, `--engine` and `SLICC_AUDIO_ENGINE`, the error that lists every engine, and the argument errors. slicc-ortllama is replaced by a fake module, and both it and Ollama (through `OLLAMA_HOST`) by one fake OpenAI-compatible HTTP server, which also serves the ggml model downloads through `HF_ENDPOINT`; `HF_HUB_CACHE` and `SLICC_AUDIO_CACHE` are empty temporary directories. CI never downloads a real model and never plays or records real audio. `install.test.mjs` runs `install.sh` against a fake release and a fake Node distribution (`SLICC_INSTALL_BASE_URL`, `SLICC_NODE_DIST_BASE`), and `--upgrade` against them.
- `npm run test:unit`: the unit tests in the gitignored `test/unit/`, with coverage of `host/` in `coverage/unit/lcov.info`. The pre-commit hook wants 100% coverage of the changed lines.

`npm install` runs `slicc-install-hooks`, which gives each worktree its own hooks through the committed `.githooks/`.

CI is `.github/workflows/ci.yml`, the only workflow, which runs [slicc-shared-web's pipeline](https://github.com/ai-ecoverse/slicc-shared-web#pipeline) at the devDependency's version, on Linux: `npm run lint`, then `npm test`, then on a pull request the Claude and Codex reviews. The merge queue requires `ci / integration` and `ci / review`. On a push to `main`, semantic-release releases and publishes to npm through trusted publishing, with provenance from `ci.yml`, so commit messages follow [Conventional Commits](https://www.conventionalcommits.org).

## License

Apache-2.0
