import { describe, expect, it } from "vitest";
import { hasActiveSibling, passesThreadGate, selfIsWorktree } from "./gate.js";

const okThread = {
  parentThreadId: null,
  originPluginId: null,
  visibility: "visible",
  environmentId: "env_1",
};

describe("passesThreadGate", () => {
  it("passes a top-level, visible, environment-bound thread", () => {
    expect(passesThreadGate(okThread)).toBe(true);
  });

  it("skips child / subagent threads", () => {
    expect(passesThreadGate({ ...okThread, parentThreadId: "thr_p" })).toBe(false);
  });

  it("skips plugin/automation-spawned threads", () => {
    expect(passesThreadGate({ ...okThread, originPluginId: "workflows" })).toBe(
      false,
    );
  });

  it("skips hidden threads", () => {
    expect(passesThreadGate({ ...okThread, visibility: "hidden" })).toBe(false);
  });

  it("skips threads without an environment", () => {
    expect(passesThreadGate({ ...okThread, environmentId: null })).toBe(false);
  });
});

type Entries = Parameters<typeof hasActiveSibling>[0];

function entries(
  rows: Array<{ id: string; status: string; environmentIsWorktree?: boolean }>,
): Entries {
  return rows as unknown as Entries;
}

describe("hasActiveSibling", () => {
  it("ignores the thread itself", () => {
    expect(
      hasActiveSibling(entries([{ id: "self", status: "active" }]), "self"),
    ).toBe(false);
  });

  it("detects an active sibling", () => {
    expect(
      hasActiveSibling(
        entries([
          { id: "self", status: "idle" },
          { id: "other", status: "active" },
        ]),
        "self",
      ),
    ).toBe(true);
  });

  it("treats starting as busy", () => {
    expect(
      hasActiveSibling(
        entries([{ id: "other", status: "starting" }]),
        "self",
      ),
    ).toBe(true);
  });

  it("ignores idle siblings", () => {
    expect(
      hasActiveSibling(entries([{ id: "other", status: "idle" }]), "self"),
    ).toBe(false);
  });
});

describe("selfIsWorktree", () => {
  it("reads the worktree flag off the thread's own entry", () => {
    const rows = entries([
      { id: "self", status: "idle", environmentIsWorktree: true },
      { id: "other", status: "idle", environmentIsWorktree: false },
    ]);
    expect(selfIsWorktree(rows, "self")).toBe(true);
    expect(selfIsWorktree(rows, "other")).toBe(false);
  });

  it("is false when the thread's entry is absent", () => {
    expect(
      selfIsWorktree(entries([{ id: "other", status: "idle" }]), "self"),
    ).toBe(false);
  });
});
