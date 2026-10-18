# API Reference

The module exports the transformer factory, the flag constants, the error class and a few type
helpers. It is consumed directly from the generated WebAssembly module through the TypeScript
wrapper in `src/index.ts`; the declarations in `dist/index.d.ts` are generated from that source.

## Loading

```ts
import { createJxlTran } from "@chimok/jxltran-js";
const transformer = await createJxlTran();
```

`createJxlTran()` loads `dist/jxltran.mjs` (and `dist/jxltran.wasm`) and returns a
`JxlTranTransformer` instance. One module instance per call: create it once and reuse it. Runs are
synchronous - the WebAssembly module executes on the current thread - and instances share nothing.

## Constants

### ORIENTATION

Values of `--set-orientation`: the Exif orientation tag of the image header.

```ts
const ORIENTATION = {
  normal: 1, // no transform
  flipHorizontal: 2, // flip horizontally
  rotate180: 3, // rotate 180 degrees (alias: 180)
  flipVertical: 4, // flip vertically
  transpose: 5, // transpose (rotate 90 CW + flip H)
  rotate90: 6, // rotate 90 degrees clockwise (alias: 90)
  transverse: 7, // flip H + rotate 90 CW
  rotate270: 8, // rotate 90 degrees counter-clockwise (alias: 270)
} as const;
```

The flag also accepts the degree aliases `90`, `180`, `270`; the typed option takes any number.

### CONTAINER

Values of `--container`: how the output file is wrapped.

```ts
const CONTAINER = {
  keep: "keep", // preserve the input format (container or bare codestream)
  no: "no", // bare codestream only; drops the container and all metadata boxes
  yes: "yes", // always wrap in a container
  ifNeeded: "if-needed", // container only when metadata boxes are present
} as const;
```

### JXLP

Values of `--jxlp`: how jxlp boxes are handled when the output is a container.

```ts
const JXLP = {
  keep: "keep", // keep jxlp boxes unchanged
  sort: "sort", // reorder jxlp boxes by counter
  merge: "merge", // sort and merge all jxlp boxes into a single jxlc box
} as const;
```

### STRIP

Values of `--strip`: metadata boxes to remove from the output container.

```ts
const STRIP = {
  exif: "exif", // Exif boxes (and brob wrappers around them)
  xmp: "xmp", // XMP boxes ("xml " type)
  jumbf: "jumbf", // JUMBF boxes
  jbrd: "jbrd", // JPEG bitstream reconstruction data
  all: "all", // all non-structural metadata
} as const;
```

## Types

### CropRect

A crop region as an object; `x` and `y` default to `0`.

```ts
interface CropRect {
  width: number;
  height: number;
  x?: number;
  y?: number;
}
```

### CropSpec

A crop region, either as a `CropRect` or as a string in jxltran's `--crop` syntax (`WxH` or
`WxH+X+Y`, e.g. `"200x150+100+50"`). The string form keeps the whole syntax available, including
negative offsets.

### TransformOptions

Options of the transforming entry points; each one maps to the flag of the same meaning.

```ts
interface TransformOptions {
  orientation?: Orientation | number | null; // --set-orientation=1..8|90|180|270
  crop?: CropSpec | null; // --crop=WxH+X+Y
  container?: Container | null; // --container=keep|no|yes|if-needed
  jxlp?: JxlpMode | null; // --jxlp=keep|sort|merge
  strip?: StripTarget | readonly StripTarget[] | null; // --strip=exif|xmp|... (lists are comma-joined)
  frames?: readonly number[] | number | null; // --frames=N[,N...]
  extraArgs?: readonly string[]; // appended verbatim: every upstream option without a typed key
}
```

### TransformResult

The bytes a run produced, plus the command line that inverts it (when there is one).

```ts
interface TransformResult {
  data: Uint8Array; // the OUTPUT file of the run, as bytes
  undo: string | null; // the raw reversible_undo command line, or null when there is no inverse
}
```

`undo` contains the placeholders `jxltran-js` (program name) and `OUTPUT.jxl` (output file),
because the run happened in memory; substitute them with the tool that should execute it.

### FrameRegion

One `frame_region` line of `--info`: a frame's rectangle in oriented display space.

```ts
interface FrameRegion {
  index: number; // 0-based codestream frame index
  width: number;
  height: number;
  x: number;
  y: number;
}
```

### ImageInfo

The values that `info()` reads from the `--info` output.

```ts
interface ImageInfo {
  width: number; // oriented display width in pixels
  height: number; // oriented display height in pixels
  orientation: number; // the Exif orientation tag, 1..8 (ORIENTATION)
  animation: boolean;
  alpha: boolean;
  frames: FrameRegion[]; // one entry per frame, in codestream order
  text: string; // the complete --info text, byte for byte as the tool prints it
}
```

### RunResult

What one call into the module produced; the return type of `run()`.

```ts
interface RunResult {
  status: number; // the exit code the tool returned (the tool itself only uses 0 and 1)
  data: Uint8Array | null; // the OUTPUT bytes, or null for read-only runs and failures
  undo: string | null; // the raw reversible_undo command line, or null
  stdout: string; // everything the run printed to stdout, byte for byte
  stderr: string; // everything the run printed to stderr, byte for byte
}
```

### JxlTranFileSystem

The virtual filesystem of the module. Flags that name a file (`--set-exif FILE`, `--extract-*`,
`--append-jxl`, `--set-splines-from`) read and write here, never on the host: stage input files
before a run and read extracted files back afterwards. Use absolute paths; directories must exist
(see `mkdirTree`).

```ts
interface JxlTranFileSystem {
  mkdirTree(path: string): void; // creates every missing directory of the path
  writeFile(path: string, data: Uint8Array | string): void;
  readFile(path: string): Uint8Array;
}
```

## createJxlTran()

```ts
function createJxlTran(): Promise<JxlTranTransformer>;
```

## JxlTranTransformer

### version()

```ts
version(): string;
```

The version of the embedded jxltran sources, e.g. `jxltran ec2f8c2`.

### info()

```ts
info(input: Uint8Array | ArrayBuffer): ImageInfo;
```

Reads the image header information that `--info` prints (oriented dimensions, orientation tag,
animation, alpha, frame regions). The complete tool output stays available as `text`.

### transform()

```ts
transform(input: Uint8Array | ArrayBuffer, options?: TransformOptions): TransformResult;
```

Applies the given options to the input and returns the transformed bytes. Every option is a
command line flag; `extraArgs` passes the rest of the tool's flag surface through unchanged, so
the API never falls behind the tool.

### setOrientation()

```ts
setOrientation(input: Uint8Array | ArrayBuffer, orientation: Orientation | number): TransformResult;
```

Sets the orientation tag, like `--set-orientation=1..8|90|180|270`. The tag only - the pixels
stay untouched, decoders apply the transform on display.

### crop()

```ts
crop(input: Uint8Array | ArrayBuffer, rect: CropSpec, options?: TransformOptions): TransformResult;
```

Crops losslessly, like `--crop=WxH+X+Y`: a reversible metadata-only resize of the canvas.
Coordinates are in display space (as decoders show the image after the orientation tag), and any
signed combination is allowed - negative offsets add padding instead of cutting.

### strip()

```ts
strip(
  input: Uint8Array | ArrayBuffer,
  targets: StripTarget | readonly StripTarget[],
  options?: TransformOptions,
): TransformResult;
```

Strips metadata boxes from the output, like `--strip=exif|xmp|jumbf|jbrd|all`.

### container()

```ts
container(input: Uint8Array | ArrayBuffer, mode: Container, options?: TransformOptions): TransformResult;
```

Chooses the output wrapping, like `--container=keep|no|yes|if-needed`.

### jxlp()

```ts
jxlp(input: Uint8Array | ArrayBuffer, mode: JxlpMode, options?: TransformOptions): TransformResult;
```

Chooses how jxlp boxes are written, like `--jxlp=keep|sort|merge`.

### run()

```ts
run(args: readonly string[], input: Uint8Array | ArrayBuffer): RunResult;
```

Runs one complete command line in memory: the raw layer beneath every other method, and the one
the CLI uses to forward flags verbatim. `args` holds everything after the program name, including
the INPUT and (for transforms) the OUTPUT positional - in-memory runs use the placeholders
`INPUT.jxl` and `OUTPUT.jxl`, as `transform()` passes them; the bytes travel separately.

Read-only runs (`--info`, `--help`, `--info-structure`, `--extract-*`) report their text in
`stdout` and return `data: null`. Files that `--extract-*` names are written into `fs` and can be
read back from there.

### fs

```ts
get fs(): JxlTranFileSystem;
```

The virtual filesystem of the module, as described under `JxlTranFileSystem` above.

## TransformError

Thrown whenever a run of the tool fails, or its output cannot be parsed.

```ts
class TransformError extends Error {
  readonly status: number; // the exit code the tool returned
  readonly stderr: string; // everything the run wrote to stderr (for a parse failure: the text)
}
```

`message` is the first non-empty stderr line - the wording the native binary prints.

## Notes

- Validation, defaults and error messages happen inside the tool itself, not in the wrapper, so a
  failing run behaves exactly like the native binary of the same sources.
- One transformation never re-encodes the codestream: the quantized data is edited in place, so
  there is no generation loss.
- The transform methods throw `TransformError` on failure; `run()` reports the outcome instead,
  including non-zero exit codes, and never throws for a failing command.
