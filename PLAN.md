# Plan: jxltran-js

Implementation plan derived from `TODO.md`. Phases are ordered; each one ends in a state that can be
built and tested on its own.

Decisions confirmed while writing this plan:

- **Vendoring:** `build.sh` clones `https://github.com/libjxl/jxltran` at a pinned commit into
  `third_party/jxltran` (gitignored) and applies the patch files from `patches/`. Same pattern as the
  checksum-pinned libjpeg download in `jpegtran-js`.
- **API depth:** typed core options (orientation, crop, container, jxlp, strip, info, frames) plus an
  `extraArgs: string[]` escape hatch, so every upstream flag stays reachable. The CLI forwards all
  flags verbatim, so flag compatibility does not depend on how much the API types.

## Verified facts (measured, not assumed)

- Upstream commit used as the pin: `ec2f8c224b9db78a3bda7ff26ddeb0b95fe0ed96` (2026-10-14).
- Upstream is C++17 + CMake, 20 translation units, ~21.6k lines, **no libjxl dependency**, optional
  Brotli. No `throw`, no RTTI, so plain Emscripten defaults work.
- All 20 sources pass `em++ -std=c++17 -fsyntax-only`. A full `-O2` compile and link of every object
  succeeds: `jxltran.wasm` is **~535 KB uncompressed, ~190 KB gzipped** with all symbols retained
  (probe without Brotli and without the patches; the real module is measured in Phase 2).
- Native build works after one fix; the whole tree builds in seconds.
- **Upstream bug 1 (confirmed: `web-demo/` never existed):** `CMakeLists.txt` lines 92-115 wire a
  custom target to `${CMAKE_CURRENT_SOURCE_DIR}/web-demo/build.sh`. Checked against the original
  repository:
  - `git log --all -- web-demo` is empty and `git log --diff-filter=A --name-only` over the *whole*
    history lists only `CMakeLists.txt`, `LICENSE`, `README.md` and `src/*` — the folder was never
    committed, and the repo never had a `.gitignore`, so nothing was filtered out either.
  - Only one branch (`main`), no tags, no fork-visible copy; the block appeared in `4a8747e`
    ("more stuff", 2026-05-14); `raw.githubusercontent.com/.../web-demo/*` returns 404.
  - Effect: any configure with `emcc` on PATH fails at build time
    (`ninja: error: 'web-demo/build.sh', needed by 'web-demo/jxltran.js', missing`).
    Bypass without patching: `-DJXLTRAN_EMCC=NOTFOUND`.

  The block does tell us something useful: upstream builds the wasm module from **the same `.cc`
  tree** with emcc, which is exactly our approach. Since the files only exist in the author's
  working tree, **our patch comments the block out** (dead code) and `build.sh` in this repository
  is the wasm build. There is **no ready-made wasm build upstream**.
- **Upstream bug 2:** `src/toc_layout.h` uses `uint8_t` without `#include <cstdint>`; fails on
  GCC 16 (and on em++/clang in stricter modes). Already reported upstream as issues #2 and #3, with
  open PR #3 "Add missing cstdint header" — our patch mirrors it and can be dropped once merged.
- **`/usr/bin/jxltran` on this machine is a different, older program** (only `--pack` / `--extract`).
  It must never be used as a reference. The reference binary for compatibility tests is the native
  build of the same vendored commit.
- Toolchain present: `emcc` 6.0.9, `cmake` 4.4.3, `ninja`, `brotli` 1.2.0, `cjxl`/`djxl` 0.12.0,
  Node 24 (runs `.ts` directly via type stripping).
- Seam in `src/jxltran.cc` (4417 lines): `struct Args` at line 2174, `AddCommandLineOptions`
  (67 flags) at 2304, `main()` at 3344-4417. `main` is parse -> validate -> `ReadFile` (line 3551)
  -> **purely in-memory pipeline** -> `WriteFile` (line 4377). Afterwards `argv` is only used for
  `argv[0]` in the printed `reversible_undo` hint. `ReadFile`/`WriteFile` are the only file calls.
- Flags that reference files: `--set-exif`, `--set-xmp`, `--set-jumbf`, `--extract-icc`,
  `--extract-exif`, `--extract-xmp`, `--extract-jumbf`, `--extract-splines`, `--set-splines-from`,
  `--append-jxl`. These need a small in-memory file provider (Emscripten MEMFS) in the wrapper.
- Text printed to stdout that must be captured in JS: `--info` output (`dimensions: ...`,
  `frame_region: ...`), the `reversible_undo:` hint, `reversible_check:` lines.
- Fixture state: `test/fixtures/lenna.jxl` is a bare codestream, 512x512, XYB, 8 bit, no alpha,
  no animation, no container boxes.

## Phase 0 — Put the repository on jxltran ✅ (2026-10-18)

- [x] `package.json`: name `@chimok/jxltran-js`, description and keywords for JPEG XL, `bin` key
      `jxltran-js -> ./dist/cli.js`, `license: "BSD-3-Clause"` (matches the `LICENSE` file in the
      repo), scripts pointing at the real files: `build`, `build:js`, `build:native`, `test`,
      `typecheck`, `cli`. Repository/bugs/homepage now point at `SpotlightOn/jxltran-js`.
      Activation of the scripts: `typecheck` live now, `test` with Phase 3 (`src/index.ts`),
      `build:js` with Phase 3, `cli` with Phase 4, `build` and `build:native` with Phase 1/2.
- [x] Rewrote `test/simple.ts` for JXL: import from `../src/index.ts`, fixture
      `./fixtures/lenna.jxl`, JPEG marker helpers (SOI/EOI/SOF/APP0) and the `djpeg`/`jpegtran`
      comparisons are gone. The expectations (orientation 90 -> EXIF tag 6, crop -> 200x150,
      container round trip byte-identical) were verified against a native build of the same
      upstream commit. It runs from Phase 3 on.
- [x] `.gitignore`: added `third_party/` and `build/`; `dist/`, `test/out/`, `node_modules/` kept.
- [x] `tsconfig.json`: dropped the stale `test.ts` root entry from `include`.
- Baseline after this phase: `pnpm install --frozen-lockfile` OK, `node --check test/simple.ts` OK,
  `pnpm typecheck` reports exactly one error — `TS2307: Cannot find module '../src/index.ts'` —
  which Phase 3 resolves. Everything else is green.

## Phase 1 — Fetch upstream (TODO 1) ✅ (2026-10-18)

- [x] `build.sh`: clones `https://github.com/libjxl/jxltran` (URL overridable via `JXLTRAN_REPO`),
      checks the pinned commit `ec2f8c224b9db78a3bda7ff26ddeb0b95fe0ed96` out into
      `third_party/jxltran` (gitignored) and **verifies `rev-parse HEAD`** afterwards, aborting on
      any mismatch. Existing checkouts are reused; a foreign origin, a non-git directory or an
      unreachable pin all stop with a clear message instead of deleting anything. Then
      `patches/*.patch` are applied in order with `git apply`: already-applied patches are skipped
      (`--check --reverse`), a patch that no longer fits aborts the run. Runs 2 and 3 confirmed
      idempotent.
- [x] `patches/0001-build-fixes.patch` (68 lines, plain `git diff`, applies with `-p1`):
      adds `#include <cstdint>` to `src/toc_layout.h`, and comments out the dead `web-demo` block
      in `CMakeLists.txt` (with a note explaining that no commit ever added a file under
      `web-demo/`). This is what makes configure work with emcc on PATH.
- [x] `build.sh --native` builds the reference binary: cmake + Ninja into `build/native/jxltran`
      (21 objects, ~15 s cold, `ninja: no work to do` warm). `package.json` `build:native` now calls
      `./build.sh --native` instead of repeating the cmake invocation.
- [x] `patches/0002-library-entry-point.patch` — landed together with the wrapper in Phase 2.
- Note: the default mode of `build.sh` now runs fetch → patch → native → wasm (the usage text
  describes it as it stands). `shellcheck` is not installed on this machine and was **not**
  installed for this task; `sh -n build.sh` is the syntax gate used instead.

## Phase 2 — WebAssembly build (TODO 2) ✅ (2026-10-18)

`patches/0002-library-entry-point.patch` (131 lines, +78/−3) restructures `jxltran.cc` and adds
`src/jxltran_api.h`. Implemented as agreed, with these deviations from the first draft of this plan:

- [x] The entry point is `int jxltran::RunCommandLine(int argc, const char** argv,
      const std::vector<uint8_t>* input_bytes, std::vector<uint8_t>* out_result,
      std::string* undo_command)` instead of the planned `RunJxltran(const Args& ...)`: it owns the
      whole command line (parse + validate + in-memory pipeline). `input_bytes != nullptr` skips
      `ReadFile`, `*out_result` receives what `WriteFile` would have written, `*undo_command` carries
      the `reversible_undo:` line (next to `PrintReversibleUndoLine`), and `nullptr` input keeps the
      original CLI file mode. `const char**` because `CommandLineParser::Parse(int, const char*[])`
      takes exactly that.
- [x] Native `main()` is a thin shim below `#ifndef JXLTRAN_LIBRARY`
      (`return jxltran::RunCommandLine(argc, argv, nullptr, nullptr, nullptr);`), so native behaviour
      stays identical — confirmed by a 12/12 byte-identical regression against the pre-patch binary.
- [x] **No file-provider abstraction** (deviation): the sidecar flags (`--set-exif`, `--extract-*`,
      `--append-jxl`, `--set-splines-from`) keep using `fopen`; in the module they resolve against
      Emscripten MEMFS and the JavaScript caller stages input files with the exported `FS` before a
      run and reads produced files back afterwards. Matches the actual seam: `ReadFile`/`WriteFile`
      are the only file calls.
- [x] New `src/jxltran_wrapper.cc`, C ABI modelled on `jpegtran_wrapper.c`:
  - `int mv_jxltran_run(const char** argv, const uint8_t* input, size_t input_size,
    uint8_t** out_data, size_t* out_size, char** undo_command)` — the status is the return value, so
    there is **no `mv_jxltran_info`**: the `--info` text reaches JS over `Module.print` like every
    other stdout line; `std::fflush(stdout/stderr)` after every call so nothing stays in the C
    streams; NULL-terminated argv is counted inside.
  - `mv_free`, `mv_last_message` (wrapper-level failures only; the tool's own diagnostics go to
    stderr), `mv_version` (`"jxltran ec2f8c2"`, injected by `build.sh` via `-DMV_JXLTRAN_VERSION`).
  - No `main` and no CLI parser of its own in the wasm image (`-DJXLTRAN_LIBRARY`).
- [x] `build.sh build_wasm`: `find_emxx` locates `em++` (the C++ driver) **and** `emcc` (brotli C
      objects) via PATH → EMSDK → `emsdk_env.sh` and aborts with a clear message when missing — it
      never installs anything. Compile: `em++ -std=c++17 -O3 -DJXLTRAN_LIBRARY
      -DJXLTRAN_HAVE_BROTLI "-DMV_JXLTRAN_VERSION=..." -I third_party/jxltran/src
      -I third_party/brotli/c/include` over the 20 upstream `.cc` plus the wrapper, and the brotli
      `c/{common,dec,enc}` sources with `emcc -Os` into incrementally rebuilt, directory-tagged
      objects under `build/brotli-obj/` (`dec/static_init.c` and `enc/static_init.c` share a name).
      Link with `-sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createJxlTran -sALLOW_MEMORY_GROWTH=1
      -sENVIRONMENT=node,web,worker -sEXPORTED_FUNCTIONS=_mv_jxltran_run,_mv_free,_mv_version,_mv_last_message,_malloc,_free
      -sEXPORTED_RUNTIME_METHODS=HEAPU8,HEAPU32,UTF8ToString,stringToUTF8,lengthBytesUTF8,FS
      -sINCOMING_MODULE_JS_API=print,printErr,locateFile,instantiateWasm,wasmBinary`
      into `dist/jxltran.mjs` + `dist/jxltran.wasm`. Linking with `emcc` alone fails
      (`undefined symbol: operator new`) — C++ translation units must go through `em++`.
- [x] stdout/stderr captured per call through the factory's `print`/`printErr` handlers.
- [x] `build:native` — cmake + Ninja Release build of the same pinned and patched tree (Phase 1);
      the differential-test reference. With brotli support enabled (`system brotli`).
- [x] **Brotli is in (the old "Phase 2b"), decided 2026-10-18 for full flag parity:**
      second pinned clone of `google/brotli` at `028fb5a23661f123017c060daa546b55cf4bde29`
      (tag v1.2.0 = the system brotli 1.2.0, so native and wasm compare like with like), compiled in
      by `emcc`, `-DJXLTRAN_HAVE_BROTLI`. Effect: `--brob=compress|decompress`, brob metadata
      extraction and the complete `--help` text match the native binary. **Module size:
      1 203 907 B raw / 502 283 B gzipped** (without brotli: 547 223 / 196 676 — the delta is
      dominated by brotli encoder dictionary tables, `-Oz` would not change much). brotli is
      **Apache-2.0** → attribution in README/LICENSE is a Phase 6 packaging task.
- Verification done: native regression 12/12 byte-identical against the pre-patch binary; wasm smoke
  test 31/31 — `--info`, `--set-orientation`, `--crop`, `--container yes` byte-identical OUTPUT
      bytes plus stdout and `undo_command` parity, identical `--help` (including the brob section),
      no-args, unknown-flag and corrupt-input behaviour, and a full brotli round trip
      (`--set-xmp --container yes` → `--brob=compress:xmp` → `--extract-xmp` from the brob box →
      `--brob=decompress` reproduces the original container, every step equal to native). A second
      `./build.sh` run reuses sources, patches and brotli objects.

## Phase 3 — TypeScript API (TODO 3) ✅ (2026-10-18)

- [x] `src/index.ts`:
  - hand-written `JxlTranModule` type (the wasm ships without declarations) plus
      `JxlTranFileSystem`; `@ts-ignore` on the `../dist/jxltran.mjs` import, as in jpegtran-js,
  - `export async function createJxlTran(): Promise<JxlTranTransformer>`; the factory installs the
      `print`/`printErr` handlers that capture stdout and stderr per call (the capture arrays are
      owned by the transformer),
  - `JxlTranTransformer` with `info(input)` - parses `dimensions`, `exif_orientation`, `animation`,
      `has_alpha_channel` and every `frame_region:` line into `ImageInfo` (`width`, `height`,
      `orientation`, `animation`, `alpha`, `frames[]`, raw `text`) - `transform(input, options)`
      and `version()`,
  - convenience methods `setOrientation()`, `crop()`, `strip()`, `container()`, `jxlp()`,
  - **`run(args, input)` - the raw layer**, added for Phase 4: runs a complete command line
      (`--info`, `--help`, `--extract-*`, everything) and returns
      `{ status, data, undo, stdout, stderr }`, so the CLI can forward flags verbatim without
      duplicating the heap marshalling,
  - `fs` getter: flags that name a file (`--set-exif`, `--extract-*`, `--append-jxl`) resolve
      against the module's MEMFS - `mkdirTree`/`writeFile` before a run, `readFile` after,
  - constants (`CONTAINER`, `JXLP`, `STRIP`, `ORIENTATION`) and `TransformError` (message = first
      stderr line, plus `status` and the full `stderr`; jpegtran's `msgCode` has no equivalent
      here, the tool prints plain text),
  - one private `toArgv(options)` mapping plus `extraArgs: string[]`,
  - memory handling: `_malloc`, copy in, read the three output slots after the call with fresh
      `HEAPU8`/`HEAPU32` reads (the heap may have grown), `mv_free`.
- [x] Naming, error style and result shapes follow `../jpegtran-js/src/index.ts`, with two
      deliberate differences: `TransformResult` is `{ data, undo }` instead of
      `{ data, width, height }` (jxltran reports dimensions through `info()`, and the
      `reversible_undo` line is its own feature), and in-memory runs use the placeholders
      `jxltran-js` / `INPUT.jxl` / `OUTPUT.jxl` in argv, because nothing is written to disk.
- Verification: `pnpm typecheck` green; `node test/simple.ts` 15/15; a differential check against
      `build/native/jxltran` with 16/16 (`--info` stdout byte-identical, `setOrientation`, `crop`
      and `container` outputs byte-identical, undo placeholders as documented, tool-side validation
      errors surfacing as `TransformError`); `pnpm build:js` emits `dist/index.js` +
      `dist/index.d.ts`, and the compiled file loads the wasm on its own.

## Phase 4 — CLI (TODO 4)

- [x] `src/cli.ts` -> `dist/cli.js`, exposed as `jxltran-js`.
- [x] Signature of the upstream tool: `jxltran-js INPUT [OUTPUT] [OPTIONS...]`, `--info` without
      OUTPUT, `-h/--help`.
- [x] Parsing strategy: every flag is forwarded verbatim to the parser inside the wasm module, so
      validation, defaults and error messages match the native binary by construction. TypeScript
      only locates the positionals and the files named by value flags:
      - a **probe run with empty input** first: the tool validates a whole command line before it
        would open INPUT, and an empty input always stops at the known
        `Input file is not a JPEG XL file.` check - so parse/validation errors and `-h/--help`
        (including the required-INPUT usage path, exit 0) are forwarded in the native order
        without touching any file, and only a run that reaches the signature check continues with
        the real bytes,
      - the value-flag arity table is derived from the tool's own `--help` text
        (`--name=METAVAR` marks a value flag), so it cannot drift from the embedded flag surface,
      - input sidecars (`--set-exif/-xmp/-jumbf`, `--set-splines-from`, `--append-jxl`) are staged
        host -> MEMFS (missing files are left to the tool, which prints the native message),
        `--extract-*` targets get their parent directory in MEMFS only when it exists on the host
        and are copied back MEMFS -> host after a successful run, before OUTPUT is written,
      - stream order on success mirrors the native tool: stderr, files, stdout last (the
        `reversible_undo` line only appears after OUTPUT exists, so a write failure keeps stdout
        as quiet as the native binary),
      - an input that is a directory reads as an empty buffer, matching the native
        `fread`-of-zero-bytes behaviour (`Input file is not a JPEG XL file.`, exit 1).
- [x] File I/O through `node:fs`, errors to stderr with exit code 1, `--info` text to stdout.
- [x] `--version` intercepted in TypeScript (decided 2026-10-18, mirroring the `-version` handling in
      `jpegtran-js`): prints `jxltran-js <package version> (jxltran ec2f8c2)` and exits 0. The
      upstream binary rejects `--version` — this is a deliberate, documented extension; every other
      flag is still forwarded verbatim.
- Verification: `pnpm typecheck` green; `pnpm test` 15/15; a differential check against
      `build/native/jxltran` with **32/32** identical outcomes (stdout, stderr, exit code and every
      produced file byte-identical, argv[0] normalised): help/usage paths, `--info`,
      `--info-structure`, transforms (orientation, crop, container, undo lines), missing input,
      unknown flags with and without a missing input, help with a missing input, unwritable
      OUTPUT, three positionals, `--` positionals, empty and directory inputs, XMP sidecar staging
      in both flag forms, extract copy-back (present, absent, missing directory), a set->extract
      chain, plus the documented `--version` deviation.

## Phase 5 — Tests (TODO 5)

- [ ] Fixtures next to `test/fixtures/lenna.jxl` (generated with `cjxl`, kept small): a container
      variant with Exif/XMP boxes, one with alpha, one animated; document how they were made.
- [ ] `test/simple.ts`: module loads, `--info` matches the native binary, `--set-orientation` 90/270
      plus undo, `--crop`, container remux, `--strip`, `--jxlp merge` — each **byte-identical** to
      `build/native/jxltran`; pixel round trip decoded with `djxl` and compared as PPM.
- [ ] `test/cli.ts`: run `node dist/cli.js` and the native binary with the same arguments, compare
      stdout, stderr and exit codes, including `-h`.
- [ ] Skip logic when `djxl` or the native binary is missing, mirroring the `has()` helper from
      jpegtran-js; `pnpm run build:native` prepares the reference.

## Phase 6 — Docs and packaging

- [ ] `README.md` (build requirements: Emscripten, CMake, Ninja), `docs/api.md` along the lines of
      `../jpegtran-js/docs/api.md`, `CHANGELOG.md` entries under `[Unreleased]`.
- [ ] Ship upstream `LICENSE` (BSD-3-Clause) in `files`; `pnpm pack` sanity check.
- [ ] Brotli is linked into the wasm module: ship its **Apache-2.0** license/attribution (README
      credits + license file in `files`).
- [ ] Optional: CI workflow with `emscripten-core/setup-emsdk` running build + tests.

## Risks

- **The ~1000-line split of `main()` is a patch against upstream.** Mitigation: pinned commit, patch
  files in the repo, differential tests against the native binary of the same commit; re-applying the
  patch is part of every build, so drift shows up immediately.
- **Patch maintenance:** `0001-build-fixes` duplicates upstream issues #2/#3 and open PR #3 — drop it
  as soon as that PR merges. `0002-library-entry-point` is the one that needs rebasing when upstream
  touches `jxltran.cc`.
- **Fallback without patch:** rename `main` and let it run against Emscripten MEMFS. Smaller effort,
  but ships the whole CLI in the wasm module, which contradicts TODO item 2. Not the chosen path.
- **Size of the flag surface:** 67 flags. The CLI forwards them all; the typed API covers the core
  and grows via `extraArgs` as needed.
- **Module size:** `dist/jxltran.wasm` is 1 203 907 B raw / 502 283 B gzipped with Brotli (about
  657 KB / 305 KB more than without). Gzip/Brotli transport on npm/CDNs covers most of it; if it ever
  matters, a build flag can drop `--brob=compress` (encoder) and shrink the module again.
- **Fixtures:** one 512x512 bare codestream is not enough coverage; the extra fixtures are required
  for the container and metadata tests to mean anything.
