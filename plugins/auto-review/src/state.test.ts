import { describe, expect, it } from "vitest";
import {
  isStale,
  resetToIdlePatch,
  STALE_WINDOW_MS,
  threadStateSchema,
  withThreadLock,
} from "./state.js";

describe("threadStateSchema", () => {
  it("defaults phase to idle for an empty namespace", () => {
    const parsed = threadStateSchema.parse({});
    expect(parsed.phase).toBe("idle");
  });

  it("preserves a skip flag with a defaulted phase", () => {
    const parsed = threadStateSchema.parse({ skip: true });
    expect(parsed).toEqual({ phase: "idle", skip: true });
  });

  it("round-trips a full latched state", () => {
    const state = {
      phase: "pending-dispatch" as const,
      turnStart: { sinceSeq: 12 },
      pendingEntryId: "qm_1",
      dispatchedAt: 1000,
    };
    expect(threadStateSchema.parse(state)).toEqual(state);
  });
});

describe("isStale", () => {
  it("is never stale while idle", () => {
    expect(isStale({ phase: "idle", dispatchedAt: 0 }, STALE_WINDOW_MS * 10)).toBe(
      false,
    );
  });

  it("is not stale within the window", () => {
    expect(
      isStale({ phase: "awaiting-review", dispatchedAt: 1000 }, 1000 + 5),
    ).toBe(false);
  });

  it("is stale past the window", () => {
    expect(
      isStale(
        { phase: "awaiting-review", dispatchedAt: 1000 },
        1000 + STALE_WINDOW_MS + 1,
      ),
    ).toBe(true);
  });

  it("is not stale without a dispatch timestamp", () => {
    expect(isStale({ phase: "pending-dispatch" }, STALE_WINDOW_MS * 10)).toBe(
      false,
    );
  });
});

describe("resetToIdlePatch", () => {
  it("sets idle and removes latch keys", () => {
    const patch = resetToIdlePatch();
    expect(patch.set).toEqual({ phase: "idle" });
    expect(patch.remove).toEqual(["turnStart", "pendingEntryId", "dispatchedAt"]);
  });
});

describe("withThreadLock", () => {
  it("serializes runs for the same thread", async () => {
    const order: number[] = [];
    const first = withThreadLock("thread-a", async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push(1);
    });
    const second = withThreadLock("thread-a", async () => {
      order.push(2);
    });
    await Promise.all([first, second]);
    expect(order).toEqual([1, 2]);
  });

  it("does not let a rejection break the chain", async () => {
    const failing = withThreadLock("thread-b", async () => {
      throw new Error("boom");
    });
    await expect(failing).rejects.toThrow("boom");
    const value = await withThreadLock("thread-b", async () => 42);
    expect(value).toBe(42);
  });
});
