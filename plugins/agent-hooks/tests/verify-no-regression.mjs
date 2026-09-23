// Directional check against the recorded baseline.
//
// "All cases pass" is not the property that matters. The property is: every case
// that moved, moved from WRONG to RIGHT -- and no case that was already correct
// became wrong. A fix that loosens a catastrophic block while happening to satisfy
// its own new corpus line would pass a plain pass/fail run and fail this one.
//
//   node tests/verify-no-regression.mjs

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runAll } from "./baseline.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASELINE = path.join(HERE, "guard-bash", "baseline.json");

const before = new Map(
  JSON.parse(readFileSync(BASELINE, "utf8")).map((r) => [r.id, r]),
);
const after = await runAll();

const fixed = [];
const regressed = [];
const stillWrong = [];
const unchanged = [];

for (const now of after) {
  const then = before.get(now.id);
  if (!then) {
    (now.actual === now.expect ? unchanged : stillWrong).push(now);
    continue;
  }
  const wasRight = then.actual === then.expect;
  const isRight = now.actual === now.expect;
  if (!wasRight && isRight) fixed.push({ ...now, from: then.actual });
  else if (wasRight && !isRight) regressed.push({ ...now, from: then.actual });
  else if (!isRight) stillWrong.push(now);
  else unchanged.push(now);
}

console.log(`\n=== DIRECTIONAL CHECK vs baseline ===`);
console.log(`  fixed (wrong -> right)   ${fixed.length}`);
console.log(`  unchanged (right)        ${unchanged.length}`);
console.log(`  still wrong              ${stillWrong.length}`);
console.log(`  REGRESSED (right -> wrong) ${regressed.length}\n`);

if (fixed.length > 0) {
  console.log("fixed:");
  for (const r of fixed) console.log(`  ${r.id.padEnd(38)} ${r.from} -> ${r.actual}`);
}
if (stillWrong.length > 0) {
  console.log("\nstill wrong:");
  for (const r of stillWrong) console.log(`  ${r.id.padEnd(38)} want ${r.expect}, got ${r.actual}`);
}
if (regressed.length > 0) {
  console.log("\n!! REGRESSED — a previously-correct case now fails:");
  for (const r of regressed) {
    console.log(`  ${r.id.padEnd(38)} was ${r.from} (correct), now ${r.actual}`);
    console.log(`     $ ${r.cmd.replace(/\n/g, "\\n")}`);
  }
}

// A regression in a "must never regress" case is the failure this file exists for.
const fatal = regressed.length > 0 || stillWrong.length > 0;
if (fatal) {
  console.error("\nFAIL");
  process.exit(1);
}
console.log("\nOK — every change moved wrong -> right, nothing regressed.");
