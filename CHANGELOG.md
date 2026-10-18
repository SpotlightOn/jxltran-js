# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- WebAssembly build of jxltran: `build.sh` fetches [libjxl/jxltran](https://github.com/libjxl/jxltran)
  and [google/brotli](https://github.com/google/brotli) at pinned commits, applies the patches from
  `patches/`, builds the native reference binary and compiles `dist/jxltran.mjs` +
  `dist/jxltran.wasm` (a library module without a `main()`, no CLI inside).
- TypeScript API (`src/index.ts`): `createJxlTran()` and the transformer with `info()`,
  `transform()`, `setOrientation()`, `crop()`, `strip()`, `container()`, `jxlp()`, the raw `run()`,
  the `fs` accessor for the file-naming flags, the constants (`ORIENTATION`, `CONTAINER`, `JXLP`,
  `STRIP`) and `TransformError`. `extraArgs` forwards every upstream flag verbatim.
- Command line `jxltran-js` (`dist/cli.js`): the upstream flag surface forwarded to the module,
  host file I/O around it, plus the documented extension `--version` (upstream has none).
- Tests: `test/simple.ts` (65 checks, including byte-identical comparison against
  `build/native/jxltran` and djxl pixel round trips) and `test/cli.ts` (32 differential cases
  comparing stdout, stderr, exit status and produced files). Both skip their native sections when
  the reference binary, `dist/cli.js` or `djxl` is missing.
- Fixture corpus in `test/fixtures/` (bare, container with Exif/XMP, alpha, animated, jxlp-split)
  with a README documenting how each file was made.
- Documentation: README and `docs/api.md`; CI workflow building the module and running the tests.
