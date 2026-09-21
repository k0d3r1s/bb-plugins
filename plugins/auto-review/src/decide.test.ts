import { describe, expect, it } from "vitest";
import { decide } from "./decide.js";

const ELIGIBLE = ["master"];

describe("decide branch policy", () => {
  it("worktree on eligible mainline: commit + merge", () => {
    expect(
      decide({
        base: "master",
        currentBranch: "bb/feature",
        isDedicatedWorktree: true,
        mergeEligibleMainlines: ELIGIBLE,
      }),
    ).toEqual({ commit: true, merge: true });
  });

  it("worktree on non-eligible mainline: commit only", () => {
    expect(
      decide({
        base: "main",
        currentBranch: "bb/feature",
        isDedicatedWorktree: true,
        mergeEligibleMainlines: ELIGIBLE,
      }),
    ).toEqual({ commit: true, merge: false });
  });

  it("primary checkout on a feature branch: commit, no merge (eligible)", () => {
    expect(
      decide({
        base: "master",
        currentBranch: "feature",
        isDedicatedWorktree: false,
        mergeEligibleMainlines: ELIGIBLE,
      }),
    ).toEqual({ commit: true, merge: false });
  });

  it("primary checkout on a feature branch: nothing when the root is protected (non-eligible)", () => {
    expect(
      decide({
        base: "main",
        currentBranch: "feature",
        isDedicatedWorktree: false,
        mergeEligibleMainlines: ELIGIBLE,
      }),
    ).toEqual({ commit: false, merge: false });
  });

  it("primary checkout on eligible mainline: commit, no merge", () => {
    expect(
      decide({
        base: "master",
        currentBranch: "master",
        isDedicatedWorktree: false,
        mergeEligibleMainlines: ELIGIBLE,
      }),
    ).toEqual({ commit: true, merge: false });
  });

  it("primary checkout on non-eligible mainline: nothing (no commit)", () => {
    expect(
      decide({
        base: "main",
        currentBranch: "main",
        isDedicatedWorktree: false,
        mergeEligibleMainlines: ELIGIBLE,
      }),
    ).toEqual({ commit: false, merge: false });
  });

  it("never merges when on the base branch, even in a worktree", () => {
    expect(
      decide({
        base: "master",
        currentBranch: "master",
        isDedicatedWorktree: true,
        mergeEligibleMainlines: ELIGIBLE,
      }).merge,
    ).toBe(false);
  });

  it("never merges from a non-dedicated worktree", () => {
    expect(
      decide({
        base: "master",
        currentBranch: "bb/feature",
        isDedicatedWorktree: false,
        mergeEligibleMainlines: ELIGIBLE,
      }).merge,
    ).toBe(false);
  });
});
