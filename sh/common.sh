dev=/dev/embedder
nl='
'
file=
h=
used=
has=
f=
v=
n=
d=
q=
tag=
bad() {
  printf '%s: %s\n' "$me" "$1" >&2
  usage >&2
  exit 2
}
die() {
  printf '%s: %s\n' "$me" "$1" >&2
  exit 1
}
version() {
  ver=
  while IFS= read -r line; do
    case $line in
      *'"version":'*)
        ver=${line#*'"version":'}
        ver=${ver#*'"'}
        ver=${ver%%'"'*}
        break
        ;;
    esac
  done <"${0%/*}/../package.json"
  printf '%s\n' "$ver"
}
meta() {
  if [ "$#" -eq 1 ]; then
    case $1 in
      --upgrade)
        printf 'pnpm add -g @ai-ecoverse/slicc-audio@latest\n'
        exit 0
        ;;
      --version | "${versions:---version}")
        version
        exit 0
        ;;
    esac
  fi
}
split() {
  used=
  has=
  f=$1
  v=
  case $1 in
    --*=*)
      f=${1%%=*}
      v=${1#*=}
      has=1
      ;;
  esac
  case $f in
    --upgrade | --version | "${versions:---version}") bad "$f takes no other arguments" ;;
  esac
}
takes() {
  if [ -z "$has" ]; then
    [ "$#" -gt 0 ] || bad "$f needs a value"
    v=$1
    used=1
  fi
  case $v in
    *[[:cntrl:]]*) bad "$f: no control characters in a value" ;;
  esac
}
flag() {
  [ -z "$has" ] || bad "$f takes no value"
}
refuse() {
  bad "$f ($1) isn't supported in SLICC"
}
js() {
  s=$1
  q=
  while [ -n "$s" ]; do
    c=${s%"${s#?}"}
    s=${s#?}
    case $c in
      \\ | \") q="$q\\$c" ;;
      *) q=$q$c ;;
    esac
  done
  q="\"$q\""
}
str() {
  if [ -n "$2" ]; then
    js "$2"
    h="$h,\"$1\":$q"
  fi
}
raw() {
  if [ -n "$2" ]; then
    h="$h,\"$1\":$2"
  fi
}
dec() {
  case $1 in
    '' | . | *[!0-9.]* | *.*.*) return 1 ;;
  esac
  i=${1%%.*}
  fr=
  case $1 in
    *.*) fr=${1#*.} ;;
  esac
  fr="${fr}000"
  fr=${fr%"${fr#???}"}
  while :; do
    case $i in
      0?*) i=${i#0} ;;
      *) break ;;
    esac
  done
  [ "${#i}" -le 9 ] || return 1
  n=$((${i:-0} * 1000 + 1$fr - 1000))
}
num() {
  d=$(($1 / 1000)).$(($1 % 1000 / 100))$(($1 % 100 / 10))$(($1 % 10))
}
lang() {
  rest=$1
  tag=
  first=1
  while :; do
    part=${rest%%[-_]*}
    if [ -n "$first" ]; then
      case $part in
        [A-Za-z][A-Za-z] | [A-Za-z][A-Za-z][A-Za-z]) ;;
        *) bad "$f $1: not a language tag" ;;
      esac
      tag=$(printf '%s' "$part" | tr '[:upper:]' '[:lower:]')
      first=
    else
      case $part in
        *[!A-Za-z0-9]* | ? | ??????????*) bad "$f $1: not a language tag" ;;
        ??) tag="$tag-$(printf '%s' "$part" | tr '[:lower:]' '[:upper:]')" ;;
        *) tag="$tag-$part" ;;
      esac
    fi
    [ "$part" != "$rest" ] || break
    rest=${rest#*[-_]}
  done
}
work=
pids=
cleanup() {
  if [ -n "$work" ]; then
    rm -rf "$work"
  fi
}
stop() {
  if [ -n "$pids" ]; then
    kill "$pids" 2>/dev/null
  fi
  exit "$1"
}
need() {
  if [ ! -c "$dev" ]; then
    die "no audio in this kernel (needs slicc-kernel >= 1.153.0, for /dev/embedder)"
  fi
  work=$(mktemp -d) || die "cannot make a temporary directory"
  trap cleanup EXIT
  trap 'stop 129' HUP
  trap 'stop 130' INT
  trap 'stop 143' TERM
}
hold() {
  pids=$1
  wait "$1"
  st=$?
  pids=
  return "$st"
}
fail() {
  msg=
  errno=
  while IFS= read -r line; do
    case $line in
      *"$dev: "*) [ -n "$msg" ] || msg=${line#*"$dev: "} ;;
      *': '*) errno=${line##*: } ;;
    esac
  done <"$work/err"
  msg=${msg:-$errno}
  case $msg in
    'voice "'*'" not found') msg="$msg ($me -v '?' lists them)" ;;
    'cannot decode audio') msg="$file: $msg" ;;
  esac
  die "${msg:-the page did not answer}"
}
ask() {
  exec 6<&0
  : >"$work/err"
  { command exec 3<>"$dev"; } 2>>"$work/err" || fail
  { printf '%s\n' "$1" | cat && exec cat <&6; } >&3 2>>"$work/err" &
  hold "$!" || fail
  exec 6<&-
  cat <&3 2>>"$work/err" &
  hold "$!" || fail
  exec 3<&-
}
probe() {
  state=$(ask "{\"kind\":\"$1\",\"status\":true$2}" </dev/null) || exit 1
}
pick() {
  engine=
  why=
  for e in $2; do
    while IFS= read -r line; do
      case $line in
        "$e: ready"*) [ -n "$engine" ] || engine=$e ;;
        "$e: "*) why="$why$nl  $line" ;;
      esac
    done <<EOF
$state
EOF
    [ -z "$engine" ] || return 0
  done
  die "no $1 engine available$why"
}
warm() {
  reply=$(ask "{\"kind\":\"$1\",\"warmup\":true$2}" </dev/null) || exit 1
  case $reply in
    'ortllama: ready'*)
      printf '%s\n' "$reply"
      exit 0
      ;;
  esac
  shown=${reply%%"$nl"*}
  set --
  while IFS= read -r line; do
    set -- "$@" "$line"
  done <<EOF
${reply#*"$nl"}
EOF
  if [ "$#" -lt 3 ] || [ "$1" != hf ] || [ "$2" != download ]; then
    die "ortllama: $shown"
  fi
  shift
  if ! command -v hf >/dev/null 2>&1; then
    die "hf not found; run: $shown"
  fi
  hf "$@" >&2 </dev/null || exit 1
  exit 0
}
