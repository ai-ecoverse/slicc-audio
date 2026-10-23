usage() {
  printf 'usage: %s\n' "$me"
}
meta "$@"
for a; do
  case $a in
    -h | --help)
      usage
      exit 0
      ;;
    --upgrade | --version) bad "$a takes no other arguments" ;;
    -?*) bad "unknown option: $a" ;;
    *) bad "unexpected argument: $a" ;;
  esac
done
need
ask '{"kind":"audio.play","sound":"chime"}' </dev/null || exit 1
