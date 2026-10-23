usage() {
  printf 'usage: %s [-v volume] [-t time] [-r rate] [-q quality] [-d] file\n' "$me"
}
meta "$@"
files=0
volume=
time=
rate=
quality=
debug=
range() {
  dec "$2" || n=-1
  if [ "$n" -lt "$3" ] || [ "$n" -gt "$4" ]; then
    bad "$1 $2: $5"
  fi
  num "$n"
}
while [ "$#" -gt 0 ]; do
  case $1 in
    -?*) ;;
    *)
      file=$1
      files=$((files + 1))
      shift
      continue
      ;;
  esac
  a=$1
  split "$1"
  shift
  case $f in
    -h | -help | --help)
      flag
      usage
      exit 0
      ;;
    -v | --volume)
      takes "$@"
      range -v "$v" 0 1000 "from 0 to 1"
      volume=$d
      ;;
    -t | --time)
      takes "$@"
      range -t "$v" 1 86400000 "more than 0 and at most 86400"
      time=$d
      ;;
    -r | --rate)
      takes "$@"
      range -r "$v" 250 4000 "from 0.25 to 4"
      rate=$d
      ;;
    -q | --rQuality)
      takes "$@"
      case $v in
        0 | 1) quality=$v ;;
        *) bad "-q $v: 0 or 1" ;;
      esac
      ;;
    -d | --debug)
      flag
      debug=true
      ;;
    --leaks) refuse "leaks analysis" ;;
    *) bad "unknown option: $a" ;;
  esac
  if [ -n "$used" ]; then
    shift
  fi
done
if [ "$files" -gt 1 ]; then
  bad "only one file"
fi
if [ "$files" -eq 0 ]; then
  bad "no file"
fi
need
if [ ! -f "$file" ]; then
  die "cannot open $file: No such file"
fi
h='{"kind":"audio.play"'
raw volume "$volume"
raw rate "$rate"
raw time "$time"
raw quality "$quality"
raw debug "$debug"
ask "$h}" <"$file" >&2 || exit 1
