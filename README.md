# jxltran-js

Lossless JPEG XL transformations as a WebAssembly module, built from
**[jxltran](https://github.com/libjxl/jxltran)** - the inspection and editing tool of the libjxl
ecosystem - at a pinned commit, together with [Brotli](https://github.com/google/brotli) for the
`brob` boxes.

It does what the command line does, in memory: no filesystem, no subprocess, no native binary.

```sh
jxltran --set-orientation=90 in.jxl out.jxl
```

becomes

```ts
const transformer = await createJxlTran();
const { data, undo } = transformer.setOrientation(bytes, 90);
```

The codestream is edited, never re-encoded - a transformation causes no quality loss. Everything
upstream supports is available: orientation, crop, container remux, jxlp handling, Exif/XMP/JUMBF
metadata, ICC extraction, brob compression, frame selection. Every flag is forwarded to the same
code the native binary runs, so parsing, defaults and error messages match by construction.

**I will maintain and update this package, so don't worry because it's new. I use it for my app
[meshviewer](https://github.com/SpotlightOn/meshviewer).**

> **Note:** This code is still young and mostly untested in the wild. Feedback is welcome.

## Installation

```sh
npm install @chimok/jxltran-js
```

Requires Node.js 22.6 or newer.

## Layout

| path | what |
|---|---|
| `src/jxltran_wrapper.cc` | the exported C API of the module |
| `src/index.ts` | the wrapper: `createJxlTran()`, the transformer, constants, types |
| `src/cli.ts` | the CLI source |
| `dist/index.js`, `dist/index.d.ts`, `dist/cli.js` | `tsc` output |
| `dist/jxltran.mjs`, `dist/jxltran.wasm` | the WebAssembly module, produced by `build.sh` |
| `build.sh` | fetches the pinned sources, applies the patches, builds native + wasm |
| `patches/` | `0001-build-fixes.patch`, `0002-library-entry-point.patch` |
| `third_party/` | gitignored checkouts: `jxltran`, `brotli` |
| `test/simple.ts`, `test/cli.ts` | API tests and the differential CLI tests |
| `test/fixtures/` | the image corpus plus a README on how it was made |
| `docs/api.md` | the API reference |
| `LICENSE`, `LICENSE.brotli` | the BSD-3-Clause licence of jxltran, the MIT licence of Brotli |

## Build

The build needs `git`, `cmake` (Ninja is used when installed, otherwise the default generator)
and an existing **Emscripten** installation (`emcc`/`em++` on the `PATH`, or sourced through
`emsdk_env.sh`, or `EMSDK`/`~/emsdk`/`/usr/share/emscripten`). The script never installs
anything itself.

```sh
./build.sh           # everything: native reference + WebAssembly module
./build.sh --native  # only build/native/jxltran, no Emscripten needed
```

What it does:

1. clones [libjxl/jxltran](https://github.com/libjxl/jxltran) at commit `ec2f8c2` and
   [google/brotli](https://github.com/google/brotli) v1.2.0 into `third_party/` and verifies the
   checkouts really are those commits,
2. applies the patches from `patches/` (a patch that is already applied is skipped, so the script
   can be run repeatedly),
3. builds the native reference binary with CMake - the tests compare the module against it, so it
   must come from exactly the same sources,
4. compiles the sources plus `src/jxltran_wrapper.cc` with Emscripten into
   `dist/jxltran.mjs` + `dist/jxltran.wasm` (1 203 907 bytes, about 491 KiB gzipped). It is a
   library module without a `main()`, see `patches/0002-library-entry-point.patch`. Brotli is
   vendored for this step because Emscripten ships none; the native binary links the system
   library instead.

`pnpm run build` runs `build.sh` and then `tsc -p tsconfig.build.json`.

## Usage

```ts
import { createJxlTran, ORIENTATION } from "@chimok/jxltran-js";

const transformer = await createJxlTran();
transformer.version(); // "jxltran ec2f8c2"

// read the header (oriented dimensions, orientation tag, animation, alpha, frames)
const info = transformer.info(bytes); // 512x512, orientation 1, animation false

// rotate losslessly; `undo` is the command line that reverts it
const rotated = transformer.setOrientation(bytes, ORIENTATION.rotate90);

// crop, remux, strip - each returns { data, undo }
const cropped = transformer.crop(bytes, { width: 200, height: 150, x: 100, y: 50 });
const container = transformer.container(bytes, "yes");
const stripped = transformer.strip(bytes, ["exif", "xmp"]);

// anything the typed options do not cover, passed through verbatim
const { data } = transformer.transform(bytes, { extraArgs: ["--brob=compress"] });
```

Flags that name a file (`--set-exif FILE`, `--extract-*`, `--append-jxl`, `--set-splines-from`)
work on the module's virtual filesystem, never on the host:

```ts
transformer.fs.mkdirTree("/work");
transformer.fs.writeFile("/work/exif.bin", exifBytes);
const withExif = transformer.transform(bytes, { extraArgs: ["--set-exif", "/work/exif.bin"] });

const extracted = transformer.run(["--extract-xmp", "/xmp.xml", "INPUT.jxl"], bytes);
const xmp = transformer.fs.readFile("/xmp.xml");
```

The full reference is in [`docs/api.md`](docs/api.md).

### Command line

`jxltran-js` forwards every flag to the tool inside the module and adds the file I/O around it -
the same shape as the native binary:

```sh
jxltran-js INPUT [OUTPUT] [OPTIONS...]

jxltran-js --info photo.jxl
jxltran-js photo.jxl rotated.jxl --set-orientation=90
jxltran-js photo.jxl photo2.jxl --set-exif=exif.bin --set-xmp=xmp.xml --container=if-needed
jxltran-js photo.jxl --strip=all
```

`-h`/`--help` prints the upstream help text. The one documented deviation from the native binary
is `--version`, which upstream does not have; it prints the package version plus the embedded
jxltran revision, e.g. `jxltran-js 0.1.0 (jxltran ec2f8c2)`.

## Test

```sh
pnpm test              # test/simple.ts + test/cli.ts
pnpm run test:cli      # only the differential CLI battery
```

- `test/simple.ts` (65 checks) covers the API, then compares `--info` and nine transformations
  **byte for byte** against `build/native/jxltran` for every fixture, and finally decodes three
  outputs with `djxl` and compares them as PPM: an orientation round trip and a container decode
  are byte-identical to the original, and the 90 degree file decodes as the original rotated 90
  degrees clockwise (djxl applies the Exif orientation itself).
- `test/cli.ts` (32 cases) runs `node dist/cli.js` and the native binary with the same arguments
  in a recreated scratch directory and compares stdout, stderr, exit status and every produced
  file byte for byte (argv[0] normalised), including `-h` and error paths.

Both files mirror jpegtran-js's `has()` helper: when the native binary (`pnpm run build:native`),
`dist/cli.js` (`pnpm run build:js`) or `djxl` is missing, the dependent sections print a `skip:`
line and the run stays green. The fixtures and their creation commands are documented in
[`test/fixtures/README.md`](test/fixtures/README.md).

## Licence and provenance

- **jxltran** (libjxl ecosystem) is BSD-3-Clause; its upstream `LICENSE` is reproduced verbatim in
  [`LICENSE`](LICENSE), and this package is published under the same licence. The exact upstream
  revision is fetched and verified by `build.sh`.
- **Brotli** is MIT, reproduced in [`LICENSE.brotli`](LICENSE.brotli). Brotli is compiled into
  `dist/jxltran.wasm` so the `brob` box support works; the native reference binary links the
  system library instead.
- `test/fixtures/lenna.jxl` is the classical Lenna test image (Wikipedia, CC BY-SA 4.0) - see
  [`test/fixtures/README.md`](test/fixtures/README.md). It is not covered by the licences above.
