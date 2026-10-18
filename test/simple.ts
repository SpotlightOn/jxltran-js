/**
 * Smoke test for the jxltran-js API.
 *
 * It checks, in order:
 *
 *   1. the module loads and reports a version string,
 *   2. `info()` reads dimensions, orientation and animation flag of the sample,
 *   3. setting the orientation rewrites only the image header (dimensions stay),
 *      and setting it back reports the original orientation tag,
 *   4. a metadata-only crop resizes the canvas to the requested rectangle,
 *   5. wrapping the sample in a container and unwrapping it again returns the
 *      original bytes,
 *   6. every output is a valid JPEG XL file (codestream or container signature).
 *
 * The expectations are the ones the native `jxltran` binary produces for
 * `test/fixtures/lenna.jxl` (512x512, orientation tag 1, bare codestream), so a
 * failure here means the module and the upstream tool disagree.
 *
 * Nothing needs external tools: everything runs inside the module. The images
 * are written to test/out/ so they can be looked at. Run it with:
 *
 *   node test/simple.ts
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { CONTAINER, createJxlTran } from "../src/index.ts";

const path = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));
const INPUT = path("./fixtures/lenna.jxl");
const OUT_DIR = path("./out/");

let passed = 0;

function check(name: string, condition: boolean, detail?: string): void {
  if (condition) {
    passed++;
    console.log(`  ok    ${name}`);
  } else {
    console.log(`  FAIL  ${name}${detail ? `: ${detail}` : ""}`);
    process.exitCode = 1;
  }
}

/** True for a bare JPEG XL codestream (ff 0a) or an ISOBMFF container (size + "JXL "). */
function isJxl(buffer: Uint8Array): boolean {
  const bare = buffer[0] === 0xff && buffer[1] === 0x0a;
  const boxed =
    buffer.length >= 12 &&
    buffer[4] === 0x4a && // 'J'
    buffer[5] === 0x58 && // 'X'
    buffer[6] === 0x4c && // 'L'
    buffer[7] === 0x20;
  return bare || boxed;
}

mkdirSync(OUT_DIR, { recursive: true });

const input = readFileSync(INPUT);

console.log(`sample: ${INPUT} (${input.length} bytes)\n`);

// 1. the module loads
const transformer = await createJxlTran();
console.log(`module: ${transformer.version()}\n`);
check("module reports a version", transformer.version().length > 0);

// 2. info reads the sample
const original = transformer.info(input);
console.log(
  `info: ${original.width}x${original.height}, orientation ${original.orientation}, animation ${original.animation}\n`,
);
check(
  "info reads the dimensions (512x512)",
  original.width === 512 && original.height === 512,
  `got ${original.width}x${original.height}`,
);
check("info reads the orientation tag (1)", original.orientation === 1, `got ${original.orientation}`);
check("info reports no animation", original.animation === false);

// 3. orientation is a header-only change
const oriented = transformer.setOrientation(input, 90);
writeFileSync(path("./out/lenna-orientation-90.jxl"), oriented.data);
check("orientation output is a valid JPEG XL file", isJxl(oriented.data));
check(
  "orientation output differs from the input",
  Buffer.compare(Buffer.from(oriented.data), input) !== 0,
);
const afterOrientation = transformer.info(oriented.data);
check(
  "setting 90 degrees writes the EXIF tag 6",
  afterOrientation.orientation === 6,
  `got ${afterOrientation.orientation}`,
);
check(
  "orientation does not touch the dimensions",
  afterOrientation.width === 512 && afterOrientation.height === 512,
  `got ${afterOrientation.width}x${afterOrientation.height}`,
);

const restored = transformer.setOrientation(oriented.data, 1);
writeFileSync(path("./out/lenna-orientation-restored.jxl"), restored.data);
const afterRestore = transformer.info(restored.data);
check(
  "setting the orientation back reports tag 1",
  afterRestore.orientation === 1,
  `got ${afterRestore.orientation}`,
);

// 4. metadata-only crop
const cropped = transformer.crop(input, { width: 200, height: 150, x: 100, y: 50 });
writeFileSync(path("./out/lenna-crop.jxl"), cropped.data);
check("crop output is a valid JPEG XL file", isJxl(cropped.data));
const cropInfo = transformer.info(cropped.data);
check(
  "crop resizes the canvas to 200x150",
  cropInfo.width === 200 && cropInfo.height === 150,
  `got ${cropInfo.width}x${cropInfo.height}`,
);

// 5. container remux is lossless
const boxed = transformer.container(input, CONTAINER.yes);
writeFileSync(path("./out/lenna-container.jxl"), boxed.data);
check("container output is a valid JPEG XL container", isJxl(boxed.data) && boxed.data[7] === 0x20);
check("container output is not the bare codestream", boxed.data[0] !== 0xff);
const boxedInfo = transformer.info(boxed.data);
check(
  "info reads container files too",
  boxedInfo.width === 512 && boxedInfo.height === 512,
  `got ${boxedInfo.width}x${boxedInfo.height}`,
);

const unboxed = transformer.container(boxed.data, CONTAINER.no);
writeFileSync(path("./out/lenna-container-roundtrip.jxl"), unboxed.data);
check(
  "container round trip returns the original bytes",
  Buffer.compare(Buffer.from(unboxed.data), input) === 0,
);

console.log(`\npassed: ${passed}`);
