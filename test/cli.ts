/**
 * Differential test for the command line front end: `node dist/cli.js` against the native
 * `jxltran` binary built from the same sources (`pnpm run build:native`).
 *
 * For every case both are run with identical arguments in an identical scratch directory
 * (test/out/cli/) and stdout, stderr, exit codes and every produced file are compared byte for
 * byte. The program name (argv[0]) is normalised away: the native binary prints its own path,
 * the CLI prints `jxltran-js`. `--version` is the documented CLI extension and is checked
 * against the CLI alone; everything else must match exactly, including help texts, error
 * ordering, sidecar handling and the files on disk.
 *
 * The run is skipped (with a printed reason) when the native binary or `dist/cli.js` is
 * missing. Run it with:
 *
 *   node test/cli.ts
 */

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const path = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));
const NATIVE = path("../build/native/jxltran");
const CLI = path("../dist/cli.js");
const SCRATCH = path("./out/cli/");

const OUT = "zz-out.jxl";
const CNT = "zz-cnt.jxl";
const EX = "zz-ex.xml";

interface CliCase {
  name: string;
  steps: string[][];
  /** Checked against the CLI only, because the native binary has no such behaviour. */
  cliOnly?: boolean;
  expect?: { status: number; stdout: RegExp };
}

const cases: CliCase[] = [
  { name: "no args", steps: [[]] },
  { name: "help long", steps: [["--help"]] },
  { name: "help short", steps: [["-h"]] },
  { name: "info", steps: [["--info", "lenna.jxl"]] },
  { name: "info no input", steps: [["--info"]] },
  { name: "info with output", steps: [["--info", "lenna.jxl", OUT]] },
  { name: "transform without output", steps: [["lenna.jxl"]] },
  { name: "orientation", steps: [["lenna.jxl", OUT, "--set-orientation=90"]] },
  { name: "orientation space value", steps: [["lenna.jxl", OUT, "--set-orientation", "90"]] },
  { name: "crop container", steps: [["lenna.jxl", OUT, "--crop=200x150+100+50", "--container=yes"]] },
  { name: "dashdash positionals", steps: [["--", "lenna.jxl", OUT]] },
  { name: "missing input", steps: [["missing.jxl"]] },
  { name: "info missing input", steps: [["--info", "missing.jxl"]] },
  { name: "missing input bad flag", steps: [["missing.jxl", "--nosuchflag"]] },
  { name: "bad flag", steps: [["lenna.jxl", "--nosuchflag"]] },
  { name: "missing input help", steps: [["missing.jxl", "--help"]] },
  { name: "input help", steps: [["lenna.jxl", "--help"]] },
  { name: "bad output dir", steps: [["lenna.jxl", "/nonexistent-dir/zz-out.jxl"]] },
  { name: "three positionals", steps: [["lenna.jxl", "zz-a.jxl", "zz-b.jxl"]] },
  { name: "verbose transform", steps: [["lenna.jxl", OUT, "--set-orientation=270", "-v"]] },
  { name: "info structure", steps: [["--info-structure", "lenna.jxl"]] },
  {
    name: "orientation conflict",
    steps: [["lenna.jxl", OUT, "--set-orientation=90", "--set-orientation-relative=1"]],
  },
  { name: "empty input file", steps: [["empty.jxl", OUT]] },
  { name: "directory input", steps: [["subdir"]] },
  { name: "directory input with output", steps: [["subdir", OUT]] },
  { name: "output is directory", steps: [["lenna.jxl", "subdir"]] },
  { name: "set xmp inline", steps: [["--set-xmp=meta.xml", "lenna.jxl", OUT, "--container=yes"]] },
  { name: "set xmp space form", steps: [["--set-xmp", "meta.xml", "lenna.jxl", OUT, "--container=yes"]] },
  { name: "extract absent box", steps: [["--extract-xmp=zz-ex.xml", "lenna.jxl"]] },
  { name: "extract missing dir", steps: [["--extract-xmp=nodir/zz-ex.xml", "lenna.jxl"]] },
  {
    name: "chain set then extract",
    steps: [
      ["--set-xmp=meta.xml", "lenna.jxl", CNT, "--container=yes"],
      ["--extract-xmp=zz-ex.xml", CNT],
    ],
  },
  {
    name: "version deviates",
    steps: [["--version"]],
    cliOnly: true,
    expect: { status: 0, stdout: /^jxltran-js \d+\.\d+\.\d+ \(jxltran [0-9a-f]{7}\)\n$/ },
  },
];

const WATCHED = [OUT, CNT, EX, "zz-a.jxl", "zz-b.jxl"];

/** True when a command runs on this machine (same helper as in jpegtran-js). */
function has(command: string): boolean {
  return spawnSync(command, ["-version"], { stdio: "ignore" }).error === undefined;
}

if (!has(NATIVE)) {
  console.log("skip: no native reference binary (run pnpm run build:native)");
  process.exit(0);
}
if (!existsSync(CLI)) {
  console.log("skip: dist/cli.js is not built (run pnpm run build:js)");
  process.exit(0);
}

function resetScratch(): void {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(SCRATCH, { recursive: true });
  copyFileSync(path("./fixtures/lenna.jxl"), `${SCRATCH}/lenna.jxl`);
  writeFileSync(
    `${SCRATCH}/meta.xml`,
    '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>\n' +
      '<x:xmpmeta xmlns:x="adobe:ns:meta/">' +
      '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
      '<rdf:Description rdf:about="" /></rdf:RDF></x:xmpmeta>\n' +
      '<?xpacket end="w"?>\n',
  );
  writeFileSync(`${SCRATCH}/empty.jxl`, "");
  mkdirSync(`${SCRATCH}/subdir`);
}

function snapshotFiles(): Record<string, Buffer | null> {
  const files: Record<string, Buffer | null> = {};
  for (const name of WATCHED) {
    files[name] = existsSync(`${SCRATCH}/${name}`) ? readFileSync(`${SCRATCH}/${name}`) : null;
  }
  return files;
}

interface StepResult {
  status: number | null;
  stdout: string;
  stderr: string;
  files: Record<string, Buffer | null>;
}

function runSteps(command: string, prefix: string[], steps: string[][]): StepResult[] {
  const results: StepResult[] = [];
  for (const args of steps) {
    const result = spawnSync(command, [...prefix, ...args], {
      cwd: SCRATCH,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    results.push({
      status: result.status,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      files: snapshotFiles(),
    });
  }
  return results;
}

const normalizeOutput = (text: string): string => text.split(NATIVE).join("BIN").split("jxltran-js").join("BIN");
const equalBytes = (a: Buffer | null, b: Buffer | null): boolean =>
  a !== null && b !== null && Buffer.compare(a, b) === 0;

let passed = 0;
let failed = 0;

for (const testCase of cases) {
  // Between the two runs the scratch directory is recreated from scratch, so a file comparison
  // can never pass because the previous run left a copy behind.
  resetScratch();
  const nativeSteps = testCase.cliOnly ? null : runSteps(NATIVE, [], testCase.steps);
  resetScratch();
  const cliSteps = runSteps("node", [CLI], testCase.steps);

  const problems: string[] = [];

  if (testCase.cliOnly && testCase.expect !== undefined) {
    const step = cliSteps[0];
    if (step.status !== testCase.expect.status) {
      problems.push(`status ${step.status} != ${testCase.expect.status}`);
    }
    if (!testCase.expect.stdout.test(step.stdout)) {
      problems.push(`stdout ${JSON.stringify(step.stdout)} does not match ${testCase.expect.stdout}`);
    }
  } else {
    for (let i = 0; i < testCase.steps.length; i++) {
      const native = nativeSteps?.[i];
      const cli = cliSteps[i];
      if (native === undefined) continue;
      if (native.status !== cli.status) {
        problems.push(`step ${i}: status native=${native.status} cli=${cli.status}`);
      }
      if (normalizeOutput(native.stdout) !== normalizeOutput(cli.stdout)) {
        problems.push(
          `step ${i}: stdout\n  native: ${JSON.stringify(normalizeOutput(native.stdout))}\n` +
            `  cli:    ${JSON.stringify(normalizeOutput(cli.stdout))}`,
        );
      }
      if (normalizeOutput(native.stderr) !== normalizeOutput(cli.stderr)) {
        problems.push(
          `step ${i}: stderr\n  native: ${JSON.stringify(normalizeOutput(native.stderr))}\n` +
            `  cli:    ${JSON.stringify(normalizeOutput(cli.stderr))}`,
        );
      }
      for (const name of WATCHED) {
        const fromNative = native.files[name];
        const fromCli = cli.files[name];
        if ((fromNative === null) !== (fromCli === null)) {
          problems.push(
            `step ${i}: file ${name} native=${fromNative === null ? "absent" : `${fromNative.length}B`}` +
              ` cli=${fromCli === null ? "absent" : `${fromCli.length}B`}`,
          );
        } else if (fromNative !== null && !equalBytes(fromNative, fromCli)) {
          problems.push(`step ${i}: file ${name} differs (${fromNative.length}B vs ${fromCli!.length}B)`);
        }
      }
    }
  }

  if (problems.length === 0) {
    passed++;
    console.log(`  ok    ${testCase.name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${testCase.name}`);
    for (const problem of problems) console.log(`        ${problem}`);
  }
}

console.log(`\npassed: ${passed}, failed: ${failed}`);
if (failed > 0) process.exitCode = 1;
