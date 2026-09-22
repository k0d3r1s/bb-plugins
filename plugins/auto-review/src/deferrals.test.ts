import { describe, expect, it } from "vitest";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  addDeferral,
  readDeferrals,
  removeDeferral,
  type Deferral,
} from "./deferrals.js";

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

const entry: Deferral = {
  threadId: "thread-1",
  projectId: "project-1",
  environmentId: "env-1",
};

describe("deferrals", () => {
  it("round-trips an entry", async () => {
    const { bb } = fakeBb();
    await addDeferral(bb, entry);
    expect(await readDeferrals(bb)).toEqual([entry]);
  });

  it("keys per thread so concurrent parks do not overwrite each other", async () => {
    const { bb } = fakeBb();
    const other: Deferral = { ...entry, threadId: "thread-2" };
    await Promise.all([addDeferral(bb, entry), addDeferral(bb, other)]);
    const rows = await readDeferrals(bb);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.threadId).sort()).toEqual([
      "thread-1",
      "thread-2",
    ]);
  });

  it("re-adding the same thread does not duplicate it", async () => {
    const { bb } = fakeBb();
    await addDeferral(bb, entry);
    await addDeferral(bb, { ...entry, environmentId: "env-2" });
    const rows = await readDeferrals(bb);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.environmentId).toBe("env-2");
  });

  it("removes only the named thread", async () => {
    const { bb } = fakeBb();
    await addDeferral(bb, entry);
    await addDeferral(bb, { ...entry, threadId: "thread-2" });
    await removeDeferral(bb, "thread-1");
    expect((await readDeferrals(bb)).map((row) => row.threadId)).toEqual([
      "thread-2",
    ]);
  });

  it("removing an absent thread is a no-op", async () => {
    const { bb } = fakeBb();
    await addDeferral(bb, entry);
    await removeDeferral(bb, "nobody");
    expect(await readDeferrals(bb)).toEqual([entry]);
  });

  it("drops an unparseable row instead of returning it", async () => {
    const { bb, store } = fakeBb({
      "deferral:thread-9": { threadId: "thread-9" },
    });
    await addDeferral(bb, entry);
    expect(await readDeferrals(bb)).toEqual([entry]);
    expect(store.has("deferral:thread-9")).toBe(false);
  });

  it("ignores keys outside its own prefix", async () => {
    const { bb, store } = fakeBb({ "project:project-1": { enabled: true } });
    await addDeferral(bb, entry);
    expect(await readDeferrals(bb)).toEqual([entry]);
    expect(store.has("project:project-1")).toBe(true);
  });
});
