/**
 * Splits the single jxlc box of a JPEG XL container into two jxlp boxes, so the tests have an
 * input for `--jxlp=sort` and `--jxlp=merge`. All other boxes are carried over unchanged.
 *
 * The first jxlp box carries counter 0, the second carries counter 1 with the most significant
 * bit set, which marks it as the last jxlp box (ISO/IEC 18181-1, "JPEG XL container").
 *
 * Usage:
 *
 *   node mkjxlp.mjs input.jxl output.jxl
 */

import { readFileSync, writeFileSync } from "node:fs";

const [input, output] = process.argv.slice(2);
if (input === undefined || output === undefined) {
  console.error("usage: node mkjxlp.mjs input.jxl output.jxl");
  process.exit(1);
}

const data = readFileSync(input);

// Parse the ISOBMFF box list: 4-byte big-endian size (size 1: 64-bit size follows, size 0: box
// runs to the end of the file) and a 4-byte type.
const boxes = [];
let offset = 0;
while (offset < data.length) {
  let size = data.readUInt32BE(offset);
  const type = data.toString("latin1", offset + 4, offset + 8);
  let header = 8;
  if (size === 1) {
    size = Number(data.readBigUInt64BE(offset + 8));
    header = 16;
  } else if (size === 0) {
    size = data.length - offset;
  }
  boxes.push({ type, body: data.subarray(offset + header, offset + size) });
  offset += size;
}

// Replace the jxlc box with two jxlp boxes over the halves of its codestream.
const rewritten = [];
let jxlcBoxes = 0;
for (const box of boxes) {
  if (box.type !== "jxlc") {
    rewritten.push(box);
    continue;
  }
  jxlcBoxes++;
  const half = Math.ceil(box.body.length / 2);
  const chunks = [box.body.subarray(0, half), box.body.subarray(half)];
  chunks.forEach((chunk, index) => {
    const body = Buffer.alloc(4 + chunk.length);
    body.writeUInt32BE(index === chunks.length - 1 ? (0x80000000 | index) >>> 0 : index, 0);
    chunk.copy(body, 4);
    rewritten.push({ type: "jxlp", body });
  });
}
if (jxlcBoxes !== 1) {
  console.error(`${input}: expected exactly one jxlc box, found ${jxlcBoxes}`);
  process.exit(1);
}

const written = Buffer.concat(
  rewritten.map((box) => {
    const header = Buffer.alloc(8);
    header.writeUInt32BE(8 + box.body.length, 0);
    header.write(box.type, 4, "latin1");
    return Buffer.concat([header, box.body]);
  }),
);
writeFileSync(output, written);
console.log(`${input}: ${boxes.length} boxes -> ${output}: ${rewritten.length} boxes (${written.length} bytes)`);
