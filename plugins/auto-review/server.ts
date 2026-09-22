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
  addDeferral,
  readDeferrals,
  removeDeferral,
} from "./src/deferrals.js";
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
  hasReviewInFlight,
  passesThreadGate,
  pickDeferredRelease,
  selfIsWorktree,
  type GateThread,
  type SiblingPhase,
} from "./src/gate.js";
import { buildReviewPrompt, renderScope } from "./src/prompt.js";
import {
  deferralExpired,
  isStale,
  readState,
  REVIEW_IN_FLIGHT_PHASES,
  resetToIdlePatch,
  withThreadLock,
  writeState,
  type ThreadState,
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

  /**
   * Park this turn instead of dropping it. The turn-start cursor is left in
   * place, so when the checkout goes quiet the review still covers the work
   * this turn authored — and `thread.active` carries that cursor forward if
   * the thread takes another turn in the meantime.
   */
  async function deferTurn(
    thread: GateThreadLike,
    state: ThreadState,
    environmentId: string,
    extra: Partial<Omit<LastFire, "at" | "outcome" | "reason">> = {},
  ): Promise<void> {
    // Index first, state second. The sweep enumerates the index and prunes an
    // entry whose thread is not actually deferred, so an interruption between
    // these two writes leaves a harmless orphan the next sweep cleans up. The
    // reverse order would leave a thread parked with no index entry — invisible
    // to the sweep, which is the one stranding case the sweep exists to fix.
    await addDeferral(bb, {
      threadId: thread.id,
      projectId: thread.projectId,
      environmentId,
    });
    await writeState(bb, thread.id, {
      phase: "deferred",
      deferredSince: state.deferredSince ?? Date.now(),
    });
    await recordFire(
      thread.projectId,
      thread.id,
      "deferred",
      "sibling-active",
      extra,
    );
  }

  /** Every other thread in this environment, paired with its auto-review phase. */
  async function siblingPhases(
    environmentId: string,
    selfThreadId: string,
  ): Promise<SiblingPhase[]> {
    const entries = await bb.sdk.threads.list({
      environmentId,
      includeHidden: true,
    });
    return Promise.all(
      entries
        .filter((entry) => entry.id !== selfThreadId)
        .map(async (entry) => ({
          id: entry.id,
          phase: (await readState(bb, entry.id)).phase,
        })),
    );
  }

  /**
   * Resolve a thread id to a gated thread and evaluate it under its own lock.
   * Returns whether evaluation actually ran; `onUnusable` is called when the
   * thread is gone or no longer gated, so each caller can clean up its own way.
   */
  async function resolveAndEvaluate(
    threadId: string,
    onUnusable: (why: string) => Promise<void>,
  ): Promise<boolean> {
    let candidate: Awaited<ReturnType<typeof bb.sdk.threads.get>>;
    try {
      candidate = await bb.sdk.threads.get({ threadId });
    } catch (error) {
      await onUnusable(error instanceof Error ? error.message : String(error));
      return false;
    }
    if (!passesThreadGate(candidate)) {
      await onUnusable("thread no longer passes the auto-review thread gate");
      return false;
    }
    await withThreadLock(threadId, () =>
      evaluate({ ...candidate, id: threadId, projectId: candidate.projectId }),
    );
    return true;
  }

  /**
   * End the turn without a review. A turn that had been deferred is unparked
   * here too — otherwise a deferral that later turns out to have nothing to
   * review would latch the thread in `deferred` and freeze its cursor.
   */
  async function standDown(
    thread: GateThreadLike,
    state: ThreadState,
    reason: FireReason,
    extra: Partial<Omit<LastFire, "at" | "outcome" | "reason">> = {},
  ): Promise<void> {
    if (state.phase === "deferred") {
      const { set, remove } = resetToIdlePatch();
      await writeState(bb, thread.id, set, remove);
      await removeDeferral(bb, thread.id);
    }
    await recordFire(thread.projectId, thread.id, "stood-down", reason, extra);
  }

  async function evaluate(thread: GateThreadLike): Promise<void> {
    const state = await readState(bb, thread.id);
    // Three drivers reach this: a thread's own idle, a sibling's idle releasing
    // a deferral, and the expiry sweep. Each decides to call evaluate before
    // taking this thread's lock, so two can decide on the same parked thread
    // and only one wins the lock. Re-check under the lock: a review that is
    // already queued or in flight means the loser has nothing to do. Silent and
    // idempotent — it records no fire, because nothing was decided here.
    if (REVIEW_IN_FLIGHT_PHASES.includes(state.phase)) {
      return;
    }
    const project = await readProjectConfig(bb, thread.projectId);
    const config = effectiveConfig(globals, project, state.skip === true);

    if (!config.enabled) {
      await standDown(thread, state, "disabled");
      return;
    }
    if (config.skipped) {
      await standDown(thread, state, "skipped");
      return;
    }
    if (state.turnStart === undefined) {
      await standDown(thread, state, "no-turn-start");
      return;
    }
    const environmentId = thread.environmentId;
    if (environmentId === null) {
      return;
    }

    const workspace = await fetchWorkspace(bb, environmentId);
    if (workspace === null) {
      await standDown(thread, state, "status-unavailable");
      return;
    }
    if (!isBranchCheckout(workspace)) {
      await standDown(thread, state, "not-a-branch");
      return;
    }

    const entries = await bb.sdk.threads.list({
      environmentId,
      includeHidden: true,
    });
    // A busy sibling shares this working tree, so reviewing now would stage a
    // moving target. Wait for a quiet checkout rather than dropping the turn;
    // only once the wait has run out do we fall through to a review that keeps
    // everything except the steps a contended tree makes unsafe.
    const waitedOut = deferralExpired(state, Date.now());
    if (hasActiveSibling(entries, thread.id) && !waitedOut) {
      await deferTurn(thread, state, environmentId);
      return;
    }
    const isWorktree = selfIsWorktree(entries, thread.id);

    const authored = await authoredPaths(bb, thread.id, state.turnStart.sinceSeq);
    if (authored.length === 0) {
      await standDown(thread, state, "no-authorship");
      return;
    }
    const scope = computeScope(authored, dirtyOrAheadPaths(workspace));
    if (scope.length === 0) {
      await standDown(thread, state, "empty-scope");
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
      const contended = hasActiveSibling(recheck, thread.id);
      if (contended && !waitedOut) {
        await deferTurn(thread, state, environmentId, {
          commit: decision.commit,
          merge: decision.merge,
          base,
          isWorktree,
          scopePaths: scope,
        });
        return;
      }

      const prompt = buildReviewPrompt({
        decision,
        reviewMode: config.reviewMode,
        scope: renderScope(scope),
        contended,
      });
      await writeState(
        bb,
        thread.id,
        { phase: "awaiting-review", dispatchedAt: Date.now() },
        ["pendingEntryId", "deferredSince"],
      );
      await removeDeferral(bb, thread.id);
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
      await recordFire(
        thread.projectId,
        thread.id,
        "fired",
        contended ? "contended" : "fired",
        {
          commit: decision.commit,
          // A contended review never reaches the merge step, so do not record
          // a merge it was told not to perform.
          merge: decision.merge && !contended,
          base,
          isWorktree,
          scopePaths: scope,
        },
      );
    });
  }

  /**
   * The checkout just went quiet, so let one deferred sibling through. One per
   * sweep: the thread we release immediately occupies the environment again,
   * and its own idle drives the next release.
   */
  async function releaseDeferred(self: GateThreadLike): Promise<void> {
    const environmentId = self.environmentId;
    if (environmentId === null) {
      return;
    }
    // We may have just latched a review onto ourselves, in which case this
    // environment is already spoken for.
    const selfState = await readState(bb, self.id);
    if (selfState.phase !== "idle") {
      return;
    }
    const entries = await bb.sdk.threads.list({
      environmentId,
      includeHidden: true,
    });
    if (hasActiveSibling(entries, self.id)) {
      return;
    }

    const threadId = pickDeferredRelease(
      await siblingPhases(environmentId, self.id),
    );
    if (threadId === null) {
      return;
    }
    await resolveAndEvaluate(threadId, async (why) => {
      bb.log.warn(
        `auto-review: could not release deferred thread ${threadId}: ${why}`,
      );
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
      const state = await readState(bb, thread.id);
      if (state.phase === "deferred" && state.turnStart !== undefined) {
        // A deferred turn is still owed a review. Keep its (earlier) cursor so
        // the eventual review covers that turn's work as well as this one's,
        // instead of starting the authorship window over and losing it.
        return;
      }
      const sinceSeq = await captureSinceSeq(bb, thread.id);
      await writeState(bb, thread.id, { turnStart: { sinceSeq } });
    });
  });

  bb.events.on("thread.idle", async ({ thread }) => {
    if (!passesThreadGate(thread)) {
      return;
    }
    await withThreadLock(thread.id, () => handleIdle(thread));
    // Outside the thread lock, and outside evaluate's environment lock, so
    // releasing a sibling cannot deadlock against the work we just did.
    await releaseDeferred(thread);
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
      await removeDeferral(bb, threadId);
    });

  /**
   * The deadline behind `deferralExpired`. Releasing on a sibling's idle covers
   * the common case, but a turn parked behind a sibling that never goes idle —
   * or behind one whose idle this plugin never sees, because it is a child,
   * plugin-origin or hidden thread — would otherwise sit parked forever with no
   * event to wake it. This sweep is what makes the defer window an actual
   * deadline rather than a condition checked only on re-entry.
   */
  async function sweepExpiredDeferrals(): Promise<void> {
    for (const entry of await readDeferrals(bb)) {
      const state = await readState(bb, entry.threadId);
      if (state.phase !== "deferred") {
        await removeDeferral(bb, entry.threadId);
        continue;
      }
      if (!deferralExpired(state, Date.now())) {
        continue;
      }
      // Same veto `releaseDeferred` applies, and it is what keeps this loop to
      // one release per checkout: `evaluate` latches `awaiting-review` before
      // it sends, so a second entry in the same environment sees the first
      // thread's review in flight and waits for the next pass. Without it, two
      // entries expiring on the same tick would both read an idle-looking
      // roster — a queued review does not flip its thread to `active` — and
      // both would fire a stage-commit-merge sequence into one working tree.
      if (
        hasReviewInFlight(
          await siblingPhases(entry.environmentId, entry.threadId),
        )
      ) {
        continue;
      }
      await resolveAndEvaluate(entry.threadId, async (why) => {
        // Unpark as well as de-index. Dropping the index entry alone would
        // leave the thread latched in `deferred` and invisible to every later
        // sweep — the stranding this sweep exists to prevent.
        bb.log.warn(
          `auto-review: dropping the deferred turn for ${entry.threadId}: ${why}`,
        );
        const { set, remove } = resetToIdlePatch();
        await writeState(bb, entry.threadId, set, remove);
        await removeDeferral(bb, entry.threadId);
      });
    }
  }

  bb.background.schedule("sweep-deferrals", "*/5 * * * *", sweepExpiredDeferrals);

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
