import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { registerAutoReviewCli } from "./src/cli.js";
import {
  defineAutoReviewSettings,
  effectiveConfig,
  globalDefaultsFrom,
  readProjectConfig,
  writeLastFire,
  type FireReason,
  type GlobalDefaults,
  type LastFire,
} from "./src/config.js";
import { decide } from "./src/decide.js";
import {
  authoredPaths,
  captureSinceSeq,
  computeScope,
  dirtyOrAheadPaths,
  fetchWorkspace,
  isBranchCheckout,
  mainlineBase,
} from "./src/detect.js";
import {
  hasActiveSibling,
  passesThreadGate,
  selfIsWorktree,
  type GateThread,
} from "./src/gate.js";
import { buildReviewPrompt, renderScope } from "./src/prompt.js";
import {
  isStale,
  readState,
  resetToIdlePatch,
  withThreadLock,
  writeState,
} from "./src/state.js";

interface GateThreadLike extends GateThread {
  id: string;
  projectId: string;
}

const envLocks = new Map<string, Promise<unknown>>();

function withEnvLock<T>(environmentId: string, run: () => Promise<T>): Promise<T> {
  const previous = envLocks.get(environmentId) ?? Promise.resolve();
  const next = previous.then(run, run);
  const settled = next.then(
    () => undefined,
    () => undefined,
  );
  envLocks.set(environmentId, settled);
  void settled.then(() => {
    if (envLocks.get(environmentId) === settled) {
      envLocks.delete(environmentId);
    }
  });
  return next;
}

export default async function plugin(bb: BbPluginApi) {
  const settings = defineAutoReviewSettings(bb);
  let globals: GlobalDefaults = globalDefaultsFrom(await settings.get());
  settings.onChange((next) => {
    globals = globalDefaultsFrom(next);
  });

  async function recordFire(
    projectId: string,
    threadId: string,
    outcome: LastFire["outcome"],
    reason: FireReason,
    extra: Partial<Omit<LastFire, "at" | "outcome" | "reason">> = {},
  ): Promise<void> {
    const fire: LastFire = {
      at: Date.now(),
      outcome,
      reason,
      commit: extra.commit ?? false,
      merge: extra.merge ?? false,
      base: extra.base ?? null,
      isWorktree: extra.isWorktree ?? false,
      scopePaths: extra.scopePaths ?? [],
    };
    await writeLastFire(bb, projectId, threadId, fire);
  }

  async function queuedRowExists(
    threadId: string,
    entryId: string,
  ): Promise<boolean> {
    const rows = await bb.sdk.threads.queuedMessages.list({ threadId });
    return rows.some((row) => row.id === entryId);
  }

  async function evaluate(thread: GateThreadLike): Promise<void> {
    const state = await readState(bb, thread.id);
    const project = await readProjectConfig(bb, thread.projectId);
    const config = effectiveConfig(globals, project, state.skip === true);

    if (!config.enabled) {
      await recordFire(thread.projectId, thread.id, "stood-down", "disabled");
      return;
    }
    if (config.skipped) {
      await recordFire(thread.projectId, thread.id, "stood-down", "skipped");
      return;
    }
    if (state.turnStart === undefined) {
      await recordFire(thread.projectId, thread.id, "stood-down", "no-turn-start");
      return;
    }
    const environmentId = thread.environmentId;
    if (environmentId === null) {
      return;
    }

    const workspace = await fetchWorkspace(bb, environmentId);
    if (workspace === null) {
      await recordFire(
        thread.projectId,
        thread.id,
        "stood-down",
        "status-unavailable",
      );
      return;
    }
    if (!isBranchCheckout(workspace)) {
      await recordFire(thread.projectId, thread.id, "stood-down", "not-a-branch");
      return;
    }

    const entries = await bb.sdk.threads.list({
      environmentId,
      includeHidden: true,
    });
    if (hasActiveSibling(entries, thread.id)) {
      await recordFire(
        thread.projectId,
        thread.id,
        "stood-down",
        "sibling-active",
      );
      return;
    }
    const isWorktree = selfIsWorktree(entries, thread.id);

    const authored = await authoredPaths(bb, thread.id, state.turnStart.sinceSeq);
    if (authored.length === 0) {
      await recordFire(
        thread.projectId,
        thread.id,
        "stood-down",
        "no-authorship",
      );
      return;
    }
    const scope = computeScope(authored, dirtyOrAheadPaths(workspace));
    if (scope.length === 0) {
      await recordFire(thread.projectId, thread.id, "stood-down", "empty-scope");
      return;
    }

    const base = mainlineBase(workspace);
    const decision = decide({
      base,
      currentBranch: workspace.branch.currentBranch,
      isDedicatedWorktree: isWorktree,
      mergeEligibleMainlines: config.mergeEligibleMainlines,
    });

    await withEnvLock(environmentId, async () => {
      const recheck = await bb.sdk.threads.list({
        environmentId,
        includeHidden: true,
      });
      if (hasActiveSibling(recheck, thread.id)) {
        await recordFire(
          thread.projectId,
          thread.id,
          "stood-down",
          "sibling-active",
          { commit: decision.commit, merge: decision.merge, base, isWorktree, scopePaths: scope },
        );
        return;
      }

      const prompt = buildReviewPrompt({
        decision,
        reviewMode: config.reviewMode,
        scope: renderScope(scope),
      });
      await writeState(
        bb,
        thread.id,
        { phase: "awaiting-review", dispatchedAt: Date.now() },
        ["pendingEntryId"],
      );
      let result: Awaited<ReturnType<typeof bb.sdk.threads.send>>;
      try {
        result = await bb.sdk.threads.send({
          threadId: thread.id,
          mode: "auto",
          input: [{ type: "text", text: prompt, mentions: [] }],
        });
      } catch (error) {
        bb.log.warn(
          `auto-review: failed to send the review turn for ${thread.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        const { set, remove } = resetToIdlePatch();
        await writeState(bb, thread.id, set, remove);
        await recordFire(thread.projectId, thread.id, "stood-down", "send-failed", {
          commit: decision.commit,
          merge: decision.merge,
          base,
          isWorktree,
          scopePaths: scope,
        });
        return;
      }
      if (result.delivery === "queued") {
        await writeState(bb, thread.id, {
          phase: "pending-dispatch",
          pendingEntryId: result.queuedMessage.id,
        });
      }
      await recordFire(thread.projectId, thread.id, "fired", "fired", {
        commit: decision.commit,
        merge: decision.merge,
        base,
        isWorktree,
        scopePaths: scope,
      });
    });
  }

  async function handleIdle(thread: GateThreadLike): Promise<void> {
    const state = await readState(bb, thread.id);
    if (state.phase === "awaiting-review") {
      const { set, remove } = resetToIdlePatch();
      await writeState(bb, thread.id, set, remove);
      return;
    }
    if (state.phase === "pending-dispatch") {
      if (isStale(state, Date.now())) {
        if (
          state.pendingEntryId !== undefined &&
          (await queuedRowExists(thread.id, state.pendingEntryId))
        ) {
          await writeState(bb, thread.id, { dispatchedAt: Date.now() });
          return;
        }
        await writeState(bb, thread.id, { phase: "awaiting-review" }, [
          "pendingEntryId",
        ]);
      }
      return;
    }
    await evaluate(thread);
  }

  bb.events.on("thread.active", async ({ thread }) => {
    if (!passesThreadGate(thread)) {
      return;
    }
    await withThreadLock(thread.id, async () => {
      const sinceSeq = await captureSinceSeq(bb, thread.id);
      await writeState(bb, thread.id, { turnStart: { sinceSeq } });
    });
  });

  bb.events.on("thread.idle", async ({ thread }) => {
    if (!passesThreadGate(thread)) {
      return;
    }
    await withThreadLock(thread.id, () => handleIdle(thread));
  });

  bb.events.on("message.dispatched", async ({ entry }) => {
    await withThreadLock(entry.threadId, async () => {
      const state = await readState(bb, entry.threadId);
      if (
        state.phase === "pending-dispatch" &&
        state.pendingEntryId === entry.id
      ) {
        await writeState(bb, entry.threadId, { phase: "awaiting-review" }, [
          "pendingEntryId",
        ]);
      }
    });
  });

  bb.events.on("message.cancelled", async ({ entry }) => {
    await withThreadLock(entry.threadId, async () => {
      const state = await readState(bb, entry.threadId);
      if (
        state.phase === "pending-dispatch" &&
        state.pendingEntryId === entry.id
      ) {
        const { set, remove } = resetToIdlePatch();
        await writeState(bb, entry.threadId, set, remove);
      }
    });
  });

  const unlatch = (threadId: string) =>
    withThreadLock(threadId, async () => {
      const state = await readState(bb, threadId);
      if (state.phase !== "idle") {
        const { set, remove } = resetToIdlePatch();
        await writeState(bb, threadId, set, remove);
      }
    });

  bb.events.on("thread.failed", async ({ thread }) => {
    await unlatch(thread.id);
  });
  bb.events.on("thread.archived", async ({ thread }) => {
    await unlatch(thread.id);
  });
  bb.events.on("thread.deleted", async ({ thread }) => {
    await unlatch(thread.id);
  });

  registerAutoReviewCli(bb, settings, () => globals);
}
