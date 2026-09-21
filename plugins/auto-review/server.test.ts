import { describe, expect, it } from "vitest";
import {
  createFakePluginHost,
  makeQueueEntry,
  makeThreadResponse,
  type CreateFakePluginHostOptions,
} from "@get-bb/plugin-sdk/testing";
import plugin from "./server.js";

const THREAD_ID = "thread-1";
const ENV_ID = "env-1";
const PLUGIN_ID = "auto-review";

interface HostOptions {
  sendDelivery?: "sent" | "queued";
  sendThrows?: boolean;
  authoredRows?: unknown[];
  workingTreeFiles?: Array<{ path: string }>;
  worktree?: boolean;
  siblingActiveOnRecheck?: boolean;
  queuedRows?: Array<{ id: string }>;
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
  const metadata: Record<string, unknown> = {};
  const sends: Array<{ threadId: string; mode: string; input: unknown }> = [];
  let listCalls = 0;
  const authoredRows = options.authoredRows ?? [fileChangeRow("src/a.ts")];
  const workingTreeFiles = options.workingTreeFiles ?? [{ path: "src/a.ts" }];
  const worktree = options.worktree ?? true;

  const sdk: CreateFakePluginHostOptions["sdk"] = {
    threads: {
      getPluginMetadata: async () => ({ ...metadata }),
      updatePluginMetadata: async (args: {
        set?: Record<string, unknown>;
        remove?: string[];
      }) => {
        if (args.set) {
          Object.assign(metadata, args.set);
        }
        for (const key of args.remove ?? []) {
          delete metadata[key];
        }
        return { ...metadata };
      },
      get: async () => ({ projectId: "project-1" }),
      timeline: async () => ({ rows: authoredRows, maxSeq: 100 }),
      list: async () => {
        listCalls += 1;
        const sibling =
          options.siblingActiveOnRecheck === true && listCalls >= 2
            ? [{ id: "sibling", status: "active", environmentIsWorktree: worktree }]
            : [];
        return [
          { id: THREAD_ID, status: "idle", environmentIsWorktree: worktree },
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

  return { ...createFakePluginHost({ pluginId: PLUGIN_ID, sdk }), metadata, sends };
}

function thread() {
  return makeThreadResponse({ id: THREAD_ID, environmentId: ENV_ID });
}

type Host = ReturnType<typeof createHost>;

function emitActive(host: Host) {
  return host.harness.behavior.emitThreadEvent("thread.active", {
    thread: thread(),
  });
}

function emitIdle(host: Host) {
  return host.harness.behavior.emitThreadEvent("thread.idle", {
    thread: thread(),
    lastAssistantText: null,
  });
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

  it("stands down when a sibling becomes active before the firing lock", async () => {
    const host = createHost({ siblingActiveOnRecheck: true });
    await plugin(host.bb);
    await emitActive(host);
    await emitIdle(host);
    expect(host.sends).toHaveLength(0);
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
