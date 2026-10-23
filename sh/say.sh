usage() {
  printf "usage: %s [-v voice] [-r rate] [-l lang] [-o file [--file-format=fmt] [--data-format=fmt] [--channels=n]] [-i] [-f file | text ...]\n" "$me"
  printf "       %s -v '?' | --list | --status | --warmup\n" "$me"
}
meta "$@"
tab='	'
voice=
voiced=
rate=
lng=
out=
ff=
df=
ch=
inter=
input=
list=
status=
warmup=
choice=
model=
text=
given=
word() {
  if [ -n "$given" ]; then
    text="$text $1"
  else
    text=$1
    given=1
  fi
}
while [ "$#" -gt 0 ]; do
  case $1 in
    --)
      shift
      for w; do
        word "$w"
      done
      break
      ;;
    -?*) ;;
    *)
      word "$1"
      shift
      continue
      ;;
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
    -v | --voice)
      takes "$@"
      voice=$v
      voiced=1
      ;;
    -r | --rate)
      takes "$@"
      rate=$v
      ;;
    -l | --lang)
      takes "$@"
      lang "$v"
      lng=$tag
      ;;
    -o | --output-file | --out)
      takes "$@"
      out=$v
      ;;
    --file-format)
      takes "$@"
      ff=$v
      ;;
    --data-format)
      takes "$@"
      df=$v
      ;;
    --channels)
      takes "$@"
      ch=$v
      ;;
    -i)
      flag
      inter=1
      ;;
    --interactive) inter=1 ;;
    -f | --input-file)
      takes "$@"
      input=$v
      ;;
    --list)
      flag
      list=1
      ;;
    --status)
      flag
      status=1
      ;;
    --warmup)
      flag
      warmup=1
      ;;
    --engine)
      takes "$@"
      choice=$v
      ;;
    --model)
      takes "$@"
      model=$v
      ;;
    -n | --network-send) refuse "network send" ;;
    -a | --audio-device) refuse "audio device" ;;
    --progress) refuse "progress reports" ;;
    --bit-rate) refuse "AAC bit rate" ;;
    --quality) refuse "AAC quality" ;;
    *) bad "unknown option: $a" ;;
  esac
  if [ -n "$used" ]; then
    shift
  fi
done
mult=
if [ -n "$rate" ]; then
  dec "$rate" || n=0
  if [ "$n" -ge 100 ] && [ "$n" -le 10000 ]; then
    mult=$n
  elif [ "$n" -gt 10000 ] && [ "$n" -le 1000000 ]; then
    mult=$((n / 175))
  else
    bad "-r $rate: a multiple from 0.1 to 10, or words per minute up to 1000"
  fi
  num "$mult"
  mult=$d
fi
case $choice in
  '' | ortllama | platform) ;;
  *) bad "--engine $choice: one of ortllama, platform" ;;
esac
case $ch in
  '' | 1 | 2) ;;
  *) bad "--channels $ch: 1 or 2" ;;
esac
format=
case $ff in
  '' | '?') ;;
  [Ww][Aa][Vv][Ee]) format=WAVE ;;
  [Aa][Ii][Ff][Ff]) format=AIFF ;;
  [Cc][Aa][Ff][Ff]) format=caff ;;
  *) bad "--file-format $ff: no encoder for it" ;;
esac
waves='LEUI8 LEI16 LEI24 LEI32 LEF32 LEF64'
aiffs='BEI8 BEI16 BEI24 BEI32'
caffs='LEI8 LEI16 LEI24 LEI32 LEF32 LEF64 BEI8 BEI16 BEI24 BEI32 BEF32 BEF64'
if [ "$ff" = '?' ]; then
  printf 'WAVE  .wav\nAIFF  .aiff .aif\ncaff  .caf\n'
  exit 0
fi
if [ "$df" = '?' ]; then
  case ${format:-all} in
    WAVE | all) printf 'WAVE  %s\n' "$waves" ;;
  esac
  case ${format:-all} in
    AIFF | all) printf 'AIFF  %s\n' "$aiffs" ;;
  esac
  case ${format:-all} in
    caff | all) printf 'caff  %s\n' "$caffs" ;;
  esac
  exit 0
fi
if [ -z "$out" ] && [ -n "$ff$df$ch" ]; then
  bad "--file-format, --data-format and --channels need -o"
fi
encoding=
if [ -n "$out" ]; then
  if [ "$choice" = platform ]; then
    bad "-o: Web Speech can't write a file"
  fi
  if [ "$out" = - ]; then
    format=WAVE
  elif [ -z "$format" ]; then
    case $out in
      *.[Ww][Aa][Vv]) format=WAVE ;;
      *.[Aa][Ii][Ff][Ff] | *.[Aa][Ii][Ff]) format=AIFF ;;
      *.[Cc][Aa][Ff]) format=caff ;;
      *)
        format=AIFF
        out=$out.aiff
        ;;
    esac
  fi
  rest=${df:-I16}
  endian=
  case $rest in
    LE* | BE*)
      endian=${rest%"${rest#??}"}
      rest=${rest#??}
      ;;
  esac
  case $rest in
    UI*) kind=UI ;;
    I*) kind=I ;;
    F*) kind=F ;;
    *) bad "--data-format $df: no encoder for it" ;;
  esac
  rest=${rest#"$kind"}
  bits=${rest%%@*}
  hz=
  case $rest in
    *@) bad "--data-format $df: no encoder for it" ;;
    *@*) hz=${rest#*@} ;;
  esac
  case $bits in
    8 | 16 | 24 | 32 | 64) ;;
    *) bad "--data-format $df: no encoder for it" ;;
  esac
  case $hz in
    *[!0-9]*) bad "--data-format $df: no encoder for it" ;;
  esac
  case $format in
    WAVE) allowed=$waves ;;
    AIFF) allowed=$aiffs ;;
    *) allowed=$caffs ;;
  esac
  if [ -z "$endian" ]; then
    case $format in
      WAVE) endian=LE ;;
      *) endian=BE ;;
    esac
  fi
  if [ "$format" = WAVE ] && [ "$kind$bits" = I8 ]; then
    endian=LE
    kind=UI
  fi
  case " $allowed " in
    *" $endian$kind$bits "*) ;;
    *) bad "--data-format $df: no encoder for it in $format" ;;
  esac
  if [ -n "$hz" ]; then
    dec "$hz" || n=0
    if [ "$n" -lt 1000000 ] || [ "$n" -gt 384000000 ]; then
      bad "--data-format $df: bad sample rate"
    fi
    hz=$((n / 1000))
  fi
  encoding="{\"format\":\"$format\",\"endian\":\"$endian\",\"kind\":\"$kind\",\"bits\":$bits,\"channels\":${ch:-1}"
  if [ -n "$hz" ]; then
    encoding="$encoding,\"rate\":$hz"
  fi
  encoding="$encoding}"
fi
engines=${choice:-ortllama platform}
if [ -n "$out" ]; then
  engines=ortllama
fi
wire() {
  case $1 in
    ortllama) printf kokoro ;;
    *) printf webspeech ;;
  esac
}
h=
str model "$model"
extra=$h
need
if [ "$voice" = '?' ] || [ -n "$list" ]; then
  probe audio.say "$extra"
  pick speech "$engines"
  h="{\"kind\":\"audio.voices\",\"engine\":\"$(wire "$engine")\""
  str model "$model"
  voices=$(ask "$h}" </dev/null) || exit 1
  while IFS="$tab" read -r name where mark; do
    [ -n "$name" ] || continue
    if [ "$voice" = '?' ]; then
      printf '%-19s %-8s # Hello, my name is %s.\n' "$name" "$where" "$name"
    else
      case $engine in
        ortllama) label=kokoro ;;
        *) label='web speech' ;;
      esac
      suffix=
      if [ "$mark" = 1 ]; then
        suffix=' [default]'
      fi
      case $where in
        *_*) where="${where%%_*}-${where#*_}" ;;
      esac
      printf '%s (%s) [%s]%s\n' "$name" "$where" "$label" "$suffix"
    fi
  done <<EOF
$voices
EOF
  exit 0
fi
if [ -n "$status" ]; then
  probe audio.say "$extra"
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
  warm audio.say "$extra"
fi
body=$work/text
if [ -n "$given" ]; then
  printf '%s' "$text" >"$body"
elif [ -n "$input" ] && [ "$input" != - ]; then
  if [ ! -f "$input" ]; then
    die "cannot open $input: No such file"
  fi
  body=$input
else
  cat >"$body" || exit 1
fi
text=$(cat <"$body") || exit 1
case $text in
  *[![:space:]]*) ;;
  *) exit 0 ;;
esac
probe audio.say "$extra"
pick speech "$engines"
h="{\"kind\":\"audio.say\",\"engine\":\"$(wire "$engine")\""
if [ -n "$voiced" ]; then
  str voice "$voice"
fi
str lang "$lng"
raw rate "$mult"
str model "$model"
if [ -n "$encoding" ]; then
  raw output "$encoding"
elif [ -n "$inter" ]; then
  raw interactive true
fi
h="$h}"
if [ -n "$out" ] && [ "$out" != - ]; then
  { command exec 7>"$out"; } 2>/dev/null || die "cannot write $out"
  trap 'rm -f "$out"; cleanup' EXIT
  ask "$h" <"$body" >&7
  trap cleanup EXIT
else
  ask "$h" <"$body"
fi
