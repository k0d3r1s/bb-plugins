import { describe, expect, it } from "vitest";
import {
  hasBusyCodingSibling,
  hasReviewInFlight,
  passesThreadGate,
  pickDeferredRelease,
  reviewInFlight,
  selfIsWorktree,
  type SiblingReview,
} from "./gate.js";
import { STALE_WINDOW_MS, type AutoReviewPhase } from "./state.js";

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

type Entries = Parameters<typeof selfIsWorktree>[0];

function entries(
  rows: Array<{ id: string; status: string; environmentIsWorktree?: boolean }>,
): Entries {
  return rows as unknown as Entries;
}

const NOW = STALE_WINDOW_MS * 10;

function sibling(
  id: string,
  phase: AutoReviewPhase,
  options: { busy?: boolean; dispatchedAt?: number } = {},
): SiblingReview {
  return {
    id,
    busy: options.busy ?? false,
    state: {
      phase,
      ...(options.dispatchedAt === undefined
        ? {}
        : { dispatchedAt: options.dispatchedAt }),
    },
  };
}

describe("reviewInFlight", () => {
  it("ignores a busy thread that has no review of its own", () => {
    expect(reviewInFlight(sibling("advisor", "idle", { busy: true }), NOW)).toBe(
      false,
    );
  });

  it("ignores a deferred sibling, busy or not", () => {
    expect(
      reviewInFlight(sibling("other", "deferred", { busy: true }), NOW),
    ).toBe(false);
  });

  it("counts a running review", () => {
    expect(
      reviewInFlight(
        sibling("other", "awaiting-review", { busy: true, dispatchedAt: NOW }),
        NOW,
      ),
    ).toBe(true);
  });

  it("counts a review dispatched before its thread reads as busy", () => {
    expect(
      reviewInFlight(
        sibling("other", "awaiting-review", { dispatchedAt: NOW - 1_000 }),
        NOW,
      ),
    ).toBe(true);
  });

  it("counts a queued review", () => {
    expect(
      reviewInFlight(
        sibling("other", "pending-dispatch", { dispatchedAt: NOW - 1_000 }),
        NOW,
      ),
    ).toBe(true);
  });

  it("keeps counting a long review while its thread is still busy", () => {
    expect(
      reviewInFlight(
        sibling("other", "awaiting-review", {
          busy: true,
          dispatchedAt: NOW - STALE_WINDOW_MS - 1,
        }),
        NOW,
      ),
    ).toBe(true);
  });

  it("ignores an undated latch on a thread that is not busy", () => {
    expect(reviewInFlight(sibling("other", "awaiting-review"), NOW)).toBe(false);
  });

  it("ignores a stale latch on a thread that is no longer busy", () => {
    expect(
      reviewInFlight(
        sibling("other", "awaiting-review", {
          dispatchedAt: NOW - STALE_WINDOW_MS - 1,
        }),
        NOW,
      ),
    ).toBe(false);
  });
});

describe("hasBusyCodingSibling", () => {
  const row = (
    id: string,
    status: string,
    extra: Record<string, unknown> = {},
  ) => ({
    id,
    status,
    parentThreadId: null,
    originPluginId: null,
    visibility: "visible",
    environmentId: "env_1",
    ...extra,
  });

  it("counts a running visible top-level sibling", () => {
    expect(
      hasBusyCodingSibling(
        entries([row("self", "idle"), row("other", "active")] as never),
        "self",
      ),
    ).toBe(true);
  });

  it("ignores the thread itself, idle siblings, and advisor or child threads", () => {
    expect(
      hasBusyCodingSibling(
        entries([
          row("self", "active"),
          row("idle", "idle"),
          row("advisor", "active", {
            visibility: "hidden",
            originPluginId: "advisor",
          }),
          row("child", "active", { parentThreadId: "self" }),
        ] as never),
        "self",
      ),
    ).toBe(false);
  });
});

describe("hasReviewInFlight", () => {
  it("is false for a checkout full of running threads with no review", () => {
    expect(
      hasReviewInFlight(
        [
          sibling("a", "idle", { busy: true }),
          sibling("b", "idle", { busy: true }),
        ],
        NOW,
      ),
    ).toBe(false);
  });

  it("is true when any sibling review is in flight", () => {
    expect(
      hasReviewInFlight(
        [
          sibling("a", "idle", { busy: true }),
          sibling("b", "awaiting-review", { busy: true, dispatchedAt: NOW }),
        ],
        NOW,
      ),
    ).toBe(true);
  });
});

describe("pickDeferredRelease", () => {
  it("picks nothing when no sibling is deferred", () => {
    expect(pickDeferredRelease([sibling("a", "idle")], NOW)).toBeNull();
    expect(pickDeferredRelease([], NOW)).toBeNull();
  });

  it("picks the first deferred sibling", () => {
    expect(
      pickDeferredRelease(
        [sibling("a", "idle"), sibling("b", "deferred"), sibling("c", "deferred")],
        NOW,
      ),
    ).toBe("b");
  });

  it("releases even while other threads are running", () => {
    expect(
      pickDeferredRelease(
        [sibling("a", "deferred"), sibling("b", "idle", { busy: true })],
        NOW,
      ),
    ).toBe("a");
  });

  it("releases nobody while a sibling review is queued or in flight", () => {
    expect(
      pickDeferredRelease(
        [
          sibling("a", "deferred"),
          sibling("b", "awaiting-review", { dispatchedAt: NOW }),
        ],
        NOW,
      ),
    ).toBeNull();
    expect(
      pickDeferredRelease(
        [
          sibling("a", "deferred"),
          sibling("b", "pending-dispatch", { dispatchedAt: NOW }),
        ],
        NOW,
      ),
    ).toBeNull();
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
