import { describe, expect, it } from "vitest";
import {
  AUTHORSHIP_SEGMENT_LIMIT,
  authoredPaths,
  authoredPathsFromRows,
  computeScope,
  dirtyOrAheadPaths,
  fingerprintsMatch,
  isBranchCheckout,
  mainlineBase,
  siblingAuthoredPaths,
  snapshotTree,
  treeChangedPaths,
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

describe("authoredPaths", () => {
  function row(path: string, seq: number) {
    return {
      id: `row-${path}`,
      kind: "work",
      workKind: "file-change",
      turnId: "t",
      sourceSeqStart: seq,
      sourceSeqEnd: seq,
      change: { path, movePath: null },
    };
  }

  function fakeBb(pages: Array<{ rows: unknown[]; olderEnd: number | null }>) {
    const calls: Array<Record<string, unknown>> = [];
    const bb = {
      sdk: {
        threads: {
          timeline: async (args: Record<string, unknown>) => {
            const index = calls.length;
            calls.push(args);
            const page = pages[index] ?? { rows: [], olderEnd: null };
            const hasOlder = page.olderEnd !== null;
            return {
              rows: page.rows,
              maxSeq: 999,
              timelinePage: {
                hasOlderRows: hasOlder,
                olderCursor: hasOlder ? { anchorId: `a${index}`, anchorSeq: page.olderEnd } : null,
                olderRowsSourceSeqEnd: page.olderEnd,
              },
            };
          },
        },
      },
    } as never;
    return { bb, calls };
  }

  it("pages back until the page boundary reaches the turn start", async () => {
    const { bb, calls } = fakeBb([
      { rows: [row("late.ts", 300)], olderEnd: 250 },
      { rows: [row("mid.ts", 200)], olderEnd: 90 },
      { rows: [row("before-turn.ts", 50)], olderEnd: 10 },
    ]);
    const paths = await authoredPaths(bb, "thr", 100);
    expect(paths.sort()).toEqual(["late.ts", "mid.ts"]);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ beforeAnchorId: "a0", beforeAnchorSeq: "250" });
    for (const call of calls) {
      expect(Number(call.segmentLimit)).toBeLessThanOrEqual(AUTHORSHIP_SEGMENT_LIMIT);
    }
  });

  it("stops after one page when there is no older history", async () => {
    const { bb, calls } = fakeBb([{ rows: [row("a.ts", 150)], olderEnd: null }]);
    expect(await authoredPaths(bb, "thr", 100)).toEqual(["a.ts"]);
    expect(calls).toHaveLength(1);
  });
});

describe("fingerprintsMatch", () => {
  it("matches equal stats and hashes", () => {
    expect(fingerprintsMatch("M:1:0|abc", "M:1:0|abc")).toBe(true);
  });

  it("differs on line stats alone", () => {
    expect(fingerprintsMatch("M:1:0|", "M:2:0|")).toBe(false);
  });

  it("differs on content when both sides were hashed", () => {
    expect(fingerprintsMatch("M:1:0|abc", "M:1:0|def")).toBe(false);
  });

  it("falls back to stats when a side could not be hashed", () => {
    expect(fingerprintsMatch("M:1:0|abc", "M:1:0|")).toBe(true);
  });
});

describe("treeChangedPaths and siblingAuthoredPaths", () => {
  function file(path: string, content: string | null, insertions = 1) {
    return { path, status: "M", insertions, deletions: 0, content };
  }

  function workspaceOf(
    files: Array<ReturnType<typeof file>>,
    headSha = "h0",
    commits: string[] = [],
  ): AvailableWorkspace {
    return {
      workingTree: { files },
      checkout: { kind: "branch", branchName: "b", headSha },
      mergeBase: { files: [], commits: commits.map((sha) => ({ sha })) },
    } as unknown as AvailableWorkspace;
  }

  function fakeBb(
    live: () => AvailableWorkspace,
    commitFiles: Record<string, string[]> = {},
    timelines: Record<string, unknown[]> = {},
  ) {
    const timelineCalls: string[] = [];
    const bb = {
      sdk: {
        environments: {
          diffFile: async ({ path }: { path: string }) => {
            const hit = (
              live().workingTree.files as Array<ReturnType<typeof file>>
            ).find((entry) => entry.path === path);
            if (hit?.content === null || hit === undefined) {
              throw new Error("unreadable");
            }
            return { content: hit.content };
          },
          diffFiles: async ({ sha }: { sha: string }) => ({
            outcome: "available",
            files: (commitFiles[sha] ?? []).map((path) => ({
              path,
              previousPath: null,
            })),
          }),
        },
        threads: {
          timeline: async ({ threadId }: { threadId: string }) => {
            timelineCalls.push(threadId);
            return {
              rows: timelines[threadId] ?? [],
              maxSeq: 0,
              timelinePage: { hasOlderRows: false, olderCursor: null },
            };
          },
        },
      },
    } as never;
    return { bb, timelineCalls };
  }

  it("claims new, rewritten and committed paths but not untouched dirty ones", async () => {
    let current = workspaceOf([file("kept.ts", "k"), file("edited.ts", "v1")]);
    const { bb } = fakeBb(() => current, { c1: ["committed.ts"] });
    const before = await snapshotTree(bb, "env", current);
    current = workspaceOf(
      [file("kept.ts", "k"), file("edited.ts", "v2"), file("new.ts", "n")],
      "c1",
      ["c1"],
    );
    const changed = await treeChangedPaths(bb, "env", before, current);
    expect(changed.sort()).toEqual(["committed.ts", "edited.ts", "new.ts"]);
  });

  it("leaves untracked harness output out of the snapshot but keeps tracked harness files", async () => {
    const untracked = (path: string) => ({
      path,
      status: "??",
      insertions: null,
      deletions: null,
      content: "x",
    });
    const current = workspaceOf([
      ...Array.from({ length: 300 }, (_, i) =>
        untracked(`.claude/backups/f${i}.bak`),
      ),
      file(".claude/settings.json", "s"),
      untracked("src/new.ts"),
    ] as never);
    const { bb } = fakeBb(() => current);
    const snapshot = await snapshotTree(bb, "env", current);
    expect(Object.keys(snapshot.files).sort()).toEqual([
      ".claude/settings.json",
      "src/new.ts",
    ]);
    expect(snapshot.files["src/new.ts"]).not.toMatch(/\|$/u);
  });

  it("skips a sibling whose timeline can no longer be read", async () => {
    const entries = [
      { id: "self", parentThreadId: null, lifecycleOwnerThreadId: null, deletedAt: null, status: "idle", updatedAt: 3_000 },
      { id: "gone", parentThreadId: null, lifecycleOwnerThreadId: null, deletedAt: null, status: "active", updatedAt: 3_000 },
    ] as never;
    const bb = {
      sdk: {
        threads: {
          timeline: async () => {
            throw new Error("thread not found");
          },
        },
      },
    } as never;
    expect([...(await siblingAuthoredPaths(bb, entries, "self", 1_000))]).toEqual([]);
  });

  it("treats this thread's subagents and owned helpers as its own, not siblings", async () => {
    const startedAt = 1_000;
    const change = (path: string) => ({
      kind: "work",
      workKind: "file-change",
      createdAt: 2_000,
      change: { path, movePath: null },
    });
    const { bb, timelineCalls } = fakeBb(() => workspaceOf([]), {}, {
      sub: [change("sub.ts")],
      advisor: [change("advisor.ts")],
      sib: [change("sib.ts"), { ...change("old.ts"), createdAt: 500 }],
    });
    const entry = (
      id: string,
      extra: Record<string, unknown> = {},
    ): Record<string, unknown> => ({
      id,
      parentThreadId: null,
      lifecycleOwnerThreadId: null,
      deletedAt: null,
      status: "idle",
      updatedAt: 3_000,
      ...extra,
    });
    const entries = [
      entry("self"),
      entry("sub", { parentThreadId: "self" }),
      entry("advisor", { parentThreadId: "elsewhere", lifecycleOwnerThreadId: "self" }),
      entry("sib"),
      entry("quiet", { updatedAt: 500 }),
    ] as never;
    const foreign = await siblingAuthoredPaths(bb, entries, "self", startedAt);
    expect([...foreign]).toEqual(["sib.ts"]);
    expect(timelineCalls).toEqual(["sib"]);
  });
});
