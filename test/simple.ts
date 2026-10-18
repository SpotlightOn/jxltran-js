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
 *   6. every output is a valid JPEG XL file (codestream or container signature),
 *   7. `--info` stdout and exit status are byte-identical to the native `jxltran`
 *      binary for every fixture (bare, container, alpha, animated, jxlp),
 *   8. orientation 90/270, crop, container remux, `--strip=all` and `--jxlp=merge`
 *      produce file bytes, stdout, stderr and exit statuses identical to the
 *      native binary,
 *   9. pixels survive a round trip through `djxl`: the orientation-restored image
 *      and the container decode byte-identically to the original, and the 90
 *      degree image decodes as its 90 degree clockwise rotation.
 *
 * Sections 1-6 run entirely inside the module; their expectations are the ones
 * the native tool produces for `test/fixtures/lenna.jxl` (512x512, orientation
 * tag 1, bare codestream). Sections 7 and 8 need the reference binary from
 * `pnpm run build:native`, section 9 needs `djxl`; each is skipped with a
 * printed reason when the tool is missing, so the test also runs on a plain
 * machine. The fixtures are documented in `test/fixtures/README.md`; the images
 * are written to test/out/ so they can be looked at. Run it with:
 *
 *   node test/simple.ts
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { CONTAINER, createJxlTran } from "../src/index.ts";

const path = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));
const INPUT = path("./fixtures/lenna.jxl");
const CONTAINER_FIXTURE = path("./fixtures/lenna-container.jxl");
const ALPHA_FIXTURE = path("./fixtures/lenna-alpha.jxl");
const ANIM_FIXTURE = path("./fixtures/anim-rgb.jxl");
const JXLP_FIXTURE = path("./fixtures/lenna-jxlp.jxl");
const OUT_DIR = path("./out/");
const NATIVE = path("../build/native/jxltran");
/** File name of the transformed output; both tools write it into OUT_DIR. */
const OUTPUT = "OUTPUT.jxl";

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

/** True when a command runs on this machine (same helper as in jpegtran-js). */
function has(command: string): boolean {
  return spawnSync(command, ["-version"], { stdio: "ignore" }).error === undefined;
}

interface ToolOutput {
  status: number;
  stdout: string;
  stderr: string;
}

/** Runs the reference binary with the given command line in OUT_DIR. */
function runNative(args: string[]): ToolOutput {
  const result = spawnSync(NATIVE, args, { cwd: OUT_DIR, encoding: "utf8" });
  if (result.error !== undefined) throw result.error;
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

/** Both tools print their own program name into usage and undo lines; normalise it away. */
function normalizeOutput(text: string): string {
  return text.split(NATIVE).join("argv0").split("jxltran-js").join("argv0");
}

/**
 * Runs one command line through the native binary and through the module and compares the
 * transformed file, stdout, stderr and the exit status.
 */
function compareWithNative(name: string, file: string, input: Uint8Array, flags: string[]): void {
  const args = [file, OUTPUT, ...flags];
  const reference = runNative(args);
  if (reference.status !== 0) {
    check(`${name}: native run succeeds`, false, reference.stderr.trim());
    return;
  }
  const expected = readFileSync(path("./out/OUTPUT.jxl"));
  const result = transformer.run(args, input);
  const actual = Buffer.from(result.data ?? []);
  check(
    `${name}: output is byte-identical to the native binary`,
    Buffer.compare(actual, expected) === 0,
    `module ${actual.length} bytes, native ${expected.length} bytes`,
  );
  check(
    `${name}: exit status matches`,
    result.status === reference.status,
    `module ${result.status}, native ${reference.status}`,
  );
  check(
    `${name}: stdout matches`,
    normalizeOutput(result.stdout) === normalizeOutput(reference.stdout),
    `module: ${JSON.stringify(result.stdout)} native: ${JSON.stringify(normalizeOutput(reference.stdout))}`,
  );
  check(
    `${name}: stderr matches`,
    normalizeOutput(result.stderr) === normalizeOutput(reference.stderr),
    `module: ${JSON.stringify(result.stderr)} native: ${JSON.stringify(normalizeOutput(reference.stderr))}`,
  );
}

interface Ppm {
  width: number;
  height: number;
  pixels: Buffer;
}

/** Decodes a JPEG XL file to a PPM file with djxl and parses the raw pixel body. */
function decodePpm(jxl: string, ppm: string): Ppm {
  const result = spawnSync("djxl", [jxl, ppm], { encoding: "utf8" });
  if (result.status !== 0 || !existsSync(ppm)) {
    throw new Error(`djxl failed for ${jxl}: ${(result.stderr ?? "").trim()}`);
  }
  const data = readFileSync(ppm);
  const header = /^P6\n(\d+) (\d+)\n255\n/.exec(data.toString("latin1", 0, 64));
  if (header === null) throw new Error(`unexpected PPM header in ${ppm}`);
  return { width: Number(header[1]), height: Number(header[2]), pixels: data.subarray(header[0].length) };
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

// 7. --info matches the native binary
if (!has(NATIVE)) {
  console.log("\nskip  sections 7 and 8: no native reference binary (pnpm run build:native)");
} else {
  const infoFixtures: Array<[string, string]> = [
    ["bare codestream", INPUT],
    ["container", CONTAINER_FIXTURE],
    ["alpha", ALPHA_FIXTURE],
    ["animated", ANIM_FIXTURE],
    ["jxlp container", JXLP_FIXTURE],
  ];
  for (const [label, file] of infoFixtures) {
    const bytes = readFileSync(file);
    const reference = runNative(["--info", file]);
    const result = transformer.run(["--info", file], bytes);
    check(
      `--info of the ${label} is byte-identical to the native stdout`,
      result.stdout === reference.stdout,
      `module: ${JSON.stringify(result.stdout)} native: ${JSON.stringify(reference.stdout)}`,
    );
    check(
      `--info of the ${label} exits like the native binary`,
      result.status === reference.status,
      `module ${result.status}, native ${reference.status}`,
    );
  }

  // 8. transforms are byte-identical to the native binary
  const containerBytes = readFileSync(CONTAINER_FIXTURE);
  const alphaBytes = readFileSync(ALPHA_FIXTURE);
  const animBytes = readFileSync(ANIM_FIXTURE);
  const jxlpBytes = readFileSync(JXLP_FIXTURE);

  compareWithNative("orientation 90", INPUT, input, ["--set-orientation=90"]);
  compareWithNative("orientation 270", INPUT, input, ["--set-orientation=270"]);
  compareWithNative("crop", INPUT, input, ["--crop=200x150+100+50"]);
  compareWithNative("container remux", INPUT, input, ["--container=yes"]);
  compareWithNative("container unwrap", CONTAINER_FIXTURE, containerBytes, ["--container=no"]);
  compareWithNative("strip all", CONTAINER_FIXTURE, containerBytes, ["--strip=all"]);
  compareWithNative("jxlp merge", JXLP_FIXTURE, jxlpBytes, ["--jxlp=merge"]);
  compareWithNative("orientation of the alpha image", ALPHA_FIXTURE, alphaBytes, ["--set-orientation=90"]);
  compareWithNative("orientation of the animated image", ANIM_FIXTURE, animBytes, ["--set-orientation=90"]);
}

// 9. pixels survive a round trip through djxl
if (!has("djxl")) {
  console.log("skip  section 9: djxl is not installed");
} else {
  const originalPpm = decodePpm(INPUT, path("./out/pixel-original.ppm"));
  const restoredPpm = decodePpm(path("./out/lenna-orientation-restored.jxl"), path("./out/pixel-restored.ppm"));
  check(
    "orientation round trip decodes byte-identically to the original",
    Buffer.compare(originalPpm.pixels, restoredPpm.pixels) === 0,
    `${originalPpm.pixels.length} vs ${restoredPpm.pixels.length} bytes`,
  );

  const boxedPpm = decodePpm(path("./out/lenna-container.jxl"), path("./out/pixel-container.ppm"));
  check(
    "container keeps the pixels",
    Buffer.compare(originalPpm.pixels, boxedPpm.pixels) === 0,
    `${originalPpm.pixels.length} vs ${boxedPpm.pixels.length} bytes`,
  );

  // djxl applies the EXIF orientation: tag 6 comes back as the image rotated 90 degrees
  // clockwise. The rotation runs through djxl's colour pipeline, so up to one unit of rounding
  // per channel can differ; the geometry itself must match exactly.
  const orientedPpm = decodePpm(path("./out/lenna-orientation-90.jxl"), path("./out/pixel-oriented90.ppm"));
  const sameCanvas = orientedPpm.width === originalPpm.width && orientedPpm.height === originalPpm.height;
  check(
    "oriented decode keeps the canvas size",
    sameCanvas,
    `got ${orientedPpm.width}x${orientedPpm.height}, expected ${originalPpm.width}x${originalPpm.height}`,
  );
  if (sameCanvas) {
    const { width, height, pixels: expected } = originalPpm;
    const actualPixels = orientedPpm.pixels;
    let maxDiff = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        // 90 degree clockwise rotation: dst(x, y) comes from src(y, height - 1 - x).
        const dst = (y * width + x) * 3;
        const src = ((height - 1 - x) * width + y) * 3;
        for (let channel = 0; channel < 3; channel++) {
          const diff = Math.abs(expected[src + channel] - actualPixels[dst + channel]);
          if (diff > maxDiff) maxDiff = diff;
        }
      }
    }
    check(
      "oriented decode is the 90 degree rotation (per channel difference <= 1)",
      maxDiff <= 1,
      `max difference ${maxDiff}`,
    );
  }
}

console.log(`\npassed: ${passed}`);
