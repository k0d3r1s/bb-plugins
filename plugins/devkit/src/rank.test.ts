import { describe, expect, it } from "vitest";
import { clampLimit, rankSkills } from "./rank.mjs";
import { tokenize } from "./text.mjs";
import type { SkillIndexEntry } from "./rank.mjs";

function entry(slug: string, description: string, keywords: string[], tokens?: string[]): SkillIndexEntry {
  return {
    slug,
    description,
    category: "x",
    keywords,
    tokens: tokens ?? [...new Set([...tokenize(slug), ...tokenize(description), ...keywords])],
  };
}

const corpus: SkillIndexEntry[] = [
  entry("go-essentials", "Go naming, errors, modules", ["golang"]),
  entry("go-testing", "Go tests, table-driven", []),
  entry("python-essentials", "Python typing, packaging", []),
];

describe("rankSkills", () => {
  it("ranks a keyword+token match ahead of the field", () => {
    expect(rankSkills(corpus, "golang errors", 5).map((h) => h.slug)).toMatchInlineSnapshot(`
      [
        "go-essentials",
      ]
    `);
  });

  it("weights a keyword hit above a token-only hit", () => {
    const entries = [
      entry("b-token-only", "", [], ["cache"]),
      entry("a-keyword", "", ["cache"], ["cache"]),
    ];
    // a-keyword scores 5 (keyword), b-token-only scores 2 (token) → keyword first
    expect(rankSkills(entries, "cache", 5).map((h) => h.slug)).toEqual(["a-keyword", "b-token-only"]);
  });

  it("gives an exact slug match the top spot via the slug bonus", () => {
    const entries = [
      entry("cache", "", [], []), // exact-slug bonus 10, no token/keyword hit
      entry("database-cache", "", ["cache"], ["cache"]), // keyword 5
    ];
    expect(rankSkills(entries, "cache", 5)[0]?.slug).toBe("cache");
  });

  it("returns nothing for an unrelated topic", () => {
    expect(rankSkills(corpus, "haskell monads", 5)).toEqual([]);
  });

  it("breaks score ties by slug ascending and respects the limit", () => {
    const tie = [entry("b-skill", "shared", []), entry("a-skill", "shared", [])];
    expect(rankSkills(tie, "shared", 1).map((h) => h.slug)).toEqual(["a-skill"]);
  });
});

describe("clampLimit", () => {
  it("clamps to [1,25] with a default of 8 for non-positive/invalid input", () => {
    expect(clampLimit(3)).toBe(3);
    expect(clampLimit(25)).toBe(25);
    expect(clampLimit(999)).toBe(25);
    expect(clampLimit(0)).toBe(8);
    expect(clampLimit(-4)).toBe(8);
    expect(clampLimit(Number.NaN)).toBe(8);
    expect(clampLimit(undefined)).toBe(8);
  });
});
