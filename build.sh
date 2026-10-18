#!/bin/sh
#
# Builds jxltran-js.
#
# Steps:
#
#   1. clone https://github.com/libjxl/jxltran at a pinned commit into third_party/jxltran
#      (gitignored) and verify that the checkout really is that commit,
#   2. apply the patches from patches/ in order - a patch that is already applied is skipped, so
#      the script can be run repeatedly,
#   3. build the native reference binary into build/native/jxltran with cmake. The tests compare
#      the WebAssembly module against it, so it must come from exactly the same sources,
#   4. compile the sources plus src/jxltran_wrapper.cc with the installed Emscripten into
#      dist/jxltran.mjs and dist/jxltran.wasm - a library module without a main(), see
#      patches/0002-library-entry-point.patch. Brotli is vendored for this step too, because
#      Emscripten does not ship it (the native binary uses the system library).
#
# Usage:
#
#   ./build.sh --native     stop after the native binary; no Emscripten needed
#   ./build.sh              build everything
#
# Environment:
#
#   JXLTRAN_REPO            override the upstream repository URL
#
# Emscripten: the WebAssembly step uses the toolchain that is already installed on this machine.
# This script only looks for it (PATH, then EMSDK, then the usual system locations) and never
# installs anything - if it cannot be found the script stops and says so.
#
set -eu

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

JXLTRAN_REPO="${JXLTRAN_REPO:-https://github.com/libjxl/jxltran}"
JXLTRAN_COMMIT="ec2f8c224b9db78a3bda7ff26ddeb0b95fe0ed96"
SRC_DIR="$ROOT/third_party/jxltran"
PATCH_DIR="$ROOT/patches"
NATIVE_BUILD="$ROOT/build/native"

# Brotli is vendored for the WebAssembly build only: the native binary links the system library
# (cmake finds it) and Emscripten ships none. The pin matches the system package version, so the
# differential tests compare like with like.
BROTLI_REPO="${BROTLI_REPO:-https://github.com/google/brotli}"
BROTLI_COMMIT="028fb5a23661f123017c060daa546b55cf4bde29"
BROTLI_DIR="$ROOT/third_party/brotli"

die() {
  echo "error: $*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
usage: ./build.sh [--native]

  --native    stop after the native reference binary (no Emscripten needed)
  -h, --help  show this message

The WebAssembly module and the TypeScript build are produced by the default mode.
Set JXLTRAN_REPO to clone from somewhere else.
EOF
}

# Clones <repo> into <dir>, pins it to <commit> and verifies the checkout afterwards: every later
# step builds on exactly this revision. Both vendored trees go through here.
clone_pinned() {
  repo="$1"
  dir="$2"
  commit="$3"
  label="$4"

  command -v git >/dev/null 2>&1 || die "git is required to fetch the $label sources"

  if [ -d "$dir/.git" ]; then
    remote="$(git -C "$dir" remote get-url origin 2>/dev/null || true)"
    if [ "$remote" != "$repo" ]; then
      die "$dir has the origin '$remote', expected '$repo' - remove it and run again"
    fi
    head="$(git -C "$dir" rev-parse HEAD 2>/dev/null || true)"
    if [ "$head" != "$commit" ]; then
      echo "==> $dir is at ${head:-unknown}, checking out $commit"
      git -C "$dir" fetch --quiet origin
      git -C "$dir" checkout --quiet --detach "$commit" ||
        die "cannot check out $commit in $dir - remove it and run again"
    else
      echo "==> reusing the $label sources in $dir"
    fi
  elif [ -e "$dir" ]; then
    die "$dir exists but is not a git checkout - remove it and run again"
  else
    echo "==> cloning $repo"
    mkdir -p "$(dirname "$dir")"
    git clone --quiet "$repo" "$dir"
    git -C "$dir" checkout --quiet --detach "$commit" ||
      die "the pinned commit $commit is not reachable in $repo"
  fi

  head="$(git -C "$dir" rev-parse HEAD)"
  [ "$head" = "$commit" ] || die "expected $commit, found $head in $dir"
  echo "==> $label sources pinned at $commit"
}

fetch_sources() {
  clone_pinned "$JXLTRAN_REPO" "$SRC_DIR" "$JXLTRAN_COMMIT" "jxltran"
}

fetch_brotli() {
  clone_pinned "$BROTLI_REPO" "$BROTLI_DIR" "$BROTLI_COMMIT" "brotli"
}

# Applies patches/*.patch in order. A patch that is already present in the working tree is
# skipped, so re-running the script never double-applies anything.
apply_patches() {
  [ -d "$PATCH_DIR" ] || return 0
  for patch in "$PATCH_DIR"/*.patch; do
    [ -e "$patch" ] || continue
    name="$(basename "$patch")"
    if git -C "$SRC_DIR" apply --check --reverse "$patch" >/dev/null 2>&1; then
      echo "==> $name: already applied"
    elif git -C "$SRC_DIR" apply --check "$patch" >/dev/null 2>&1; then
      git -C "$SRC_DIR" apply "$patch"
      echo "==> $name: applied"
    else
      die "$name does not apply to $JXLTRAN_COMMIT - the pin and the patches are out of step"
    fi
  done
}

# Builds the native reference binary. This is what the differential tests call, so it must be
# built from the same patched sources as the WebAssembly module.
build_native() {
  command -v cmake >/dev/null 2>&1 || die "cmake is required to build the native binary"
  generator=""
  if command -v ninja >/dev/null 2>&1; then
    generator="-G Ninja"
  fi
  echo "==> building the native reference binary"
  # $generator is either empty or a two-word "-G Ninja"; both are meant to be split.
  # shellcheck disable=SC2086
  cmake -S "$SRC_DIR" -B "$NATIVE_BUILD" $generator -DCMAKE_BUILD_TYPE=Release
  cmake --build "$NATIVE_BUILD"
  echo "==> native binary: $NATIVE_BUILD/jxltran"
}

# Locates the Emscripten toolchain: em++ links the module, emcc compiles the C sources of brotli.
# This only *looks*: an existing installation is never installed, modified or upgraded. When the
# drivers cannot be found the script stops and says so.
find_emxx() {
  emxx_found=0
  emcc_found=0
  if command -v em++ >/dev/null 2>&1; then
    EMXX=em++
    emxx_found=1
  fi
  if command -v emcc >/dev/null 2>&1; then
    EMCC=emcc
    emcc_found=1
  fi
  if [ "$emxx_found" -eq 1 ] && [ "$emcc_found" -eq 1 ]; then
    return 0
  fi
  for env_script in "${EMSDK:-}/emsdk_env.sh" \
    "$HOME/emsdk/emsdk_env.sh" \
    /usr/share/emscripten/emsdk_env.sh \
    /etc/profile.d/emscripten.sh; do
    [ -f "$env_script" ] || continue
    # shellcheck disable=SC1090
    . "$env_script" >/dev/null 2>&1 || true
    if [ "$emxx_found" -eq 0 ] && command -v em++ >/dev/null 2>&1; then
      EMXX=em++
      emxx_found=1
    fi
    if [ "$emcc_found" -eq 0 ] && command -v emcc >/dev/null 2>&1; then
      EMCC=emcc
      emcc_found=1
    fi
    if [ "$emxx_found" -eq 1 ] && [ "$emcc_found" -eq 1 ]; then
      return 0
    fi
  done
  cat >&2 <<'EOF'
error: the Emscripten drivers em++ and emcc were not found.

This script only uses an Emscripten that is already installed - it never
installs, changes or upgrades one. Install Emscripten yourself (or ask the
maintainer), then put em++ and emcc on PATH or set EMSDK to the emsdk
directory.
EOF
  exit 1
}

# Builds the WebAssembly module: every translation unit of the pinned sources (jxltran.cc without
# its main(), because of -DJXLTRAN_LIBRARY) plus the wrapper, linked as an ES module that loads its
# own .wasm file from dist/.
build_wasm() {
  find_emxx
  fetch_brotli
  echo "==> building the WebAssembly module"
  mkdir -p "$ROOT/dist"
  # Version of the embedded sources, e.g. "jxltran ec2f8c2".
  version="jxltran $(printf '%.7s' "$JXLTRAN_COMMIT")"

  # Brotli is plain C: compiled with emcc, in C mode, into objects that the link step picks up.
  # -Os keeps the encoder - by far the biggest part of brotli - reasonably small. The objects are
  # named after their subdirectory because dec/static_init.c and enc/static_init.c share a name,
  # and they are rebuilt only when their source is newer.
  brotli_obj="$ROOT/build/brotli-obj"
  mkdir -p "$brotli_obj"
  for src in "$BROTLI_DIR"/c/common/*.c "$BROTLI_DIR"/c/dec/*.c "$BROTLI_DIR"/c/enc/*.c; do
    obj="$brotli_obj/$(basename "$(dirname "$src")")-$(basename "$src" .c).o"
    if [ ! -f "$obj" ] || [ "$src" -nt "$obj" ]; then
      "$EMCC" -Os -I "$BROTLI_DIR/c/include" -c "$src" -o "$obj"
    fi
  done

  # Positional parameters become the list of translation units: the upstream sources and the
  # wrapper, both C++; then the brotli objects. em++ is the C++ driver - it links the C++ runtime
  # that the translation units reference.
  set -- "$SRC_DIR"/src/*.cc "$ROOT/src/jxltran_wrapper.cc"
  "$EMXX" \
    -std=c++17 \
    -O3 \
    -DJXLTRAN_LIBRARY \
    -DJXLTRAN_HAVE_BROTLI \
    "-DMV_JXLTRAN_VERSION=\"$version\"" \
    -I "$SRC_DIR/src" \
    -I "$BROTLI_DIR/c/include" \
    "$@" \
    "$brotli_obj"/*.o \
    -sMODULARIZE=1 \
    -sEXPORT_ES6=1 \
    -sEXPORT_NAME=createJxlTran \
    -sALLOW_MEMORY_GROWTH=1 \
    -sENVIRONMENT=node,web,worker \
    -sEXPORTED_FUNCTIONS=_mv_jxltran_run,_mv_free,_mv_version,_mv_last_message,_malloc,_free \
    -sEXPORTED_RUNTIME_METHODS=HEAPU8,HEAPU32,UTF8ToString,stringToUTF8,lengthBytesUTF8,FS \
    -sINCOMING_MODULE_JS_API=print,printErr,locateFile,instantiateWasm,wasmBinary \
    -o "$ROOT/dist/jxltran.mjs"
  echo "==> wasm module: dist/jxltran.mjs + dist/jxltran.wasm ($(wc -c <"$ROOT/dist/jxltran.wasm") bytes)"
}

NATIVE_ONLY=0
for argument in "$@"; do
  case "$argument" in
    --native) NATIVE_ONLY=1 ;;
    -h | --help)
      usage
      exit 0
      ;;
    *) die "unknown argument '$argument' (try --help)" ;;
  esac
done

fetch_sources
apply_patches
build_native

if [ "$NATIVE_ONLY" -eq 0 ]; then
  build_wasm
fi

echo "==> done"
