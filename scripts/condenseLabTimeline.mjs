#!/usr/bin/env node
/**
 * Condenses an existing data/lab-timeline.jsonl in place.
 *
 * server/lab/watcher.ts now omits the full ESPN stats bodies from a sample
 * that changed nothing, keeping the response sha256s instead. This applies
 * that same rule retroactively to a file captured before the fix, where the
 * overwhelming majority of bytes are byte-identical stats payloads re-written
 * once per poll.
 *
 * Information-preserving by construction: a record is only rewritten when it
 * reports `changedCount === 0` and `responseChanged === false`, meaning the
 * record itself already asserts that nothing changed and the upstream
 * response hashed identically to the previous sample. Timing, sample number,
 * bout, round and both sha256s are all retained, so the lab's latency signal
 * survives intact. Every other record passes through unchanged.
 *
 * Usage: node scripts/condenseLabTimeline.mjs [path] [--dry-run]
 */
import { createReadStream, createWriteStream, statSync, renameSync } from "node:fs";
import { createInterface } from "node:readline";

const path = process.argv.find((arg) => !arg.startsWith("--") && arg.endsWith(".jsonl"))
  ?? "data/lab-timeline.jsonl";
const dryRun = process.argv.includes("--dry-run");

const before = statSync(path).size;
const temporaryPath = `${path}.condensed`;
const out = dryRun ? undefined : createWriteStream(temporaryPath);

let total = 0;
let condensed = 0;
let reclaimed = 0;
let kept = 0;

const write = (line) => {
  if (out === undefined) return;
  if (!out.write(`${line}\n`)) return new Promise((resolve) => out.once("drain", resolve));
};

const input = createInterface({
  input: createReadStream(path),
  crlfDelay: Infinity,
});

for await (const line of input) {
  if (line.trim() === "") continue;
  total += 1;

  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    // Never drop a line this script cannot understand.
    await write(line);
    continue;
  }

  const detail = parsed?.detail;
  const isRedundant =
    parsed?.source === "espn-stats" &&
    detail?.changedCount === 0 &&
    detail?.responseChanged === false &&
    detail?.red !== undefined &&
    detail?.blue !== undefined;

  if (!isRedundant) {
    kept += 1;
    await write(line);
    continue;
  }

  const { red, blue, ...rest } = detail;
  const next = {
    ...parsed,
    detail: {
      ...rest,
      responseSha256s: {
        red: red?.response?.sha256,
        blue: blue?.response?.sha256,
      },
    },
  };
  const serialized = JSON.stringify(next);
  condensed += 1;
  reclaimed += line.length - serialized.length;
  await write(serialized);
}

if (out !== undefined) {
  await new Promise((resolve, reject) => {
    out.end((error) => (error ? reject(error) : resolve()));
  });
}

const mb = (bytes) => `${(bytes / 1e6).toFixed(1)} MB`;
console.log(`records           : ${total} (${condensed} condensed, ${kept} untouched)`);
console.log(`size before       : ${mb(before)}`);
if (dryRun) {
  console.log(`size after (est.) : ${mb(before - reclaimed)}  [dry run, nothing written]`);
} else {
  const after = statSync(temporaryPath).size;
  if (total !== condensed + kept) throw new Error("record accounting mismatch; refusing to swap");
  renameSync(temporaryPath, path);
  console.log(`size after        : ${mb(after)}  (${(100 * (1 - after / before)).toFixed(1)}% smaller)`);
}
