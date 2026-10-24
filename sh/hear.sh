versions=-v
usage() {
  printf '%s\n' "usage: $me [-i file] [-l lang] [-T seconds] [-d device] [-x word] [-m] [-p] [--timestamps | -S] [--device]"
  printf '%s\n' "       $me -a | -s | --status | --warmup"
}
meta "$@"
input=
given=
lng=
timeout=
device=
word=
mode=
stamps=
sub=
local=
choice=
model=
devices=
supported=
status=
warmup=
while [ "$#" -gt 0 ]; do
  case $1 in
    -?*) ;;
    *) bad "unexpected argument: $1" ;;
  esac
  a=$1
  split "$1"
  shift
  case $f in
    -h | --help)
      flag
      usage
      exit 0
      ;;
    -i | --input | --file)
      takes "$@"
      input=$v
      given=1
      ;;
    -l | --locale)
      takes "$@"
      lang "$v"
      lng=$tag
      ;;
    -T | -t | --timeout)
      takes "$@"
      timeout=$v
      ;;
    -d | -n | --input-device-id)
      takes "$@"
      device=$v
      ;;
    -x | --exit)
      takes "$@"
      word=$v
      ;;
    -m | --mode)
      flag
      mode=1
      ;;
    -p | --punctuation) flag ;;
    --timestamps)
      flag
      stamps=1
      ;;
    -S | --subtitle)
      flag
      sub=1
      ;;
    --device)
      flag
      local=1
      ;;
    --engine)
      takes "$@"
      choice=$v
      ;;
    --model)
      takes "$@"
      model=$v
      ;;
    -a | --audio-input-devices | --devices)
      flag
      devices=1
      ;;
    -s | --supported)
      flag
      supported=1
      ;;
    --status)
      flag
      status=1
      ;;
    --warmup)
      flag
      warmup=1
      ;;
    *) bad "unknown option: $a" ;;
  esac
  if [ -n "$used" ]; then
    shift
  fi
done
case $choice in
  '' | ortllama | platform) ;;
  enhanced) choice=ortllama ;;
  builtin) choice=platform ;;
  *) bad "--engine $choice: one of ortllama, platform" ;;
esac
if [ -n "$stamps" ] && [ -n "$sub" ]; then
  bad "--timestamps and -S are exclusive"
fi
if [ -z "$given" ] && [ -n "$sub" ]; then
  bad "-S needs -i file"
fi
if [ -z "$given" ] && [ -n "$stamps" ]; then
  bad "--timestamps needs -i file"
fi
tm=30000
if [ -n "$timeout" ]; then
  dec "$timeout" || n=0
  if [ "$n" -le 0 ] || [ "$n" -gt 600000 ]; then
    bad "-T $timeout: more than 0 and at most 600"
  fi
  tm=$n
fi
if [ -n "$device" ] && [ -z "$given" ] && [ "$choice" = platform ]; then
  bad "-d: Web Speech can't pick a microphone (-d needs --engine ortllama)"
fi
engines=${choice:-ortllama platform}
if [ -n "$local" ] || [ -n "$device" ]; then
  engines=${engines%platform}
fi
h=
str model "$model"
extra=$h
need
if [ -n "$supported" ]; then
  which=whisper
  if [ "$choice" = platform ]; then
    which=webspeech
  fi
  ask "{\"kind\":\"audio.transcribe\",\"supported\":true,\"engine\":\"$which\"}" </dev/null
  exit 0
fi
if [ -n "$devices" ]; then
  ask '{"kind":"audio.record","devices":true}' </dev/null
  exit 0
fi
if [ -n "$status" ]; then
  probe audio.transcribe "$extra"
  while IFS= read -r line; do
    for e in $engines; do
      case $line in
        "$e: "*) printf '%s\n' "$line" ;;
      esac
    done
  done <<EOF
$state
EOF
  exit 0
fi
if [ -n "$warmup" ]; then
  if [ "$choice" = platform ]; then
    exit 0
  fi
  warm audio.transcribe "$extra"
fi
lower() {
  low=$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')
  tail=${low##*[[:alnum:]\'-]}
  low=${low%"$tail"}
}
want=
if [ -n "$word" ]; then
  lower "$word"
  want=$low
fi
any=
hit=
emit() {
  if [ -n "$sub" ]; then
    while IFS= read -r line; do
      case $line in
        *[![:space:]]*) any=1 ;;
      esac
    done <"$work/out"
    if [ -n "$any" ]; then
      cat "$work/out"
    fi
    return 0
  fi
  joined=
  while IFS= read -r line || [ -n "$line" ]; do
    line=${line#"${line%%[![:space:]]*}"}
    line=${line%"${line##*[![:space:]]}"}
    [ -n "$line" ] || continue
    if [ -z "$joined" ]; then
      joined=$line
    elif [ -n "$mode" ]; then
      joined="$joined $line"
    else
      joined="$joined$nl$line"
    fi
    if [ -n "$want" ]; then
      lower "$line"
      if [ "${low##*[[:space:]]}" = "$want" ]; then
        hit=1
        break
      fi
    fi
  done <"$work/out"
  if [ -n "$joined" ]; then
    printf '%s\n' "$joined"
    any=1
  fi
}
th="{\"kind\":\"audio.transcribe\",\"engine\":\"whisper\""
h=
str language "$lng"
str model "$model"
th="$th$h"
if [ -n "$given" ]; then
  if [ "$choice" = platform ]; then
    die "Web Speech can't transcribe a file (-i needs --engine ortllama)"
  fi
  if [ "$input" != - ] && [ ! -f "$input" ]; then
    die "cannot open $input: No such file"
  fi
  probe audio.transcribe "$extra"
  pick recognition ortllama
  form=text
  if [ -n "$stamps" ]; then
    form=timestamps
  elif [ -n "$sub" ]; then
    form=srt
  fi
  if [ "$input" = - ]; then
    ask "$th,\"format\":\"$form\"}" >"$work/out"
  else
    ask "$th,\"format\":\"$form\"}" <"$input" >"$work/out"
  fi
  emit
  [ -n "$any" ] || die "no speech detected"
  exit 0
fi
listen() {
  : >"$work/err"
  { command exec 3<>"$dev" 5<>"$dev"; } 2>>"$work/err" || fail
  { printf '%s\n' "$1" | cat >&3 && printf '%s\n' "$2" | cat >&5; } 2>>"$work/err" || fail
  cat <&3 >&5 2>>"$work/err" &
  hold "$!" || fail
  exec 3<&-
  cat <&5 >"$work/out" 2>>"$work/err" &
  hold "$!" || fail
  exec 5<&-
}
probe audio.transcribe "$extra"
pick recognition "$engines"
if [ "$engine" = platform ]; then
  num "$tm"
  h="{\"kind\":\"audio.transcribe\",\"engine\":\"webspeech\",\"seconds\":$d"
  str language "$lng"
  if [ -n "$word" ]; then
    raw continuous true
    str exit "$word"
  fi
  ask "$h}" </dev/null >"$work/out"
  emit
  [ -n "$any" ] || die "no speech detected"
  exit 0
fi
start=$(date +%s%3N)
left=$tm
while :; do
  num "$left"
  h="{\"kind\":\"audio.record\",\"seconds\":$d,\"pause\":true"
  str device "$device"
  listen "$h}" "$th,\"format\":\"text\"}"
  emit
  if [ -z "$word" ] || [ -n "$hit" ]; then
    break
  fi
  left=$((tm - ($(date +%s%3N) - start)))
  [ "$left" -gt 0 ] || break
done
[ -n "$any" ] || die "no speech detected"
