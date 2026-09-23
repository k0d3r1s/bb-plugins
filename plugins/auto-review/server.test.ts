import { describe, expect, it } from "vitest";
import {
  createFakePluginHost,
  makeQueueEntry,
  makeThreadResponse,
  type CreateFakePluginHostOptions,
} from "@get-bb/plugin-sdk/testing";
import plugin from "./server.js";
import { STALE_WINDOW_MS } from "./src/state.js";

const THREAD_ID = "thread-1";
const SIBLING_ID = "thread-2";
const ENV_ID = "env-1";
const PLUGIN_ID = "auto-review";

/** Threads named `codex-…` run on Codex; every other thread runs on Claude Code. */
function providerOf(threadId: string): string {
  return threadId.startsWith("codex-") ? "codex" : "claude-code";
}

interface EnvThread {
  id: string;
  status: string;
  visibility?: string;
  originPluginId?: string | null;
}

interface HostOptions {
  sendDelivery?: "sent" | "queued";
  sendThrows?: boolean;
  authoredRows?: unknown[];
  workingTreeFiles?: Array<{ path: string }>;
  worktree?: boolean;
  /** Latch a same-provider review between the first check and the lock. */
  reviewLandsBeforeLock?: boolean;
  queuedRows?: Array<{ id: string }>;
  envThreads?: EnvThread[];
  authoringThreads?: string[];
  getThrowsFor?: string[];
  resolveThrows?: boolean;
}

function fileChangeRow(path: string, sourceSeqStart = 150): unknown {
  return {
    id: `row-${path}`,
    kind: "work",
    workKind: "file-change",
    turnId: "turn-1",
    sourceSeqStart,
    sourceSeqEnd: sourceSeqStart,
    change: { path, movePath: null },
  };
}

function createHost(options: HostOptions = {}) {
  const metadataByThread = new Map<string, Record<string, unknown>>();
  const bucket = (threadId: string): Record<string, unknown> => {
    const existing = metadataByThread.get(threadId);
    if (existing !== undefined) {
      return existing;
    }
    const created: Record<string, unknown> = {};
    metadataByThread.set(threadId, created);
    return created;
  };
  const metadata = bucket(THREAD_ID);
  const sends: Array<{ threadId: string; mode: string; input: unknown }> = [];
  const resolutions: Array<{ interactionId: string; resolution: unknown }> = [];
  const deletedQueued: string[] = [];
  const timelineLimits: Array<string | undefined> = [];
  let hostRef: { bb: { storage: { kv: KvLike } } } | null = null;
  const authoredRows = options.authoredRows ?? [fileChangeRow("src/a.ts")];
  const workingTreeFiles = options.workingTreeFiles ?? [{ path: "src/a.ts" }];
  const worktree = options.worktree ?? true;
  const authoring = options.authoringThreads ?? [THREAD_ID];
  let envThreads: EnvThread[] = options.envThreads ?? [
    { id: THREAD_ID, status: "idle" },
  ];
  let maxSeq = 100;
  let queuedRows = options.queuedRows ?? [];

  const sdk: CreateFakePluginHostOptions["sdk"] = {
    threads: {
      getPluginMetadata: async (args: { threadId: string }) => ({
        ...bucket(args.threadId),
      }),
      updatePluginMetadata: async (args: {
        threadId: string;
        set?: Record<string, unknown>;
        remove?: string[];
      }) => {
        const target = bucket(args.threadId);
        if (args.set) {
          Object.assign(target, args.set);
        }
        for (const key of args.remove ?? []) {
          delete target[key];
        }
        return { ...target };
      },
      get: async (args: { threadId: string }) => {
        if (options.getThrowsFor?.includes(args.threadId) === true) {
          throw new Error(`thread ${args.threadId} is gone`);
        }
        const listed = envThreads.find((entry) => entry.id === args.threadId);
        return {
          ...makeThreadResponse({
            id: args.threadId,
            environmentId: ENV_ID,
            providerId: providerOf(args.threadId),
          }),
          status: listed?.status ?? "idle",
          projectId: "project-1",
        };
      },
      // Only the authoring threads changed anything; a sibling that changed
      // nothing stands down on no-authorship rather than firing its own review.
      timeline: async (args: { threadId: string; segmentLimit?: string }) => {
        timelineLimits.push(args.segmentLimit);
        if (options.reviewLandsBeforeLock === true && hostRef !== null) {
          options.reviewLandsBeforeLock = false;
          await latchReview(hostRef.bb.storage.kv, metadataOf("rival"), "rival");
        }
        return {
          rows: authoring.includes(args.threadId) ? authoredRows : [],
          maxSeq,
          timelinePage: {
            hasOlderRows: false,
            olderCursor: null,
            olderRowsSourceSeqEnd: null,
          },
        };
      },
      list: async () => {
        return [
          ...envThreads.map((entry) => ({
            parentThreadId: null,
            originPluginId: null,
            visibility: "visible",
            environmentId: ENV_ID,
            ...entry,
            environmentIsWorktree: worktree,
          })),
        ];
      },
      send: async (args: { threadId: string; mode: string; input: unknown }) => {
        if (options.sendThrows === true) {
          throw new Error("send failed");
        }
        sends.push(args);
        return options.sendDelivery === "queued"
          ? { ok: true, delivery: "queued", queuedMessage: { id: "qm-1" } }
          : { ok: true, delivery: "sent" };
      },
      queuedMessages: {
        list: async () => queuedRows,
        delete: async (args: { queuedMessageId: string }) => {
          deletedQueued.push(args.queuedMessageId);
          return {};
        },
      },
      interactions: {
        resolve: async (args: { interactionId: string; resolution: unknown }) => {
          if (options.resolveThrows === true) {
            throw new Error("interaction already settled");
          }
          resolutions.push(args);
          return {};
        },
      },
    },
    environments: {
      status: async () => ({
        outcome: "available",
        workspace: {
          workingTree: { files: workingTreeFiles },
          branch: { currentBranch: "bb/feature", defaultBranch: "master" },
          checkout: { kind: "branch" },
          mergeBase: {
            files: [],
            mergeBaseBranch: "master",
            baseRef: "abc123",
          },
        },
      }),
    },
  };

  function metadataOf(threadId: string) {
    return bucket(threadId);
  }
  const fake = createFakePluginHost({ pluginId: PLUGIN_ID, sdk });
  hostRef = fake as unknown as { bb: { storage: { kv: KvLike } } };
  return {
    ...fake,
    metadata,
    metadataFor: bucket,
    sends,
    resolutions,
    deletedQueued,
    timelineLimits,
    setEnvThreads: (next: EnvThread[]) => {
      envThreads = next;
    },
    setMaxSeq: (next: number) => {
      maxSeq = next;
    },
    setQueuedRows: (next: Array<{ id: string }>) => {
      queuedRows = next;
    },
  };
}

function thread(id: string = THREAD_ID) {
  return makeThreadResponse({ id, environmentId: ENV_ID, providerId: providerOf(id) });
}

interface KvLike {
  set: (key: string, value: unknown) => Promise<void>;
  get: <T>(key: string) => Promise<T | null | undefined>;
  list: (prefix: string) => Promise<string[]>;
}

async function latchReview(
  kv: KvLike,
  state: Record<string, unknown>,
  threadId: string,
  dispatchedAt = Date.now(),
) {
  Object.assign(state, { phase: "awaiting-review", dispatchedAt });
  await kv.set(`review:${threadId}`, { threadId, providerId: providerOf(threadId) });
}

type Host = ReturnType<typeof createHost>;

function emitActive(host: Host, id: string = THREAD_ID) {
  return host.harness.behavior.emitThreadEvent("thread.active", {
    thread: thread(id),
  });
}

function emitIdle(host: Host, id: string = THREAD_ID) {
  return host.harness.behavior.emitThreadEvent("thread.idle", {
    thread: thread(id),
    lastAssistantText: null,
  });
}

function promptText(host: Host, index = 0): string {
  const input = host.sends[index]?.input as Array<{ text: string }> | undefined;
  return input?.[0]?.text ?? "";
}

function planInteraction(
  plan = "# Plan\n\nDo the thing.",
  id = "pint-1",
  planFilePath: string | null = "/home/u/.claude/plans/p.md",
) {
  return {
    id,
    threadId: THREAD_ID,
    turnId: "turn-1",
    status: "pending",
    statusReason: null,
    createdAt: 1,
    resolvedAt: null,
    resolution: null,
    providerId: "claude-code",
    providerRequestId: "req-1",
    providerThreadId: "pt-1",
    payload: {
      kind: "approval",
      availableDecisions: ["allow_once", "deny"],
      reason: null,
      subject: { kind: "plan", itemId: "item-1", plan, planFilePath },
    },
  };
}

function emitPlan(host: Host, interaction = planInteraction()) {
  return host.harness.behavior.emitThreadEvent("interaction.pending", {
    thread: thread(),
    interaction,
  } as never);
}

/** Latch and index a review on `id`, as auto-review does when it sends one. */
function startReview(host: Host, id: string, dispatchedAt = Date.now()) {
  return latchReview(host.bb.storage.kv, host.metadataFor(id), id, dispatchedAt);
}

/** Park `id` the way a deferral does, index entry included. */
async function park(host: Host, id: string, providerId: string | null = providerOf(id)) {
  Object.assign(host.metadataFor(id), {
    phase: "deferred",
    deferredSince: Date.now(),
    turnStart: { sinceSeq: 0 },
  });
  await host.bb.storage.kv.set(`deferral:${id}`, {
    threadId: id,
    projectId: "project-1",
    environmentId: ENV_ID,
    ...(providerId === null ? {} : { providerId }),
  });
}

function endReview(host: Host, id: string) {
  const state = host.metadataFor(id);
  state.phase = "idle";
  delete state.dispatchedAt;
}

function queueEntry() {
  return makeQueueEntry({ id: "qm-1", threadId: THREAD_ID });
}

describe("auto-review plugin", () => {
  it("records the turn-start cursor on thread.active", async () => {
    const host = createHost();
    await plugin(host.bb);
    const { errors } = await emitActive(host);
    expect(errors).toEqual([]);
    expect(host.metadata.turnStart).toEqual({ sinceSeq: 100 });
    await host.harness.dispose();
  });

  it("fires a review on an authored turn and does not chain on its own review", async () => {
    const host = createHost();
    await plugin(host.bb);

    await emitActive(host);
    const idle = await emitIdle(host);
    expect(idle.errors).toEqual([]);
    expect(host.sends).toHaveLength(1);
    expect(host.sends[0]?.mode).toBe("auto");
    expect(host.metadata.phase).toBe("awaiting-review");

    const secondIdle = await emitIdle(host);
    expect(secondIdle.errors).toEqual([]);
    expect(host.sends).toHaveLength(1);
    expect(host.metadata.phase).toBe("idle");
    await host.harness.dispose();
  });

  it("never asks the timeline for more segments than it serves", async () => {
    const host = createHost();
    await plugin(host.bb);
    await emitActive(host);
    await emitIdle(host);
    const limits = host.timelineLimits.filter((limit) => limit !== undefined);
    expect(limits.length).toBeGreaterThan(0);
    for (const limit of limits) {
      expect(Number(limit)).toBeLessThanOrEqual(100);
    }
    await host.harness.dispose();
  });

  it("stands down when the agent authored nothing this turn", async () => {
    const host = createHost({ authoredRows: [] });
    await plugin(host.bb);
    await emitActive(host);
    await emitIdle(host);
    expect(host.sends).toHaveLength(0);
    await host.harness.dispose();
  });

  it("stands down when the authored path is no longer changed", async () => {
    const host = createHost({ workingTreeFiles: [{ path: "unrelated.ts" }] });
    await plugin(host.bb);
    await emitActive(host);
    await emitIdle(host);
    expect(host.sends).toHaveLength(0);
    await host.harness.dispose();
  });

  it("correlates a queued injection through message.dispatched", async () => {
    const host = createHost({ sendDelivery: "queued" });
    await plugin(host.bb);

    await emitActive(host);
    await emitIdle(host);
    expect(host.sends).toHaveLength(1);
    expect(host.metadata.phase).toBe("pending-dispatch");
    expect(host.metadata.pendingEntryId).toBe("qm-1");

    await host.harness.behavior.emitThreadEvent("message.dispatched", {
      entry: queueEntry(),
    });
    expect(host.metadata.phase).toBe("awaiting-review");

    await emitIdle(host);
    expect(host.metadata.phase).toBe("idle");
    expect(host.sends).toHaveLength(1);
    await host.harness.dispose();
  });

  it("unlatches a queued injection that is cancelled", async () => {
    const host = createHost({ sendDelivery: "queued" });
    await plugin(host.bb);
    await emitActive(host);
    await emitIdle(host);
    expect(host.metadata.phase).toBe("pending-dispatch");

    await host.harness.behavior.emitThreadEvent("message.cancelled", {
      entry: queueEntry(),
    });
    expect(host.metadata.phase).toBe("idle");
    await host.harness.dispose();
  });

  it("skips a thread when the per-thread skip flag is set", async () => {
    const host = createHost();
    await plugin(host.bb);
    await host.harness.runCli(["skip", THREAD_ID]);
    await emitActive(host);
    await emitIdle(host);
    expect(host.sends).toHaveLength(0);
    await host.harness.dispose();
  });

  it("resets the latch to idle when the injected send throws", async () => {
    const host = createHost({ sendThrows: true });
    await plugin(host.bb);
    await emitActive(host);
    const idle = await emitIdle(host);
    expect(idle.errors).toEqual([]);
    expect(host.sends).toHaveLength(0);
    expect(host.metadata.phase).toBe("idle");
    await host.harness.dispose();
  });

  it("fires the full review, merge included, while other threads run in the checkout", async () => {
    const host = createHost({
      envThreads: [
        { id: THREAD_ID, status: "idle" },
        { id: "advisor", status: "active", visibility: "hidden", originPluginId: "advisor" },
        { id: SIBLING_ID, status: "active" },
      ],
    });
    await plugin(host.bb);
    await emitActive(host);
    await emitIdle(host);
    expect(host.sends).toHaveLength(1);
    expect(host.metadata.phase).toBe("awaiting-review");
    expect(promptText(host)).toMatch(/Merge the current branch/);
    expect(await host.bb.storage.kv.list("review:")).toEqual([`review:${THREAD_ID}`]);
    const status = await host.harness.runCli(["status", THREAD_ID, "--json"]);
    expect(JSON.parse(status.stdout).lastFire).toMatchObject({
      outcome: "fired",
      reason: "fired",
      merge: true,
    });
    await host.harness.dispose();
  });

  it("defers behind a review on the same provider in another project", async () => {
    const host = createHost();
    await plugin(host.bb);
    await startReview(host, "elsewhere");
    await emitActive(host);
    await emitIdle(host);
    expect(host.sends).toHaveLength(0);
    expect(host.metadata.phase).toBe("deferred");
    expect(typeof host.metadata.deferredSince).toBe("number");
    expect(host.metadata.turnStart).toEqual({ sinceSeq: 100 });
    const status = await host.harness.runCli(["status", THREAD_ID, "--json"]);
    expect(JSON.parse(status.stdout).lastFire).toMatchObject({
      outcome: "deferred",
      reason: "sibling-active",
    });
    await host.harness.dispose();
  });

  it("does not defer behind a review on a different provider", async () => {
    const host = createHost();
    await plugin(host.bb);
    await startReview(host, "codex-thread");
    await emitActive(host);
    await emitIdle(host);
    expect(host.sends).toHaveLength(1);
    expect(host.metadata.phase).toBe("awaiting-review");
    await host.harness.dispose();
  });

  it("defers rather than dropping when a same-provider review lands before the firing lock", async () => {
    const host = createHost({ reviewLandsBeforeLock: true });
    await plugin(host.bb);
    await emitActive(host);
    await emitIdle(host);
    expect(host.sends).toHaveLength(0);
    expect(host.metadata.phase).toBe("deferred");
    expect(host.metadata.turnStart).toEqual({ sinceSeq: 100 });
    await host.harness.dispose();
  });

  it("keeps a deferred turn's cursor when the thread takes another turn", async () => {
    const host = createHost();
    await plugin(host.bb);
    await startReview(host, SIBLING_ID);
    await emitActive(host);
    await emitIdle(host);
    expect(host.metadata.phase).toBe("deferred");

    host.setMaxSeq(400);
    await emitActive(host);
    expect(host.metadata.turnStart).toEqual({ sinceSeq: 100 });
    await host.harness.dispose();
  });

  it("fires the deferred review when the blocking review ends", async () => {
    const host = createHost();
    await plugin(host.bb);
    await startReview(host, "elsewhere");
    await emitActive(host);
    await emitIdle(host);
    expect(host.metadata.phase).toBe("deferred");

    const released = await emitIdle(host, "elsewhere");
    expect(released.errors).toEqual([]);
    expect(host.metadataFor("elsewhere").phase).toBe("idle");
    expect(host.sends).toHaveLength(1);
    expect(host.sends[0]?.threadId).toBe(THREAD_ID);
    expect(host.metadata.phase).toBe("awaiting-review");
    expect(host.metadata.deferredSince).toBeUndefined();
    expect(await host.bb.storage.kv.list("review:")).toEqual([`review:${THREAD_ID}`]);
    expect(await host.bb.storage.kv.list("deferral:")).toEqual([]);
    await host.harness.dispose();
  });

  it("keeps releasing past a parked turn that starts no review", async () => {
    // thread-1 has nothing left to review; thread-2, parked behind it, does.
    const host = createHost({ authoringThreads: [SIBLING_ID] });
    await plugin(host.bb);
    await park(host, THREAD_ID);
    await park(host, SIBLING_ID);

    await emitIdle(host, "thread-3");
    expect(host.metadataFor(THREAD_ID).phase).toBe("idle");
    expect(host.sends.map((send) => send.threadId)).toEqual([SIBLING_ID]);
    expect(host.metadataFor(SIBLING_ID).phase).toBe("awaiting-review");
    await host.harness.dispose();
  });

  it("does not release a parked turn when a review on another provider ends", async () => {
    const host = createHost();
    await plugin(host.bb);
    await startReview(host, SIBLING_ID);
    await startReview(host, "codex-thread");
    await emitActive(host);
    await emitIdle(host);
    expect(host.metadata.phase).toBe("deferred");

    await emitIdle(host, "codex-thread");
    expect(host.sends).toHaveLength(0);
    expect(host.metadata.phase).toBe("deferred");
    await host.harness.dispose();
  });

  it("releases a deferred turn when the blocking thread fails mid-review", async () => {
    const host = createHost();
    await plugin(host.bb);
    await startReview(host, SIBLING_ID);
    await emitActive(host);
    await emitIdle(host);
    expect(host.metadata.phase).toBe("deferred");

    const failed = await host.harness.behavior.emitThreadEvent("thread.failed", {
      thread: thread(SIBLING_ID),
    } as never);
    expect(failed.errors).toEqual([]);
    expect(host.metadataFor(SIBLING_ID).phase).toBe("idle");
    expect(host.sends).toHaveLength(1);
    expect(host.sends[0]?.threadId).toBe(THREAD_ID);
    await host.harness.dispose();
  });

  it("does not release a parked turn while another same-provider review is in flight", async () => {
    const host = createHost();
    await plugin(host.bb);
    await park(host, THREAD_ID);
    await startReview(host, SIBLING_ID);

    await emitIdle(host, "thread-3");
    expect(host.sends).toHaveLength(0);
    expect(host.metadataFor(THREAD_ID).phase).toBe("deferred");
    await host.harness.dispose();
  });

  it("unparks a deferred turn that turns out to have nothing to review", async () => {
    const host = createHost({ authoredRows: [] });
    await plugin(host.bb);
    await park(host, THREAD_ID);

    await emitIdle(host);
    expect(host.sends).toHaveLength(0);
    expect(host.metadata.phase).toBe("idle");
    expect(host.metadata.deferredSince).toBeUndefined();
    expect(await host.bb.storage.kv.list("deferral:")).toEqual([]);

    // The cursor is free to advance again now that nothing is owed.
    host.setMaxSeq(400);
    await emitActive(host);
    expect(host.metadata.turnStart).toEqual({ sinceSeq: 400 });
    await host.harness.dispose();
  });

  it("does not defer behind a stale review latch on a thread that went idle", async () => {
    const host = createHost();
    await plugin(host.bb);
    await startReview(host, SIBLING_ID, Date.now() - STALE_WINDOW_MS - 1_000);
    await emitActive(host);
    await emitIdle(host);
    expect(host.sends).toHaveLength(1);
    expect(host.metadata.phase).toBe("awaiting-review");
    await host.harness.dispose();
  });

  it("moves a stale pending-dispatch whose row is gone to awaiting-review", async () => {
    const host = createHost({ queuedRows: [] });
    await plugin(host.bb);
    host.metadata.phase = "pending-dispatch";
    host.metadata.pendingEntryId = "qm-1";
    host.metadata.dispatchedAt = Date.now() - 40 * 60 * 1_000;
    await emitIdle(host);
    expect(host.metadata.phase).toBe("awaiting-review");
    expect(host.sends).toHaveLength(0);
    await host.harness.dispose();
  });

  it("extends a stale pending-dispatch whose row is still queued", async () => {
    const host = createHost({ queuedRows: [{ id: "qm-1" }] });
    await plugin(host.bb);
    const oldDispatchedAt = Date.now() - 40 * 60 * 1_000;
    host.metadata.phase = "pending-dispatch";
    host.metadata.pendingEntryId = "qm-1";
    host.metadata.dispatchedAt = oldDispatchedAt;
    await emitIdle(host);
    expect(host.metadata.phase).toBe("pending-dispatch");
    expect(host.metadata.dispatchedAt as number).toBeGreaterThan(oldDispatchedAt);
    expect(host.sends).toHaveLength(0);
    await host.harness.dispose();
  });

  it("sweeps a parked turn whose blocking review ended without an event", async () => {
    const host = createHost();
    await plugin(host.bb);
    await startReview(host, SIBLING_ID);
    await emitActive(host);
    await emitIdle(host);
    expect(host.metadata.phase).toBe("deferred");

    await host.harness.runSchedule("sweep-deferrals");
    expect(host.sends).toHaveLength(0);

    // The sibling's review finished, but its idle never reached auto-review.
    endReview(host, SIBLING_ID);
    await host.harness.runSchedule("sweep-deferrals");
    expect(host.sends).toHaveLength(1);
    expect(host.sends[0]?.threadId).toBe(THREAD_ID);
    expect(host.metadata.phase).toBe("awaiting-review");
    expect(await host.bb.storage.kv.list("review:")).toEqual([`review:${THREAD_ID}`]);
    await host.harness.dispose();
  });

  it("injects only one review when two drivers race the same parked thread", async () => {
    const host = createHost();
    await plugin(host.bb);
    await park(host, THREAD_ID);
    // Both sweeps read the index and see the same parked thread before either
    // takes its lock; the loser must find the review already in flight.
    await Promise.all([
      host.harness.runSchedule("sweep-deferrals"),
      host.harness.runSchedule("sweep-deferrals"),
    ]);
    expect(host.sends).toHaveLength(1);
    expect(host.metadata.phase).toBe("awaiting-review");
    await host.harness.dispose();
  });

  it("releases one parked turn per provider per sweep", async () => {
    const host = createHost({
      authoringThreads: [THREAD_ID, SIBLING_ID, "codex-thread"],
    });
    await plugin(host.bb);
    await park(host, THREAD_ID);
    await park(host, SIBLING_ID);
    await park(host, "codex-thread");

    await host.harness.runSchedule("sweep-deferrals");
    expect(host.sends.map((send) => providerOf(send.threadId)).sort()).toEqual([
      "claude-code",
      "codex",
    ]);
    await host.harness.dispose();
  });

  it("does not sweep a parked thread while a same-provider review is in flight", async () => {
    const host = createHost();
    await plugin(host.bb);
    await park(host, THREAD_ID);
    await startReview(host, SIBLING_ID);

    await host.harness.runSchedule("sweep-deferrals");
    expect(host.sends).toHaveLength(0);
    expect(host.metadata.phase).toBe("deferred");
    await host.harness.dispose();
  });

  it("sweeps a turn parked before deferrals recorded their provider", async () => {
    const host = createHost();
    await plugin(host.bb);
    await park(host, THREAD_ID, null);
    await startReview(host, SIBLING_ID);

    await host.harness.runSchedule("sweep-deferrals");
    expect(host.sends).toHaveLength(0);

    endReview(host, SIBLING_ID);
    await host.harness.runSchedule("sweep-deferrals");
    expect(host.sends).toHaveLength(1);
    expect(host.sends[0]?.threadId).toBe(THREAD_ID);
    await host.harness.dispose();
  });

  it("unparks, not just de-indexes, a thread the sweep can no longer resolve", async () => {
    const host = createHost({ getThrowsFor: [THREAD_ID] });
    await plugin(host.bb);
    await park(host, THREAD_ID);
    await host.harness.runSchedule("sweep-deferrals");

    // Dropping the index entry alone would leave the thread latched in
    // `deferred` and invisible to every later sweep.
    expect(host.sends).toHaveLength(0);
    expect(host.metadata.phase).toBe("idle");
    expect(host.metadata.deferredSince).toBeUndefined();
    expect(await host.bb.storage.kv.list("deferral:")).toEqual([]);
    await host.harness.dispose();
  });

  it("drops a swept entry whose thread is no longer deferred", async () => {
    const host = createHost();
    await plugin(host.bb);
    await park(host, THREAD_ID);
    await host.harness.runCli(["reset", THREAD_ID]);
    await host.harness.runSchedule("sweep-deferrals");
    expect(host.sends).toHaveLength(0);
    expect(await host.bb.storage.kv.list("deferral:")).toEqual([]);
    await host.harness.dispose();
  });

  it("holds a plan's first presentation for review: queues the review, then denies", async () => {
    const host = createHost({ sendDelivery: "queued" });
    await plugin(host.bb);
    const { errors } = await emitPlan(host);
    expect(errors).toEqual([]);
    expect(host.sends).toHaveLength(1);
    expect(host.sends[0]?.mode).toBe("auto");
    const text = promptText(host);
    expect(text).toMatch(/Nobody rejected it/);
    expect(text).toContain("/home/u/.claude/plans/p.md");
    expect(text).toContain('devkit_load_skill({ slug: "review-code" })');
    expect(host.resolutions).toEqual([
      { threadId: THREAD_ID, interactionId: "pint-1", resolution: { decision: "deny" } },
    ]);
    expect(typeof host.metadata.planReviewArmedAt).toBe("number");
    await host.harness.dispose();
  });

  it("releases the reviewed plan to the user and re-arms for the next plan", async () => {
    const host = createHost({ sendDelivery: "queued" });
    await plugin(host.bb);
    await emitPlan(host);
    expect(host.metadata.planReviewEntryId).toBe("qm-1");
    await host.harness.behavior.emitThreadEvent("message.dispatched", {
      entry: queueEntry(),
    });
    expect(host.metadata.planReviewEntryId).toBeUndefined();
    expect(host.metadata.phase ?? "idle").toBe("idle");
    await emitPlan(host, planInteraction("# Plan v2", "pint-2"));
    expect(host.sends).toHaveLength(1);
    expect(host.resolutions).toHaveLength(1);
    expect(host.metadata.planReviewArmedAt).toBeUndefined();

    await emitPlan(host, planInteraction("# Another plan", "pint-3"));
    expect(host.sends).toHaveLength(2);
    expect(host.resolutions).toHaveLength(2);
    await host.harness.dispose();
  });

  it("denies again, without a second review, a plan re-presented before the review dispatched", async () => {
    const host = createHost({ sendDelivery: "queued", queuedRows: [{ id: "qm-1" }] });
    await plugin(host.bb);
    await emitPlan(host);
    await emitPlan(host, planInteraction("# Plan, unreviewed", "pint-2"));
    expect(host.sends).toHaveLength(1);
    expect(host.resolutions.map((r) => r.interactionId)).toEqual(["pint-1", "pint-2"]);
    expect(host.metadata.planReviewEntryId).toBe("qm-1");
    expect(typeof host.metadata.planReviewArmedAt).toBe("number");
    await host.harness.dispose();
  });

  it("releases the plan when its review left the queue without a dispatch event", async () => {
    const host = createHost({ sendDelivery: "queued", queuedRows: [{ id: "qm-1" }] });
    await plugin(host.bb);
    await emitPlan(host);
    expect(host.metadata.planReviewEntryId).toBe("qm-1");

    // Core dispatched the review, but message.dispatched never reached us.
    host.setQueuedRows([]);
    await emitPlan(host, planInteraction("# Plan v2", "pint-2"));
    expect(host.resolutions.map((r) => r.interactionId)).toEqual(["pint-1"]);
    expect(host.metadata.planReviewArmedAt).toBeUndefined();
    expect(host.metadata.planReviewEntryId).toBeUndefined();

    // The gate is re-armed for the thread's next plan, not stuck denying.
    await emitPlan(host, planInteraction("# Next plan", "pint-3"));
    expect(host.sends).toHaveLength(2);
    expect(host.resolutions.map((r) => r.interactionId)).toEqual(["pint-1", "pint-3"]);
    await host.harness.dispose();
  });

  it("withdraws a review still queued past the stale window and releases the plan", async () => {
    const host = createHost({ sendDelivery: "queued", queuedRows: [{ id: "qm-1" }] });
    await plugin(host.bb);
    await emitPlan(host);
    host.metadata.planReviewArmedAt = Date.now() - STALE_WINDOW_MS - 1_000;

    await emitPlan(host, planInteraction("# Plan v2", "pint-2"));
    expect(host.resolutions.map((r) => r.interactionId)).toEqual(["pint-1"]);
    expect(host.deletedQueued).toEqual(["qm-1"]);
    expect(host.metadata.planReviewArmedAt).toBeUndefined();
    expect(host.metadata.planReviewEntryId).toBeUndefined();
    const status = await host.harness.runCli(["status", THREAD_ID, "--json"]);
    expect(JSON.parse(status.stdout).lastFire).toMatchObject({
      outcome: "stood-down",
      reason: "plan-hold-expired",
    });
    await host.harness.dispose();
  });

  it("disarms when the queued plan review is cancelled", async () => {
    const host = createHost({ sendDelivery: "queued" });
    await plugin(host.bb);
    await emitPlan(host);
    await host.harness.behavior.emitThreadEvent("message.cancelled", {
      entry: queueEntry(),
    });
    expect(host.metadata.planReviewArmedAt).toBeUndefined();
    expect(host.metadata.planReviewEntryId).toBeUndefined();
    await emitPlan(host, planInteraction("# Plan", "pint-2"));
    expect(host.sends).toHaveLength(2);
    await host.harness.dispose();
  });

  it("keeps the plan gate armed through a code-review idle reset", async () => {
    const host = createHost({ sendDelivery: "queued" });
    await plugin(host.bb);
    await emitPlan(host);
    await emitIdle(host);
    expect(typeof host.metadata.planReviewArmedAt).toBe("number");
    await host.harness.dispose();
  });

  it("passes a commit plan straight through", async () => {
    const host = createHost({ sendDelivery: "queued" });
    await plugin(host.bb);
    await emitPlan(host, planInteraction("## Commit Plan\n<!-- devkit:commit-plan -->\n- a"));
    expect(host.sends).toHaveLength(0);
    expect(host.resolutions).toHaveLength(0);
    expect(host.metadata.planReviewArmedAt).toBeUndefined();
    await host.harness.dispose();
  });

  it("leaves the plan alone when auto-review is skipped for the thread", async () => {
    const host = createHost({ sendDelivery: "queued" });
    await plugin(host.bb);
    await host.harness.runCli(["skip", THREAD_ID]);
    await emitPlan(host);
    expect(host.sends).toHaveLength(0);
    expect(host.resolutions).toHaveLength(0);
    await host.harness.dispose();
  });

  it("ignores approvals that are not plans", async () => {
    const host = createHost({ sendDelivery: "queued" });
    await plugin(host.bb);
    const interaction = planInteraction();
    await emitPlan(host, {
      ...interaction,
      payload: {
        ...interaction.payload,
        subject: { kind: "file_change", itemId: "i", writeScope: null, sessionGrant: null },
      },
    } as never);
    expect(host.sends).toHaveLength(0);
    expect(host.resolutions).toHaveLength(0);
    await host.harness.dispose();
  });

  it("withdraws the queued review and disarms when the deny fails", async () => {
    const host = createHost({ sendDelivery: "queued", resolveThrows: true });
    await plugin(host.bb);
    const { errors } = await emitPlan(host);
    expect(errors).toEqual([]);
    expect(host.deletedQueued).toEqual(["qm-1"]);
    expect(host.metadata.planReviewArmedAt).toBeUndefined();
    expect(host.metadata.planReviewEntryId).toBeUndefined();
    await host.harness.dispose();
  });

  it("does not deny the plan when the review cannot be queued", async () => {
    const host = createHost({ sendThrows: true });
    await plugin(host.bb);
    const { errors } = await emitPlan(host);
    expect(errors).toEqual([]);
    expect(host.resolutions).toHaveLength(0);
    expect(host.metadata.planReviewArmedAt).toBeUndefined();
    await host.harness.dispose();
  });

  it("reports status for a thread named by argument", async () => {
    const host = createHost();
    await plugin(host.bb);
    const result = await host.harness.runCli(["status", THREAD_ID, "--json"]);
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout ?? "") as {
      threadId: string;
      enabled: boolean;
      phase: string;
    };
    expect(payload.threadId).toBe(THREAD_ID);
    expect(payload.enabled).toBe(true);
    expect(payload.phase).toBe("idle");
    await host.harness.dispose();
  });

  it("rejects enable with both --global and --project", async () => {
    const host = createHost();
    await plugin(host.bb);
    const result = await host.harness.runCli([
      "enable",
      "--global",
      "--project",
      "project-1",
    ]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("only one of");
    await host.harness.dispose();
  });

  it("reset reports whether a latch was actually cleared", async () => {
    const host = createHost();
    await plugin(host.bb);
    const idleReset = await host.harness.runCli(["reset", THREAD_ID]);
    expect(idleReset.stdout).toContain("already idle");

    host.metadata.phase = "awaiting-review";
    const latchedReset = await host.harness.runCli(["reset", THREAD_ID]);
    expect(latchedReset.stdout).toContain("cleared awaiting-review");
    await host.harness.dispose();
  });
});
