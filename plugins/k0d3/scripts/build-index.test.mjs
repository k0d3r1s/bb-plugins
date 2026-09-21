import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildIndex } from "./build-index.mjs";

let root;

async function skill(slug, frontmatter, body = "body") {
  const dir = path.join(root, "skills", slug);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "SKILL.md"), `---\n${frontmatter}\n---\n\n${body}\n`);
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "k0d3-index-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("buildIndex", () => {
  it("indexes a valid skill and derives its category + tokens", async () => {
    await skill(
      "go-essentials",
      "name: go-essentials\ndescription: Go naming, errors, modules\nmetadata:\n  type: language\n  keywords: [golang]",
    );
    const { entries, categories, errors } = await buildIndex(root);
    expect(errors).toEqual([]);
    expect(entries).toHaveLength(1);
    expect(entries[0].slug).toBe("go-essentials");
    expect(entries[0].category).toBe("language");
    expect(entries[0].keywords).toContain("golang");
    expect(entries[0].tokens).toContain("error");
    expect(categories).toEqual(["language"]);
  });

  it("derives category from the slug prefix, falling back to misc", async () => {
    await skill("rust-cli", "name: rust-cli\ndescription: Rust CLIs");
    await skill("x-thing", "name: x-thing\ndescription: single-char prefix");
    const { entries } = await buildIndex(root);
    const byslug = Object.fromEntries(entries.map((e) => [e.slug, e.category]));
    expect(byslug["rust-cli"]).toBe("rust");
    expect(byslug["x-thing"]).toBe("misc");
  });

  it("flags a name/dirname mismatch", async () => {
    await skill("go-essentials", "name: wrong-name\ndescription: x");
    const { errors } = await buildIndex(root);
    expect(errors.some((e) => e.includes("must equal directory name"))).toBe(true);
  });

  it("flags a missing frontmatter block", async () => {
    const dir = path.join(root, "skills", "no-fm");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "SKILL.md"), "# no frontmatter here\n");
    const { errors } = await buildIndex(root);
    expect(errors.some((e) => e.includes("no frontmatter"))).toBe(true);
  });

  it("flags an over-long description", async () => {
    await skill("long-desc", `name: long-desc\ndescription: ${"x".repeat(1025)}`);
    const { errors } = await buildIndex(root);
    expect(errors.some((e) => e.includes("description exceeds"))).toBe(true);
  });

  it("flags a skill directory missing SKILL.md", async () => {
    await mkdir(path.join(root, "skills", "empty-dir"), { recursive: true });
    const { errors } = await buildIndex(root);
    expect(errors.some((e) => e.includes("missing SKILL.md"))).toBe(true);
  });

  it("flags unparseable YAML frontmatter", async () => {
    await skill("bad-yaml", "name: bad-yaml\ndescription: \"unterminated");
    const { errors } = await buildIndex(root);
    expect(errors.some((e) => e.includes("unparseable frontmatter"))).toBe(true);
  });

  it("reports a missing skills directory rather than throwing", async () => {
    const { entries, errors } = await buildIndex(path.join(root, "nope"));
    expect(entries).toEqual([]);
    expect(errors.some((e) => e.includes("content skills dir missing"))).toBe(true);
  });
});

describe("committed index invariant", () => {
  it("content/index.json matches a fresh build (skills + categories)", async () => {
    const contentDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "content");
    const { entries, categories, errors } = await buildIndex(contentDir);
    expect(errors).toEqual([]);
    const committed = JSON.parse(await readFile(path.join(contentDir, "index.json"), "utf8"));
    expect(committed.categories).toEqual(categories);
    expect(committed.skills).toEqual(entries);
  });
});
