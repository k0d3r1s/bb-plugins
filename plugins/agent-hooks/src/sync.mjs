// Copying the hook scripts from the plugin into their stable install path.
//
// Why a copy at all: the bb plugin cache is content-addressed
// (~/.bb/plugins/cache/git/github.com/lettland/bb-plugins/<sha>/plugins/agent-hooks),
// so wiring a provider config to the plugin directory would break on every
// update. Provider configs point at ~/.bb/agent-hooks/ instead, and this keeps
// that directory current.
//
// Integrity: these scripts decide whether arbitrary Bash runs, and the plugin
// installs from a moving git ref. CHECKSUMS is verified before anything is
// overwritten, so a tampered or truncated script cannot silently become the live
// guard.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, chmodSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { INSTALL_DIR } from "./wire.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SOURCE_DIR = path.join(HERE, "..", "hooks");
const CHECKSUMS = "CHECKSUMS";

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

export function hookScripts(dir = SOURCE_DIR) {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sh"))
    .sort();
}

export function computeChecksums(dir = SOURCE_DIR) {
  const lines = [];
  for (const name of hookScripts(dir)) {
    lines.push(`${sha256(readFileSync(path.join(dir, name)))}  ${name}`);
  }
  return lines.join("\n") + "\n";
}

export function writeChecksums(dir = SOURCE_DIR) {
  const text = computeChecksums(dir);
  writeFileSync(path.join(dir, CHECKSUMS), text);
  return text;
}

/** Throws if any script's digest disagrees with CHECKSUMS, or a file is missing
 *  from either side. A missing CHECKSUMS file is itself a failure -- unsigned
 *  security scripts are not something to shrug at. */
export function verifyChecksums(dir = SOURCE_DIR) {
  const file = path.join(dir, CHECKSUMS);
  if (!existsSync(file)) {
    throw new Error(`${file} is missing. Run 'npm run checksums' in the plugin before installing.`);
  }
  const expected = new Map(
    readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => {
        const [digest, name] = l.trim().split(/\s+/);
        return [name, digest];
      }),
  );
  const actual = new Map(hookScripts(dir).map((n) => [n, sha256(readFileSync(path.join(dir, n)))]));

  const problems = [];
  for (const [name, digest] of expected) {
    if (!actual.has(name)) problems.push(`${name}: listed in CHECKSUMS but missing from disk`);
    else if (actual.get(name) !== digest) problems.push(`${name}: digest mismatch (file was modified)`);
  }
  for (const name of actual.keys()) {
    if (!expected.has(name)) problems.push(`${name}: present on disk but absent from CHECKSUMS`);
  }
  if (problems.length > 0) {
    throw new Error(`Hook integrity check failed:\n  ${problems.join("\n  ")}`);
  }
  return true;
}

/**
 * Copy scripts into INSTALL_DIR. Returns the names whose content changed.
 *
 * Reports overwrites of differing content rather than doing it silently: the
 * install dir is what actually executes, so a hand-edit made while debugging a
 * hook would otherwise vanish on the next plugin load with no trace.
 */
export function sync({ sourceDir = SOURCE_DIR, targetDir = INSTALL_DIR, verify = true } = {}) {
  if (verify) verifyChecksums(sourceDir);
  mkdirSync(targetDir, { recursive: true, mode: 0o700 });

  const changed = [];
  for (const name of hookScripts(sourceDir)) {
    const from = path.join(sourceDir, name);
    const to = path.join(targetDir, name);
    const next = readFileSync(from);
    if (existsSync(to) && sha256(readFileSync(to)) === sha256(next)) continue;
    const overwrote = existsSync(to);
    writeFileSync(to, next, { mode: 0o700 }); // not world-writable: live security control
    chmodSync(to, 0o700);
    changed.push({ name, overwrote });
  }
  return changed;
}

/** Which install-dir scripts differ from the plugin's copies. */
export function syncDrift({ sourceDir = SOURCE_DIR, targetDir = INSTALL_DIR } = {}) {
  const drift = [];
  for (const name of hookScripts(sourceDir)) {
    const to = path.join(targetDir, name);
    if (!existsSync(to)) {
      drift.push({ name, reason: "missing" });
      continue;
    }
    const a = sha256(readFileSync(path.join(sourceDir, name)));
    const b = sha256(readFileSync(to));
    if (a !== b) drift.push({ name, reason: "differs" });
  }
  return drift;
}
