import { describe, expect, it } from "vitest";
import { isCommitPlan, planApprovalOf, planGateAction } from "./plan.js";

function approval(overrides: Record<string, unknown> = {}, subject: Record<string, unknown> = {}) {
  return {
    id: "pint-1",
    status: "pending",
    payload: {
      kind: "approval",
      availableDecisions: ["allow_once", "deny"],
      reason: null,
      subject: { kind: "plan", itemId: "i", plan: "# Plan", planFilePath: "/p.md", ...subject },
    },
    ...overrides,
  } as never;
}

describe("planApprovalOf", () => {
  it("extracts a pending, deniable plan approval", () => {
    expect(planApprovalOf(approval())).toEqual({
      interactionId: "pint-1",
      plan: "# Plan",
      planFilePath: "/p.md",
    });
  });

  it("ignores settled, non-plan, and undeniable approvals", () => {
    expect(planApprovalOf(approval({ status: "resolved" }))).toBeNull();
    expect(planApprovalOf(approval({}, { kind: "command" }))).toBeNull();
    const undeniable = approval();
    (undeniable as { payload: { availableDecisions: string[] } }).payload.availableDecisions = ["allow_once"];
    expect(planApprovalOf(undeniable)).toBeNull();
    expect(planApprovalOf({ id: "x", status: "pending", payload: { kind: "user_question" } } as never)).toBeNull();
  });
});

describe("isCommitPlan", () => {
  it("matches the sentinel on a line of its own, anywhere in the plan", () => {
    expect(isCommitPlan("# Plan\n\n## Commit Plan\n<!-- devkit:commit-plan -->\n- a")).toBe(true);
    expect(isCommitPlan("  <!--devkit:commit-plan-->  \r\nrest")).toBe(true);
    expect(isCommitPlan("<!-- k0d3:commit-plan -->")).toBe(true);
  });

  it("ignores an in-prose mention or a near miss", () => {
    expect(isCommitPlan("see <!-- devkit:commit-plan --> above")).toBe(false);
    expect(isCommitPlan("<!-- devkit:commit-planner -->")).toBe(false);
  });
});

describe("planGateAction", () => {
  it("reviews the first presentation and releases the next", () => {
    expect(planGateAction({ phase: "idle" }, "# Plan")).toBe("review");
    expect(planGateAction({ phase: "idle", planReviewArmedAt: 1 }, "# Plan")).toBe("release");
  });

  it("holds a re-presentation while the review is still queued", () => {
    expect(
      planGateAction({ phase: "idle", planReviewArmedAt: 1, planReviewEntryId: "qm" }, "# Plan"),
    ).toBe("hold");
  });

  it("passes a commit plan without touching the gate", () => {
    expect(planGateAction({ phase: "idle" }, "<!-- devkit:commit-plan -->")).toBe("commit-plan");
  });
});
