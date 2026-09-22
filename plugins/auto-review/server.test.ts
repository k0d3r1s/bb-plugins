import { describe, expect, it } from "vitest";
import {
  createFakePluginHost,
  makeQueueEntry,
  makeThreadResponse,
  type CreateFakePluginHostOptions,
} from "@get-bb/plugin-sdk/testing";
import plugin from "./server.js";
import { DEFER_WINDOW_MS } from "./src/state.js";

const THREAD_ID = "thread-1";
const SIBLING_ID = "thread-2";
const ENV_ID = "env-1";
const PLUGIN_ID = "auto-review";

interface EnvThread {
  id: string;
  status: string;
}

interface HostOptions {
  sendDelivery?: "sent" | "queued";
  sendThrows?: boolean;
  authoredRows?: unknown[];
  workingTreeFiles?: Array<{ path: string }>;
  worktree?: boolean;
  siblingActiveOnRecheck?: boolean;
  queuedRows?: Array<{ id: string }>;
  envThreads?: EnvThread[];
  authoringThreads?: string[];
  getThrowsFor?: string[];
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
  let listCalls = 0;
  const authoredRows = options.authoredRows ?? [fileChangeRow("src/a.ts")];
  const workingTreeFiles = options.workingTreeFiles ?? [{ path: "src/a.ts" }];
  const worktree = options.worktree ?? true;
  const authoring = options.authoringThreads ?? [THREAD_ID];
  let envThreads: EnvThread[] = options.envThreads ?? [
    { id: THREAD_ID, status: "idle" },
  ];
  let maxSeq = 100;

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
        return {
          ...makeThreadResponse({ id: args.threadId, environmentId: ENV_ID }),
          projectId: "project-1",
        };
      },
      // Only the authoring threads changed anything; a sibling that changed
      // nothing stands down on no-authorship rather than firing its own review.
      timeline: async (args: { threadId: string }) => ({
        rows: authoring.includes(args.threadId) ? authoredRows : [],
        maxSeq,
      }),
      list: async () => {
        listCalls += 1;
        const sibling =
          options.siblingActiveOnRecheck === true && listCalls >= 2
            ? [{ id: "sibling", status: "active", environmentIsWorktree: worktree }]
            : [];
        return [
          ...envThreads.map((entry) => ({
            ...entry,
            environmentIsWorktree: worktree,
          })),
          ...sibling,
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
      queuedMessages: { list: async () => options.queuedRows ?? [] },
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

  return {
    ...createFakePluginHost({ pluginId: PLUGIN_ID, sdk }),
    metadata,
    metadataFor: bucket,
    sends,
    setEnvThreads: (next: EnvThread[]) => {
      envThreads = next;
    },
    setMaxSeq: (next: number) => {
      maxSeq = next;
    },
  };
}

function thread(id: string = THREAD_ID) {
  return makeThreadResponse({ id, environmentId: ENV_ID });
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

  it("defers rather than dropping when a sibling becomes active before the firing lock", async () => {
    const host = createHost({ siblingActiveOnRecheck: true });
    await plugin(host.bb);
    await emitActive(host);
    await emitIdle(host);
    expect(host.sends).toHaveLength(0);
    expect(host.metadata.phase).toBe("deferred");
    expect(typeof host.metadata.deferredSince).toBe("number");
    expect(host.metadata.turnStart).toEqual({ sinceSeq: 100 });
    await host.harness.dispose();
  });

  it("defers rather than dropping when a sibling is already active", async () => {
    const host = createHost({
      envThreads: [
        { id: THREAD_ID, status: "idle" },
        { id: SIBLING_ID, status: "active" },
      ],
    });
    await plugin(host.bb);
    await emitActive(host);
    await emitIdle(host);
    expect(host.sends).toHaveLength(0);
    expect(host.metadata.phase).toBe("deferred");
    expect(host.metadata.turnStart).toEqual({ sinceSeq: 100 });
    await host.harness.dispose();
  });

  it("keeps a deferred turn's cursor when the thread takes another turn", async () => {
    const host = createHost({
      envThreads: [
        { id: THREAD_ID, status: "idle" },
        { id: SIBLING_ID, status: "active" },
      ],
    });
    await plugin(host.bb);
    await emitActive(host);
    await emitIdle(host);
    expect(host.metadata.phase).toBe("deferred");

    host.setMaxSeq(400);
    await emitActive(host);
    expect(host.metadata.turnStart).toEqual({ sinceSeq: 100 });
    await host.harness.dispose();
  });

  it("fires the deferred review once the checkout goes quiet", async () => {
    const host = createHost({
      envThreads: [
        { id: THREAD_ID, status: "idle" },
        { id: SIBLING_ID, status: "active" },
      ],
    });
    await plugin(host.bb);
    await emitActive(host);
    await emitIdle(host);
    expect(host.sends).toHaveLength(0);
    expect(host.metadata.phase).toBe("deferred");

    host.setEnvThreads([
      { id: THREAD_ID, status: "idle" },
      { id: SIBLING_ID, status: "idle" },
    ]);
    const released = await emitIdle(host, SIBLING_ID);
    expect(released.errors).toEqual([]);
    expect(host.sends).toHaveLength(1);
    expect(host.sends[0]?.threadId).toBe(THREAD_ID);
    expect(host.metadata.phase).toBe("awaiting-review");
    expect(host.metadata.deferredSince).toBeUndefined();
    expect(promptText(host)).not.toMatch(
      /another thread is running in this shared checkout/i,
    );
    await host.harness.dispose();
  });

  it("does not release a deferred sibling while another review is in flight", async () => {
    const host = createHost({
      envThreads: [
        { id: THREAD_ID, status: "idle" },
        { id: SIBLING_ID, status: "idle" },
      ],
    });
    await plugin(host.bb);
    host.metadataFor(THREAD_ID).phase = "deferred";
    host.metadataFor(THREAD_ID).deferredSince = Date.now();
    host.metadataFor(THREAD_ID).turnStart = { sinceSeq: 0 };
    host.metadataFor(SIBLING_ID).phase = "awaiting-review";

    await emitIdle(host, "thread-3");
    expect(host.sends).toHaveLength(0);
    expect(host.metadataFor(THREAD_ID).phase).toBe("deferred");
    await host.harness.dispose();
  });

  it("unparks a deferred turn that turns out to have nothing to review", async () => {
    const host = createHost({
      authoredRows: [],
      envThreads: [
        { id: THREAD_ID, status: "idle" },
        { id: SIBLING_ID, status: "idle" },
      ],
    });
    await plugin(host.bb);
    host.metadata.phase = "deferred";
    host.metadata.deferredSince = Date.now();
    host.metadata.turnStart = { sinceSeq: 0 };

    await emitIdle(host);
    expect(host.sends).toHaveLength(0);
    expect(host.metadata.phase).toBe("idle");
    expect(host.metadata.deferredSince).toBeUndefined();

    // The cursor is free to advance again now that nothing is owed.
    host.setMaxSeq(400);
    await emitActive(host);
    expect(host.metadata.turnStart).toEqual({ sinceSeq: 400 });
    await host.harness.dispose();
  });

  it("fires a contention-aware review once the defer window runs out", async () => {
    const host = createHost({
      envThreads: [
        { id: THREAD_ID, status: "idle" },
        { id: SIBLING_ID, status: "active" },
      ],
    });
    await plugin(host.bb);
    host.metadata.phase = "deferred";
    host.metadata.deferredSince = Date.now() - DEFER_WINDOW_MS - 1_000;
    host.metadata.turnStart = { sinceSeq: 0 };

    await emitIdle(host);
    expect(host.sends).toHaveLength(1);
    expect(host.metadata.phase).toBe("awaiting-review");
    expect(host.metadata.deferredSince).toBeUndefined();

    const text = promptText(host);
    expect(text).toMatch(/another thread is running in this shared checkout/i);
    expect(text).toMatch(/Do NOT continue with further planned work/);
    expect(text).not.toMatch(/Merge the current branch/);
    expect(text).toMatch(/Commit the staged changes/);
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

  it("sweeps an expired deferral onto a review with no thread event at all", async () => {
    const host = createHost({
      envThreads: [
        { id: THREAD_ID, status: "idle" },
        { id: SIBLING_ID, status: "active" },
      ],
    });
    await plugin(host.bb);
    await emitActive(host);
    await emitIdle(host);
    expect(host.metadata.phase).toBe("deferred");
    expect(host.sends).toHaveLength(0);

    // Nothing in this environment will ever go idle again; only the sweep can
    // reach this turn.
    await host.harness.runSchedule("sweep-deferrals");
    expect(host.sends).toHaveLength(0);

    host.metadata.deferredSince = Date.now() - DEFER_WINDOW_MS - 1_000;
    await host.harness.runSchedule("sweep-deferrals");
    expect(host.sends).toHaveLength(1);
    expect(host.sends[0]?.threadId).toBe(THREAD_ID);
    expect(host.metadata.phase).toBe("awaiting-review");
    expect(promptText(host)).toMatch(
      /another thread is running in this shared checkout/i,
    );
    await host.harness.dispose();
  });

  it("injects only one review when two drivers race the same parked thread", async () => {
    const host = createHost({
      envThreads: [
        { id: THREAD_ID, status: "idle" },
        { id: SIBLING_ID, status: "active" },
      ],
    });
    await plugin(host.bb);
    await emitActive(host);
    await emitIdle(host);
    expect(host.metadata.phase).toBe("deferred");

    host.metadata.deferredSince = Date.now() - DEFER_WINDOW_MS - 1_000;
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

  it("releases only one parked thread per checkout per sweep", async () => {
    const BLOCKER_ID = "thread-3";
    const host = createHost({
      authoringThreads: [THREAD_ID, SIBLING_ID],
      envThreads: [
        { id: THREAD_ID, status: "idle" },
        { id: SIBLING_ID, status: "idle" },
        { id: BLOCKER_ID, status: "active" },
      ],
    });
    await plugin(host.bb);

    await emitActive(host);
    await emitIdle(host);
    await emitActive(host, SIBLING_ID);
    await emitIdle(host, SIBLING_ID);
    expect(host.metadataFor(THREAD_ID).phase).toBe("deferred");
    expect(host.metadataFor(SIBLING_ID).phase).toBe("deferred");
    expect(host.sends).toHaveLength(0);

    const expired = Date.now() - DEFER_WINDOW_MS - 1_000;
    host.metadataFor(THREAD_ID).deferredSince = expired;
    host.metadataFor(SIBLING_ID).deferredSince = expired;

    // Both are expired and the roster reads idle for both, but a queued review
    // does not flip its thread to active — firing both would put two
    // stage-commit-merge sequences in one working tree.
    await host.harness.runSchedule("sweep-deferrals");
    expect(host.sends).toHaveLength(1);
    await host.harness.dispose();
  });

  it("does not sweep a parked thread while a sibling review is in flight", async () => {
    const host = createHost({
      envThreads: [
        { id: THREAD_ID, status: "idle" },
        { id: SIBLING_ID, status: "idle" },
      ],
    });
    await plugin(host.bb);
    await emitActive(host);
    await emitIdle(host);
    expect(host.sends).toHaveLength(1);
    host.sends.length = 0;

    // Re-park this thread with an expired window, and put the sibling in flight.
    host.metadata.phase = "deferred";
    host.metadata.deferredSince = Date.now() - DEFER_WINDOW_MS - 1_000;
    host.metadata.turnStart = { sinceSeq: 0 };
    await host.bb.storage.kv.set(`deferral:${THREAD_ID}`, {
      threadId: THREAD_ID,
      projectId: "project-1",
      environmentId: ENV_ID,
    });
    host.metadataFor(SIBLING_ID).phase = "awaiting-review";

    await host.harness.runSchedule("sweep-deferrals");
    expect(host.sends).toHaveLength(0);
    expect(host.metadata.phase).toBe("deferred");
    await host.harness.dispose();
  });

  it("unparks, not just de-indexes, a thread the sweep can no longer resolve", async () => {
    const host = createHost({
      envThreads: [
        { id: THREAD_ID, status: "idle" },
        { id: SIBLING_ID, status: "active" },
      ],
      getThrowsFor: [THREAD_ID],
    });
    await plugin(host.bb);
    await emitActive(host);
    await emitIdle(host);
    expect(host.metadata.phase).toBe("deferred");

    host.metadata.deferredSince = Date.now() - DEFER_WINDOW_MS - 1_000;
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
    const host = createHost({
      envThreads: [
        { id: THREAD_ID, status: "idle" },
        { id: SIBLING_ID, status: "active" },
      ],
    });
    await plugin(host.bb);
    await emitActive(host);
    await emitIdle(host);
    expect(host.metadata.phase).toBe("deferred");

    await host.harness.runCli(["reset", THREAD_ID]);
    host.metadata.deferredSince = Date.now() - DEFER_WINDOW_MS - 1_000;
    await host.harness.runSchedule("sweep-deferrals");
    expect(host.sends).toHaveLength(0);
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
