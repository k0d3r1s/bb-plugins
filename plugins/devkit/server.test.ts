import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildDocsToolSpec, buildToolSpecs, loadIndex, resolveDataRoot } from "./server.js";
import type { SkillIndex } from "./src/rank.mjs";

function fakeFetch(body: string, ok = true, status = 200) {
  return vi.fn(async () => ({ ok, status, text: async () => body })) as unknown as typeof fetch;
}

let dataRoot: string;

const INDEX: SkillIndex = {
  generatedAt: "t",
  categories: ["go", "database"],
  skills: [
    { slug: "go-testing", description: "Go tests", category: "go", keywords: ["golang"], tokens: ["go", "test", "golang"] },
    { slug: "database-redis", description: "Redis", category: "database", keywords: ["redis"], tokens: ["redis"] },
  ],
};

beforeAll(async () => {
  dataRoot = await mkdtemp(path.join(tmpdir(), "devkit-server-"));
  await mkdir(path.join(dataRoot, "skills", "go-testing"), { recursive: true });
  await writeFile(path.join(dataRoot, "skills", "go-testing", "SKILL.md"), "# Go testing\nbody\n");
  await writeFile(path.join(dataRoot, "index.json"), JSON.stringify(INDEX));
});

afterAll(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

describe("resolveDataRoot", () => {
  it("resolves content/ from a source dir", () => {
    expect(resolveDataRoot("/plugins/devkit")).toBe(path.join("/plugins/devkit", "content"));
  });
  it("resolves content/ from a dist bundle dir (sibling of dist)", () => {
    expect(resolveDataRoot("/plugins/devkit/dist")).toBe(path.join("/plugins/devkit", "content"));
  });
});

describe("loadIndex", () => {
  it("reads a valid index.json", async () => {
    const warn = vi.fn();
    const idx = await loadIndex(dataRoot, warn);
    expect(idx.skills).toHaveLength(2);
    expect(warn).not.toHaveBeenCalled();
  });
  it("falls back to an empty index and warns when the file is missing", async () => {
    const warn = vi.fn();
    const idx = await loadIndex(path.join(dataRoot, "does-not-exist"), warn);
    expect(idx.skills).toEqual([]);
    expect(warn).toHaveBeenCalledOnce();
  });
});

describe("buildToolSpecs", () => {
  it("registers exactly the two tools", () => {
    const specs = buildToolSpecs(INDEX, dataRoot);
    expect(specs.map((s) => s.name)).toEqual(["devkit_find_skills", "devkit_load_skill"]);
  });

  it("find_skills returns ranked hits", async () => {
    const find = buildToolSpecs(INDEX, dataRoot)[0]!;
    const out = await find.execute({ topic: "golang", limit: 5 });
    expect(String(out)).toContain("go-testing");
  });

  it("find_skills gives a guidance message on zero match", async () => {
    const find = buildToolSpecs(INDEX, dataRoot)[0]!;
    const out = await find.execute({ topic: "zzz-nope", limit: 5 });
    expect(String(out)).toContain("No devkit skill matched");
  });

  it("find_skills flags an empty index in the zero-match message", async () => {
    const find = buildToolSpecs({ generatedAt: "", categories: [], skills: [] }, dataRoot)[0]!;
    const out = await find.execute({ topic: "anything", limit: 5 });
    expect(String(out)).toContain("empty");
  });

  it("load_skill returns a body on success", async () => {
    const load = buildToolSpecs(INDEX, dataRoot)[1]!;
    const out = await load.execute({ slug: "go-testing" });
    expect(String(out)).toContain("Go testing");
  });

  it("load_skill returns an error shape for a bad slug", async () => {
    const load = buildToolSpecs(INDEX, dataRoot)[1]!;
    const out = await load.execute({ slug: "../../etc/passwd" });
    expect(typeof out).toBe("object");
    expect((out as { isError?: boolean }).isError).toBe(true);
  });
});

describe("buildDocsToolSpec", () => {
  it("maps a successful fetch to body text", async () => {
    const spec = buildDocsToolSpec({ fetchImpl: fakeFetch("DOC BODY") });
    expect(spec.name).toBe("devkit_docs");
    const out = await spec.execute({ query: "react hooks" });
    expect(out).toBe("DOC BODY");
  });

  it("maps a failed fetch to an error tool result", async () => {
    const spec = buildDocsToolSpec({ fetchImpl: fakeFetch("", false, 500) });
    const out = await spec.execute({ query: "react hooks" });
    expect((out as { isError?: boolean }).isError).toBe(true);
  });
});
