import { describe, expect, it } from "vitest";
import {
  authoredPathsFromRows,
  computeScope,
  dirtyOrAheadPaths,
  isBranchCheckout,
  mainlineBase,
  type AvailableWorkspace,
} from "./detect.js";

type Rows = Parameters<typeof authoredPathsFromRows>[0];

function fileChange(
  path: string,
  movePath: string | null = null,
  sourceSeqStart = 100,
): unknown {
  return {
    id: `row-${path}-${sourceSeqStart}`,
    kind: "work",
    workKind: "file-change",
    turnId: "turn-1",
    sourceSeqStart,
    sourceSeqEnd: sourceSeqStart,
    change: { path, movePath },
  };
}

function rows(items: unknown[]): Rows {
  return items as unknown as Rows;
}

describe("authoredPathsFromRows", () => {
  it("collects file-change paths and their move targets after the cursor", () => {
    const result = authoredPathsFromRows(
      rows([fileChange("src/a.ts"), fileChange("old.ts", "new.ts")]),
      50,
    );
    expect(result.sort()).toEqual(["new.ts", "old.ts", "src/a.ts"]);
  });

  it("excludes rows at or before the turn-start cursor", () => {
    const result = authoredPathsFromRows(
      rows([
        fileChange("before.ts", null, 40),
        fileChange("at.ts", null, 50),
        fileChange("after.ts", null, 60),
      ]),
      50,
    );
    expect(result).toEqual(["after.ts"]);
  });

  it("dedups repeated paths within a turn", () => {
    expect(
      authoredPathsFromRows(
        rows([fileChange("src/a.ts", null, 60), fileChange("src/a.ts", null, 70)]),
        50,
      ),
    ).toEqual(["src/a.ts"]);
  });

  it("ignores non file-change rows", () => {
    expect(
      authoredPathsFromRows(
        rows([
          { id: "r", kind: "work", workKind: "tool", sourceSeqStart: 60 },
          fileChange("x.ts"),
        ]),
        50,
      ),
    ).toEqual(["x.ts"]);
  });

  it("walks nested childRows and children", () => {
    const nested = rows([
      {
        id: "d",
        kind: "work",
        workKind: "delegation",
        sourceSeqStart: 60,
        childRows: [fileChange("child.ts")],
      },
      { id: "t", kind: "turn", sourceSeqStart: 60, children: [fileChange("turn.ts")] },
    ]);
    expect(authoredPathsFromRows(nested, 50).sort()).toEqual([
      "child.ts",
      "turn.ts",
    ]);
  });
});

describe("computeScope", () => {
  it("keeps only authored paths that are currently dirty or ahead", () => {
    expect(
      computeScope(["a.ts", "b.ts", "c.ts"], new Set(["b.ts", "c.ts", "d.ts"])),
    ).toEqual(["b.ts", "c.ts"]);
  });

  it("is empty when nothing authored is still changed", () => {
    expect(computeScope(["a.ts"], new Set(["b.ts"]))).toEqual([]);
  });
});

function workspace(over: Record<string, unknown>): AvailableWorkspace {
  return {
    workingTree: { files: [] },
    branch: { currentBranch: "bb/feature", defaultBranch: "master" },
    checkout: { kind: "branch" },
    mergeBase: null,
    ...over,
  } as unknown as AvailableWorkspace;
}

describe("dirtyOrAheadPaths", () => {
  it("unions working-tree and ahead-commit files", () => {
    const ws = workspace({
      workingTree: { files: [{ path: "w.ts" }] },
      mergeBase: { files: [{ path: "a.ts" }], mergeBaseBranch: "master" },
    });
    expect([...dirtyOrAheadPaths(ws)].sort()).toEqual(["a.ts", "w.ts"]);
  });

  it("handles a null merge base", () => {
    const ws = workspace({ workingTree: { files: [{ path: "w.ts" }] } });
    expect([...dirtyOrAheadPaths(ws)]).toEqual(["w.ts"]);
  });
});

describe("mainlineBase", () => {
  it("prefers the merge-base branch", () => {
    expect(
      mainlineBase(workspace({ mergeBase: { files: [], mergeBaseBranch: "trunk" } })),
    ).toBe("trunk");
  });

  it("falls back to the default branch", () => {
    expect(mainlineBase(workspace({ mergeBase: null }))).toBe("master");
  });
});

describe("isBranchCheckout", () => {
  it("is true only for a branch checkout", () => {
    expect(isBranchCheckout(workspace({ checkout: { kind: "branch" } }))).toBe(
      true,
    );
    expect(isBranchCheckout(workspace({ checkout: { kind: "detached" } }))).toBe(
      false,
    );
  });
});
