import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, statSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// INSTALL_DIR is derived from os.homedir() at import time, so HOME must point at
// a throwaway directory BEFORE sync.mjs (and wire.mjs) load. vi.hoisted runs
// ahead of the hoisted imports below.
const { fakeHome, realHome } = await vi.hoisted(async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const p = await import("node:path");
  const realHome = process.env.HOME;
  const fakeHome = fs.mkdtempSync(p.join(os.tmpdir(), "sync-test-home-"));
  process.env.HOME = fakeHome;
  return { fakeHome, realHome };
});

import { SOURCE_DIR, hookScripts, computeChecksums, writeChecksums, verifyChecksums, sync, syncDrift } from "./sync.mjs";
import { INSTALL_DIR } from "./wire.mjs";

const tmp = () => mkdtempSync(path.join(tmpdir(), "sync-test-"));
const dirs: string[] = [];
const scratch = () => {
  const d = tmp();
  dirs.push(d);
  return d;
};

/** A signed source dir with two scripts plus a non-script that must be ignored. */
function signedSource() {
  const dir = scratch();
  writeFileSync(path.join(dir, "b.sh"), "#!/usr/bin/env bash\necho b\n");
  writeFileSync(path.join(dir, "a.sh"), "#!/usr/bin/env bash\necho a\n");
  writeFileSync(path.join(dir, "README.md"), "not a hook\n");
  writeChecksums(dir);
  return dir;
}

beforeEach(() => {
  // Hard stop if the HOME redirect did not take: the default-target tests below
  // would otherwise write into the real ~/.bb/agent-hooks.
  if (!INSTALL_DIR.startsWith(fakeHome)) throw new Error(`INSTALL_DIR escaped the fake HOME: ${INSTALL_DIR}`);
});

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  rmSync(fakeHome, { recursive: true, force: true });
  process.env.HOME = realHome;
});

describe("hookScripts", () => {
  it("lists only .sh files, sorted", () => {
    expect(hookScripts(signedSource())).toEqual(["a.sh", "b.sh"]);
  });

  it("defaults to the plugin's own hooks directory", () => {
    const names = hookScripts();
    expect(names).toEqual([...names].sort());
    expect(names).toContain("guard-bash.sh");
    expect(names).toContain("codex-shim.sh");
    expect(names.every((n: string) => n.endsWith(".sh"))).toBe(true);
    expect(SOURCE_DIR).toBe(path.resolve(import.meta.dirname, "..", "hooks"));
  });
});

describe("checksums", () => {
  it("computes one sha256 line per script in sorted order", () => {
    const dir = signedSource();
    const lines = computeChecksums(dir).trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^[0-9a-f]{64} {2}a\.sh$/);
    expect(lines[1]).toMatch(/^[0-9a-f]{64} {2}b\.sh$/);
  });

  it("writeChecksums persists exactly what computeChecksums returns", () => {
    const dir = signedSource();
    const text = writeChecksums(dir);
    expect(readFileSync(path.join(dir, "CHECKSUMS"), "utf8")).toBe(text);
    expect(text).toBe(computeChecksums(dir));
  });

  it("the shipped hooks match the committed CHECKSUMS", () => {
    // The real integrity gate the plugin runs on every load.
    expect(verifyChecksums()).toBe(true);
    expect(readFileSync(path.join(SOURCE_DIR, "CHECKSUMS"), "utf8")).toBe(computeChecksums());
  });

  it("verifies a freshly signed directory", () => {
    expect(verifyChecksums(signedSource())).toBe(true);
  });

  it("tolerates blank lines and surrounding whitespace in CHECKSUMS", () => {
    const dir = signedSource();
    const text = computeChecksums(dir);
    writeFileSync(path.join(dir, "CHECKSUMS"), `\n  ${text.replace("\n", "\n\n   ")}\n\n`);
    expect(verifyChecksums(dir)).toBe(true);
  });

  it("fails when CHECKSUMS itself is missing", () => {
    const dir = signedSource();
    rmSync(path.join(dir, "CHECKSUMS"));
    expect(() => verifyChecksums(dir)).toThrow(/CHECKSUMS is missing.*npm run checksums/);
  });

  it("fails on a modified script", () => {
    const dir = signedSource();
    writeFileSync(path.join(dir, "a.sh"), "#!/usr/bin/env bash\nrm -rf /\n");
    expect(() => verifyChecksums(dir)).toThrow(/a\.sh: digest mismatch/);
  });

  it("fails on a script listed but deleted, and one added but unsigned, reporting both", () => {
    const dir = signedSource();
    rmSync(path.join(dir, "b.sh"));
    writeFileSync(path.join(dir, "c.sh"), "echo c\n");
    let message = "";
    try {
      verifyChecksums(dir);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/^Hook integrity check failed:/);
    expect(message).toContain("b.sh: listed in CHECKSUMS but missing from disk");
    expect(message).toContain("c.sh: present on disk but absent from CHECKSUMS");
    expect(message).not.toContain("a.sh");
  });
});

describe("sync", () => {
  it("copies every script with owner-only permissions and reports them as new", () => {
    const src = signedSource();
    const target = path.join(scratch(), "nested", "install");
    const changed = sync({ sourceDir: src, targetDir: target });
    expect(changed).toEqual([
      { name: "a.sh", overwrote: false },
      { name: "b.sh", overwrote: false },
    ]);
    expect(readdirSync(target).sort()).toEqual(["a.sh", "b.sh"]); // no README, no CHECKSUMS
    for (const n of ["a.sh", "b.sh"]) {
      expect(readFileSync(path.join(target, n), "utf8")).toBe(readFileSync(path.join(src, n), "utf8"));
      expect(statSync(path.join(target, n)).mode & 0o777).toBe(0o700);
    }
  });

  it("is a no-op when the install dir is already current", () => {
    const src = signedSource();
    const target = scratch();
    sync({ sourceDir: src, targetDir: target });
    expect(sync({ sourceDir: src, targetDir: target })).toEqual([]);
  });

  it("names a hand-edited install copy it overwrites, and restores its mode", () => {
    const src = signedSource();
    const target = scratch();
    sync({ sourceDir: src, targetDir: target });
    writeFileSync(path.join(target, "b.sh"), "echo debugging\n", { mode: 0o777 });
    const changed = sync({ sourceDir: src, targetDir: target });
    expect(changed).toEqual([{ name: "b.sh", overwrote: true }]);
    expect(readFileSync(path.join(target, "b.sh"), "utf8")).toBe(readFileSync(path.join(src, "b.sh"), "utf8"));
    expect(statSync(path.join(target, "b.sh")).mode & 0o777).toBe(0o700);
  });

  it("refuses to copy anything when the source fails verification", () => {
    const src = signedSource();
    writeFileSync(path.join(src, "a.sh"), "tampered\n");
    const target = path.join(scratch(), "install");
    expect(() => sync({ sourceDir: src, targetDir: target })).toThrow(/digest mismatch/);
    expect(existsSync(target)).toBe(false);
  });

  it("copies an unsigned source only when verification is explicitly disabled", () => {
    const src = scratch();
    writeFileSync(path.join(src, "x.sh"), "echo x\n");
    const target = scratch();
    expect(sync({ sourceDir: src, targetDir: target, verify: false })).toEqual([{ name: "x.sh", overwrote: false }]);
  });

  it("defaults to the shipped hooks and the install dir under HOME", () => {
    const changed = sync();
    expect(changed.map((c: { name: string }) => c.name)).toEqual(hookScripts());
    expect(existsSync(path.join(fakeHome, ".bb", "agent-hooks", "guard-bash.sh"))).toBe(true);
    expect(syncDrift()).toEqual([]);
  });
});

describe("syncDrift", () => {
  it("reports missing and differing scripts, and nothing for current ones", () => {
    const src = signedSource();
    const target = scratch();
    expect(syncDrift({ sourceDir: src, targetDir: target })).toEqual([
      { name: "a.sh", reason: "missing" },
      { name: "b.sh", reason: "missing" },
    ]);
    sync({ sourceDir: src, targetDir: target });
    expect(syncDrift({ sourceDir: src, targetDir: target })).toEqual([]);
    writeFileSync(path.join(target, "a.sh"), "edited\n");
    expect(syncDrift({ sourceDir: src, targetDir: target })).toEqual([{ name: "a.sh", reason: "differs" }]);
  });

  it("ignores extra files in the install dir", () => {
    const src = signedSource();
    const target = scratch();
    sync({ sourceDir: src, targetDir: target });
    mkdirSync(path.join(target, "sub"));
    writeFileSync(path.join(target, "stray.sh"), "echo stray\n");
    expect(syncDrift({ sourceDir: src, targetDir: target })).toEqual([]);
  });
});
