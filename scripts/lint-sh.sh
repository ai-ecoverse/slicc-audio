#!/bin/sh
set -e
shellcheck -s sh -e SC1090,SC1091,SC2034 bin/*
for f in bin/* sh/*; do
  dash -n "$f"
done
for c in say hear afplay; do
  printf 'me=%s\n' "$c" | cat - sh/common.sh "sh/$c.sh" | shellcheck -s sh -
done
printf 'me=chime\n' | cat - sh/common.sh sh/chime.sh | shellcheck -s sh -e SC2034 -
printf 'lint-sh: PASS\n'
