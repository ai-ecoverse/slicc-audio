#!/bin/sh
set -eu

NAME="slicc-audio"
REPO="ai-ecoverse/slicc-audio"
COMMANDS="scsay schear scplay scchime"
MIN_NODE=24
DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/slicc-audio"

usage() {
  printf 'Usage: sh -s -- [--version VERSION] [--dir DIR] [--help]\n'
  printf '\nInstall %s (%s), with Node %s+ (downloaded if missing).\n' "$NAME" "$COMMANDS" "$MIN_NODE"
  printf '\nOptions:\n'
  printf '  --version VERSION   install that release instead of the latest\n'
  printf '  --dir DIR           the launcher directory (default: %s/.local/bin)\n' "\$HOME"
  printf '  --help              print this usage and exit\n'
}

die() {
  printf '%s: %s\n' "$NAME" "$1" >&2
  exit "${2:-1}"
}

VERSION=""
INSTALL_DIR="$HOME/.local/bin"
BASE_URL="${SLICC_INSTALL_BASE_URL:-}"
NODE_DIST_BASE="${SLICC_NODE_DIST_BASE:-https://nodejs.org/dist}"

while [ $# -gt 0 ]; do
  case "$1" in
    --version)
      [ $# -ge 2 ] || die "--version needs a value" 2
      VERSION="${2#v}"
      shift 2
      ;;
    --dir)
      [ $# -ge 2 ] || die "--dir needs a value" 2
      INSTALL_DIR="$2"
      shift 2
      ;;
    --help)
      usage
      exit 0
      ;;
    *) die "unknown option: $1" 2 ;;
  esac
done

detect_os() {
  case "$(uname -s)" in
    Darwin) printf 'darwin' ;;
    Linux) printf 'linux' ;;
    *) die "no official Node for $(uname -s); install Node $MIN_NODE+ and run npm install -g @ai-ecoverse/slicc-audio" ;;
  esac
}

detect_arch() {
  case "$(uname -m)" in
    x86_64 | amd64) printf 'x64' ;;
    arm64 | aarch64) printf 'arm64' ;;
    *) die "unsupported architecture: $(uname -m)" ;;
  esac
}

is_musl() {
  for f in /lib/ld-musl-*; do
    if [ -e "$f" ]; then return 0; fi
  done
  if command -v ldd >/dev/null 2>&1; then
    if ldd --version 2>&1 | grep -qi musl; then return 0; fi
  fi
  return 1
}

fetch() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL -o "$2" "$1" || die "cannot download $1"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$2" "$1" || die "cannot download $1"
  else
    die "curl or wget required"
  fi
}

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d' ' -f1
  else
    die "sha256sum or shasum required"
  fi
}

verify() {
  _actual="$(sha256 "$1")"
  if [ "$_actual" != "$2" ]; then
    printf '%s: checksum mismatch for %s\n  expected: %s\n  actual:   %s\n' "$NAME" "$(basename "$1")" "$2" "$_actual" >&2
    exit 1
  fi
}

sum_of() {
  awk -v f="$2" '{ n = $2; sub(/^\*/, "", n) } n == f { print $1; exit }' "$1"
}

node_ok() {
  _ver="$("$1" --version 2>/dev/null)" || return 1
  _major="$(printf '%s' "$_ver" | sed 's/^v//' | cut -d. -f1)"
  [ "$_major" -ge "$MIN_NODE" ] 2>/dev/null
}

find_node() {
  if command -v node >/dev/null 2>&1 && node_ok node; then
    command -v node
    return 0
  fi
  if [ -x "$DATA_DIR/node/bin/node" ] && node_ok "$DATA_DIR/node/bin/node"; then
    printf '%s\n' "$DATA_DIR/node/bin/node"
    return 0
  fi
  return 1
}

pick_node() {
  tr '{' '\n' <"$1" |
    sed -n 's/.*"version":"v\([0-9][0-9]*\)\.\([0-9][0-9.]*\)".*"lts":\([^,}]*\).*/\1 \2 \3/p' |
    awk -v min="$MIN_NODE" '$1 + 0 >= min + 0 && $3 != "false" { print "v" $1 "." $2; exit }'
}

download_node() {
  OS="$(detect_os)"
  ARCH="$(detect_arch)"
  if [ "$OS" = "linux" ] && is_musl; then
    die "musl Linux has no official Node build; install Node $MIN_NODE+ with your package manager (for example apk add nodejs-current), then run this again"
  fi
  printf '%s: no Node %s+ found; downloading it\n' "$NAME" "$MIN_NODE" >&2
  fetch "$NODE_DIST_BASE/index.json" "$TMP/index.json"
  NODE_VERSION="$(pick_node "$TMP/index.json")"
  [ -n "$NODE_VERSION" ] || die "no Node $MIN_NODE+ LTS release at $NODE_DIST_BASE"
  ARCHIVE="node-$NODE_VERSION-$OS-$ARCH.tar.xz"
  fetch "$NODE_DIST_BASE/$NODE_VERSION/SHASUMS256.txt" "$TMP/SHASUMS256.txt"
  EXPECTED="$(sum_of "$TMP/SHASUMS256.txt" "$ARCHIVE")"
  [ -n "$EXPECTED" ] || die "no checksum for $ARCHIVE in SHASUMS256.txt"
  fetch "$NODE_DIST_BASE/$NODE_VERSION/$ARCHIVE" "$TMP/$ARCHIVE"
  verify "$TMP/$ARCHIVE" "$EXPECTED"
  mkdir -p "$DATA_DIR"
  rm -rf "$DATA_DIR/.node-$$"
  mkdir -p "$DATA_DIR/.node-$$"
  if command -v xz >/dev/null 2>&1; then
    xz -dc "$TMP/$ARCHIVE" | tar xf - -C "$DATA_DIR/.node-$$" --strip-components=1
  else
    tar xJf "$TMP/$ARCHIVE" -C "$DATA_DIR/.node-$$" --strip-components=1
  fi
  rm -rf "$DATA_DIR/node"
  mv "$DATA_DIR/.node-$$" "$DATA_DIR/node"
  printf '%s: installed Node %s to %s\n' "$NAME" "$NODE_VERSION" "$DATA_DIR/node" >&2
  printf '%s\n' "$DATA_DIR/node/bin/node"
}

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

NODE_BIN="$(find_node)" || NODE_BIN="$(download_node)"
NODE_DIR="$(cd "$(dirname "$NODE_BIN")" && pwd)"
NODE_ABS="$NODE_DIR/$(basename "$NODE_BIN")"

if [ -z "$BASE_URL" ]; then
  if [ -z "$VERSION" ]; then
    BASE_URL="https://github.com/$REPO/releases/latest/download"
  else
    BASE_URL="https://github.com/$REPO/releases/download/v$VERSION"
  fi
fi
BASE_URL="${BASE_URL%/}"

fetch "$BASE_URL/SHA256SUMS" "$TMP/SHA256SUMS"
if [ -n "$VERSION" ]; then
  TGZ="slicc-audio-$VERSION.tgz"
else
  TGZ="$(awk '{ n = $2; sub(/^\*/, "", n) } n ~ /^slicc-audio-[0-9][^\/]*\.tgz$/ { print n; exit }' "$TMP/SHA256SUMS")"
  [ -n "$TGZ" ] || die "no slicc-audio-<version>.tgz in SHA256SUMS"
fi
EXPECTED="$(sum_of "$TMP/SHA256SUMS" "$TGZ")"
[ -n "$EXPECTED" ] || die "no checksum for $TGZ in SHA256SUMS"
fetch "$BASE_URL/$TGZ" "$TMP/$TGZ"
verify "$TMP/$TGZ" "$EXPECTED"

PKG_VERSION="${TGZ#slicc-audio-}"
PKG_VERSION="${PKG_VERSION%.tgz}"
TARGET="$DATA_DIR/$PKG_VERSION"
STAGE="$DATA_DIR/.install-$$"
mkdir -p "$DATA_DIR"
rm -rf "$STAGE"
mkdir -p "$STAGE"
tar xzf "$TMP/$TGZ" -C "$STAGE" --strip-components=1

if [ -x "$NODE_DIR/npm" ]; then
  NPM="$NODE_DIR/npm"
elif command -v npm >/dev/null 2>&1; then
  NPM="$(command -v npm)"
else
  rm -rf "$STAGE"
  die "npm not found next to $NODE_ABS"
fi
if ! (cd "$STAGE" && PATH="$NODE_DIR:$PATH" "$NPM" install --omit=dev --ignore-scripts --no-audit --no-fund >"$TMP/npm.log" 2>&1); then
  cat "$TMP/npm.log" >&2
  rm -rf "$STAGE"
  die "npm install failed"
fi

rm -rf "$TARGET"
mv "$STAGE" "$TARGET"
ln -sfn "$PKG_VERSION" "$DATA_DIR/current"

mkdir -p "$INSTALL_DIR"
INSTALL_DIR="$(cd "$INSTALL_DIR" && pwd)"
for cmd in $COMMANDS; do
  LAUNCHER="$INSTALL_DIR/$cmd"
  printf '#!/bin/sh\nexec "%s" "%s" "$@"\n' "$NODE_ABS" "$DATA_DIR/current/host/$cmd.mjs" >"$LAUNCHER.$$"
  chmod 755 "$LAUNCHER.$$"
  mv -f "$LAUNCHER.$$" "$LAUNCHER"
done

json_string() {
  printf '"%s"' "$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g')"
}
printf '{"version":%s,"dir":%s}\n' "$(json_string "$PKG_VERSION")" "$(json_string "$INSTALL_DIR")" >"$DATA_DIR/install.json.$$"
mv -f "$DATA_DIR/install.json.$$" "$DATA_DIR/install.json"

for old in "$DATA_DIR"/*; do
  case "$(basename "$old")" in
    "$PKG_VERSION" | node | current | install.json) ;;
    [0-9]*) rm -rf "$old" ;;
  esac
done

INSTALLED=""
for cmd in $COMMANDS; do
  OUT="$("$INSTALL_DIR/$cmd" --version)" || die "$INSTALL_DIR/$cmd --version failed"
  INSTALLED="${OUT#"$cmd" }"
done
printf '%s %s installed to %s\n' "$NAME" "$INSTALLED" "$INSTALL_DIR"

case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *) printf 'Add %s to your PATH: export PATH="%s:%s"\n' "$INSTALL_DIR" "$INSTALL_DIR" "\$PATH" ;;
esac
