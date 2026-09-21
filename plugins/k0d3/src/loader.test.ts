import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadSkill, MAX_BODY_BYTES } from "./loader.mjs";

let dataRoot: string;

beforeAll(async () => {
  dataRoot = await mkdtemp(path.join(tmpdir(), "k0d3-loader-"));
  await mkdir(path.join(dataRoot, "skills", "go-essentials"), { recursive: true });
  await writeFile(path.join(dataRoot, "skills", "go-essentials", "SKILL.md"), "# Go essentials\nbody\n");
  await mkdir(path.join(dataRoot, "references"), { recursive: true });
  await writeFile(path.join(dataRoot, "references", "owasp-categories.md"), "# OWASP\n");
  await mkdir(path.join(dataRoot, "skills", "big"), { recursive: true });
  await writeFile(path.join(dataRoot, "skills", "big", "SKILL.md"), "x".repeat(MAX_BODY_BYTES + 100));
  await mkdir(path.join(dataRoot, "skills", "exact"), { recursive: true });
  await writeFile(path.join(dataRoot, "skills", "exact", "SKILL.md"), "y".repeat(MAX_BODY_BYTES));
});

afterAll(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

describe("loadSkill", () => {
  it("loads a valid skill body", async () => {
    const r = await loadSkill(dataRoot, "go-essentials");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.content).toContain("Go essentials");
  });

  it("loads a named reference without needing a slug", async () => {
    const r = await loadSkill(dataRoot, undefined, "owasp-categories");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.content).toContain("OWASP");
  });

  it("errors when neither slug nor reference is given", async () => {
    const r = await loadSkill(dataRoot);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("invalid_slug");
  });

  it.each([
    "../../../../etc/passwd",
    "../secret",
    "/etc/passwd",
    "foo/bar",
    "bad--slug",
  ])("rejects traversal / malformed slug %s", async (slug) => {
    const r = await loadSkill(dataRoot, slug);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("invalid_slug");
  });

  it("rejects a malformed reference", async () => {
    const r = await loadSkill(dataRoot, undefined, "../secret");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("invalid_reference");
  });

  it("returns an actionable not_found for an unknown slug", async () => {
    const r = await loadSkill(dataRoot, "nonexistent-skill");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("not_found");
      expect(r.message).toContain("k0d3_find_skills");
    }
  });

  it("returns not_found for a well-formed but missing reference", async () => {
    const r = await loadSkill(dataRoot, undefined, "no-such-reference");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("not_found");
  });

  it("truncates an oversized body with a marker", async () => {
    const r = await loadSkill(dataRoot, "big");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.truncated).toBe(true);
      expect(r.content).toContain("[truncated");
    }
  });

  it("does NOT truncate a body of exactly MAX_BODY_BYTES", async () => {
    const r = await loadSkill(dataRoot, "exact");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.truncated).toBe(false);
  });
});
