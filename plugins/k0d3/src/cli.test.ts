import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runK0d3Cli } from "./cli.mjs";
import type { SkillIndex } from "./rank.mjs";

let dataRoot: string;
const index: SkillIndex = {
  generatedAt: "t",
  categories: ["go"],
  skills: [
    { slug: "go-testing", description: "Go tests", category: "go", keywords: ["golang"], tokens: ["go", "test", "golang"] },
    { slug: "go-essentials", description: "Go basics", category: "go", keywords: [], tokens: ["go", "basic"] },
    { slug: "cmd-commit", description: "Command — Create git commits", category: "cmd", keywords: [], tokens: ["commit"] },
  ],
};
const deps = () => ({ index, dataRoot });

beforeAll(async () => {
  dataRoot = await mkdtemp(path.join(tmpdir(), "k0d3-cli-"));
  await mkdir(path.join(dataRoot, "skills", "go-testing"), { recursive: true });
  await writeFile(path.join(dataRoot, "skills", "go-testing", "SKILL.md"), "# Go testing\nbody\n");
});
afterAll(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

describe("runK0d3Cli", () => {
  it("prints usage for no args / help", async () => {
    expect((await runK0d3Cli([], deps())).exitCode).toBe(0);
    expect((await runK0d3Cli(["help"], deps())).stdout).toContain("bb k0d3");
  });

  it("review code returns the review-code instruction", async () => {
    const r = await runK0d3Cli(["review", "code"], deps());
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("review-code");
  });

  it("review without a mode fails", async () => {
    expect((await runK0d3Cli(["review"], deps())).exitCode).toBe(2);
  });

  it("review impl needs a range; plan needs a path", async () => {
    expect((await runK0d3Cli(["review", "impl"], deps())).exitCode).toBe(2);
    expect((await runK0d3Cli(["review", "plan"], deps())).exitCode).toBe(2);
    expect((await runK0d3Cli(["review", "plan", "docs/p.md"], deps())).exitCode).toBe(0);
  });

  it("review impl interpolates a real range and rejects a non-range target", async () => {
    const ok = await runK0d3Cli(["review", "impl", "main..feature"], deps());
    expect(ok.exitCode).toBe(0);
    expect(ok.stdout).toContain("main..feature");
    expect((await runK0d3Cli(["review", "impl", "main"], deps())).exitCode).toBe(2);
  });

  it("ignores extra positional args and treats whitespace-only topic as empty", async () => {
    expect((await runK0d3Cli(["review", "code", "junk"], deps())).exitCode).toBe(0);
    expect((await runK0d3Cli(["skills", "find", "   "], deps())).exitCode).toBe(2);
  });

  it("skills list prints every slug", async () => {
    const r = await runK0d3Cli(["skills", "list"], deps());
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("go-testing:");
    expect(r.stdout).toContain("go-essentials:");
  });

  it("skills find ranks by topic; empty topic fails", async () => {
    const r = await runK0d3Cli(["skills", "find", "golang"], deps());
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("go-testing");
    expect((await runK0d3Cli(["skills", "find"], deps())).exitCode).toBe(2);
  });

  it("skills show prints a body; unknown slug errors", async () => {
    const ok = await runK0d3Cli(["skills", "show", "go-testing"], deps());
    expect(ok.exitCode).toBe(0);
    expect(ok.stdout).toContain("Go testing");
    const bad = await runK0d3Cli(["skills", "show", "nope"], deps());
    expect(bad.exitCode).toBe(1);
  });

  it("rejects unknown commands and subcommands", async () => {
    expect((await runK0d3Cli(["bogus"], deps())).exitCode).toBe(2);
    expect((await runK0d3Cli(["skills", "bogus"], deps())).exitCode).toBe(2);
  });

  it("lists command workflows without the cmd- prefix", async () => {
    const r = await runK0d3Cli(["commands"], deps());
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("commit:");
    expect(r.stdout).not.toContain("cmd-commit");
  });

  it("run resolves a known command and rejects an unknown one", async () => {
    const ok = await runK0d3Cli(["run", "commit"], deps());
    expect(ok.exitCode).toBe(0);
    expect(ok.stdout).toContain("cmd-commit");
    expect((await runK0d3Cli(["run", "nope"], deps())).exitCode).toBe(1);
    expect((await runK0d3Cli(["run"], deps())).exitCode).toBe(2);
  });

  it("review injects a turn when requestReview succeeds, else prints instructions", async () => {
    const injected = await runK0d3Cli(["review", "code"], { ...deps(), requestReview: async () => true });
    expect(injected.stdout).toContain("Review requested");
    const printed = await runK0d3Cli(["review", "code"], { ...deps(), requestReview: async () => false });
    expect(printed.stdout).toContain("review-code");
  });
});
