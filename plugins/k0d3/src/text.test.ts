import { describe, expect, it } from "vitest";
import { tokenize } from "./text.mjs";

describe("tokenize", () => {
  it("keeps 2-char tech tokens the corpus depends on", () => {
    expect(tokenize("go js ts ci ui db")).toEqual(
      expect.arrayContaining(["go", "js", "ts", "ci", "ui", "db"]),
    );
  });

  it("drops short grammar stopwords and 1-char noise", () => {
    const t = tokenize("it is on a go module");
    expect(t).toContain("go");
    expect(t).toContain("module");
    expect(t).not.toContain("it");
    expect(t).not.toContain("is");
    expect(t).not.toContain("on");
    expect(t).not.toContain("a");
  });

  it("singularizes trailing s only for longer words", () => {
    expect(tokenize("errors modules")).toEqual(expect.arrayContaining(["error", "module"]));
    // 'js' must not be singularized to 'j'
    expect(tokenize("js")).toEqual(["js"]);
  });

  it("dedupes and lowercases", () => {
    expect(tokenize("Go GO go")).toEqual(["go"]);
  });
});
