#!/usr/bin/env node
/**
 * A very small, jxltran-compatible command line front end for the WebAssembly module.
 *
 * It exists to try the module out and to compare it against the native `jxltran` built from the
 * same sources:
 *
 *   node src/cli.ts --info in.jxl
 *   node src/cli.ts in.jxl out.jxl --set-orientation=90
 *
 * Every flag is forwarded to the tool inside the module, so parsing, validation, defaults and
 * error messages match the native binary by construction. Only the file I/O happens here: INPUT
 * is read from the host, `--set-*` and `--append-jxl` files are staged into the module's virtual
 * filesystem, and OUTPUT plus `--extract-*` targets are written back. A probe run with an empty
 * input lets the tool reject a broken command line before any file is touched, in the same order
 * as the native binary, which validates before it opens INPUT. The one extension over upstream is
 * `--version`.
 */

import { readFileSync, writeFileSync } from "node:fs";

import { createJxlTran, type JxlTranFileSystem, type RunResult } from "./index.ts";

/** The input of a probe run: never a JPEG XL file, so the tool stops at its signature check. */
const EMPTY = new Uint8Array(0);

/** The tool's message for an input that is not JPEG XL, printed only after all validation. */
const NOT_JPEG_XL = "Input file is not a JPEG XL file.";

/** Value flags whose FILE argument the tool reads; staged into the virtual filesystem. */
const INPUT_FILE_FLAGS = new Set(["set-exif", "set-xmp", "set-jumbf", "set-splines-from", "append-jxl"]);

/** Value flags whose FILE argument the tool writes; copied back to the host after a run. */
const EXTRACT_FILE_FLAGS = new Set(["extract-icc", "extract-exif", "extract-xmp", "extract-jumbf", "extract-splines"]);

/** Prints a message to stderr and exits 1, in the wording the native tool uses. */
function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

/** Forwards both captured streams of a finished run to the terminal. */
function emit(outcome: RunResult): void {
  if (outcome.stdout !== "") {
    process.stdout.write(outcome.stdout);
  }
  if (outcome.stderr !== "") {
    process.stderr.write(outcome.stderr);
  }
}

/**
 * The long flags that take a value, read from the tool's own help text: their entries print as
 * `--name=METAVAR`, and no description line starts that way. Deriving the list keeps the
 * positional scan below in sync with the flag surface of the embedded build.
 */
function valueFlagNames(help: string): ReadonlySet<string> {
  return new Set(Array.from(help.matchAll(/^ --([A-Za-z0-9_-]+)=/gm), (match) => match[1]));
}

/** The files and positionals of one command line, as the scan below sees them. */
interface CommandLine {
  /** The INPUT positional: the host file whose bytes are passed to the tool. */
  input: string | null;
  /** The OUTPUT positional: the host file the result is written to. */
  output: string | null;
  /** Files to stage into the virtual filesystem before the run. */
  staged: string[];
  /** Files the run writes into the virtual filesystem, copied back after a successful run. */
  extracted: string[];
}

/** Notes a value flag's FILE argument, when the flag names a file at all. */
function recordFile(scan: CommandLine, flag: string, value: string | undefined): void {
  if (value === undefined) {
    return;
  }
  if (INPUT_FILE_FLAGS.has(flag)) {
    scan.staged.push(value);
  } else if (EXTRACT_FILE_FLAGS.has(flag)) {
    scan.extracted.push(value);
  }
}

/**
 * Finds the INPUT and OUTPUT positionals and the files named by value flags, mirroring how the
 * tool's parser walks argv: `-h` and `-v` are recognized even after `--`, `--` ends the options,
 * `-` counts as a filename, `--name=VALUE` keeps its value attached while a flagged `--name`
 * takes the next token. A third positional is left to the tool, which reports it as an unknown
 * argument. Only flags whose run already passed the probe can appear here, so every dashed token
 * is a flag the tool knows.
 */
function scanArguments(args: readonly string[], valueNames: ReadonlySet<string>): CommandLine {
  const scan: CommandLine = { input: null, output: null, staged: [], extracted: [] };
  let positionals = 0;
  let options = true;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];

    if (arg === "-h" || arg === "--help" || arg === "-v" || arg === "--verbose") {
      continue;
    }
    if (arg === "--") {
      options = false;
      continue;
    }
    if (options && arg !== "-" && arg.startsWith("-")) {
      if (!arg.startsWith("--")) {
        continue; // the only short flags are -h and -v, handled above
      }
      const equals = arg.indexOf("=");
      if (equals !== -1) {
        recordFile(scan, arg.slice(2, equals), arg.slice(equals + 1));
      } else if (valueNames.has(arg.slice(2))) {
        recordFile(scan, arg.slice(2), args[index + 1]);
        index++; // a missing value is reported by the tool itself
      }
      continue;
    }

    if (positionals === 0) {
      scan.input = arg;
    } else if (positionals === 1) {
      scan.output = arg;
    }
    positionals++;
  }

  return scan;
}

/** Maps a host path to its place in the module's virtual filesystem, whose cwd is the root. */
function virtualPath(path: string): string {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") {
      continue;
    }
    if (part === "..") {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return `/${parts.join("/")}`;
}

/** The directory a virtual path lives in. */
function virtualDirectory(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash <= 0 ? "/" : path.slice(0, slash);
}

/**
 * Stages a sidecar file into the virtual filesystem. A file that cannot be read is not staged:
 * the tool then fails with the same message the native binary prints for it.
 */
function stageFile(fs: JxlTranFileSystem, path: string): void {
  let data: Uint8Array;
  try {
    data = new Uint8Array(readFileSync(path));
  } catch {
    return;
  }
  const target = virtualPath(path);
  fs.mkdirTree(virtualDirectory(target));
  fs.writeFile(target, data);
}

/**
 * Creates the directory of an extract target in the virtual filesystem, so the run can write it
 * exactly where the native tool could: both sides need the directory to exist.
 */
function prepareExtract(fs: JxlTranFileSystem, path: string): void {
  fs.mkdirTree(virtualDirectory(virtualPath(path)));
}

/** Reads the input file, with the error messages of the native tool. */
function readInput(path: string): Uint8Array {
  try {
    return new Uint8Array(readFileSync(path));
  } catch (error) {
    // The native tool opens a directory and reads zero bytes from it; an empty input reproduces
    // what it does, while every other failure is its "cannot open" case.
    if ((error as NodeJS.ErrnoException).code === "EISDIR") {
      return EMPTY;
    }
    return fail(`Failed to open '${path}' for reading`);
  }
}

/** Writes an output file, with the error messages of the native tool. */
function writeOutput(path: string, data: Uint8Array): void {
  try {
    writeFileSync(path, data);
  } catch {
    return fail(`Failed to open '${path}' for writing`);
  }
}

/** Copies a file the run wrote back to the host; a run that wrote nothing has no file to copy. */
function copyBack(fs: JxlTranFileSystem, path: string): void {
  let data: Uint8Array;
  try {
    data = fs.readFile(virtualPath(path));
  } catch {
    return;
  }
  writeOutput(path, data);
}

const args = process.argv.slice(2);
const transformer = await createJxlTran();

// `--version` is the one extension over upstream, which has no version flag at all. It is only
// answered when it is the whole command line; forwarded otherwise, like any unknown flag.
if (args.length === 1 && args[0] === "--version") {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  process.stdout.write(`jxltran-js ${pkg.version} (${transformer.version()})\n`);
  process.exit(0);
}

// The value-taking flags come from the tool's own help text, so this table cannot drift from the
// flag surface of the embedded build.
const valueNames = valueFlagNames(transformer.run(["--help"], EMPTY).stdout);

// The tool validates a whole command line before it would open INPUT, and an empty input always
// stops at the signature check: the probe run therefore forwards argument errors and --help in
// the same order as the native binary, without touching any file on disk.
const probe = transformer.run(args, EMPTY);
if (probe.status === 0 || !probe.stderr.includes(NOT_JPEG_XL)) {
  emit(probe);
  process.exit(probe.status);
}

const scan = scanArguments(args, valueNames);
if (scan.input === null) {
  // Not reachable: the tool only reaches the signature check with an INPUT positional. Forward
  // what it said instead of guessing a file to read.
  emit(probe);
  process.exit(probe.status);
}

for (const file of scan.staged) {
  stageFile(transformer.fs, file);
}
for (const file of scan.extracted) {
  prepareExtract(transformer.fs, file);
}

const result = transformer.run(args, readInput(scan.input));
if (result.status !== 0) {
  emit(result);
  process.exit(result.status);
}

// Success in the native tool's order: diagnostics first, the files next, and stdout last - the
// undo line appears only after OUTPUT has been written, so a write failure keeps stdout quiet.
if (result.stderr !== "") {
  process.stderr.write(result.stderr);
}
for (const file of scan.extracted) {
  copyBack(transformer.fs, file);
}
if (scan.output !== null && result.data !== null) {
  writeOutput(scan.output, result.data);
}
if (result.stdout !== "") {
  process.stdout.write(result.stdout);
}
