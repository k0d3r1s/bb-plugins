import { describe, expect, it } from "vitest";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { addReview, readReviews, removeReview, type ReviewEntry } from "./reviews.js";

function fakeBb(seed: Record<string, unknown> = {}) {
  const store = new Map<string, unknown>(Object.entries(seed));
  const bb = {
    storage: {
      kv: {
        get: async <T>(key: string) => store.get(key) as T | undefined,
        set: async (key: string, value: unknown) => {
          store.set(key, value);
        },
        delete: async (key: string) => {
          store.delete(key);
        },
        list: async (prefix?: string) =>
          [...store.keys()].filter((key) =>
            prefix === undefined ? true : key.startsWith(prefix),
          ),
      },
    },
  } as unknown as BbPluginApi;
  return { bb, store };
}

const entry: ReviewEntry = { threadId: "thread-1", providerId: "claude-code" };

describe("reviews", () => {
  it("round-trips entries keyed per thread", async () => {
    const { bb, store } = fakeBb();
    await addReview(bb, entry);
    await addReview(bb, { threadId: "thread-2", providerId: "codex" });
    expect(await readReviews(bb)).toEqual([
      entry,
      { threadId: "thread-2", providerId: "codex" },
    ]);
    expect([...store.keys()]).toEqual(["review:thread-1", "review:thread-2"]);
  });

  it("overwrites a thread's entry rather than duplicating it", async () => {
    const { bb } = fakeBb();
    await addReview(bb, entry);
    await addReview(bb, { ...entry, providerId: "codex" });
    expect(await readReviews(bb)).toEqual([{ ...entry, providerId: "codex" }]);
  });

  it("removes only the named thread, and an absent one is a no-op", async () => {
    const { bb } = fakeBb();
    await addReview(bb, entry);
    await addReview(bb, { threadId: "thread-2", providerId: "codex" });
    await removeReview(bb, "thread-1");
    await removeReview(bb, "nobody");
    expect((await readReviews(bb)).map((row) => row.threadId)).toEqual(["thread-2"]);
  });

  it("prunes an unparseable entry instead of returning it", async () => {
    const { bb, store } = fakeBb({
      "review:broken": { threadId: "broken" },
      "review:null": null,
    });
    await addReview(bb, entry);
    expect(await readReviews(bb)).toEqual([entry]);
    expect(store.has("review:broken")).toBe(false);
    expect(store.has("review:null")).toBe(false);
  });

  it("ignores keys outside its own prefix", async () => {
    const { bb, store } = fakeBb({ "deferral:thread-1": { threadId: "thread-1" } });
    expect(await readReviews(bb)).toEqual([]);
    expect(store.has("deferral:thread-1")).toBe(true);
  });
});
