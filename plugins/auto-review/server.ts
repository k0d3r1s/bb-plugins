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
  hasBusyCodingSibling,
  hasReviewInFlight,
  isBusyStatus,
  passesThreadGate,
  pickDeferredRelease,
  selfIsWorktree,
  type GateThread,
  type SiblingReview,
} from "./src/gate.js";
import { planApprovalOf, planGateAction, type PlanApproval } from "./src/plan.js";
import {
  buildPlanReviewPrompt,
  buildReviewPrompt,
  renderScope,
} from "./src/prompt.js";
import {
  isStale,
  PLAN_GATE_KEYS,
  planHoldExpired,
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
   * place, so when the blocking review ends this review still covers the work
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

  async function listEnvironment(environmentId: string) {
    return bb.sdk.threads.list({ environmentId, includeHidden: true });
  }

  /** Every other thread in this environment, paired with its auto-review state. */
  async function siblingReviews(
    entries: Awaited<ReturnType<typeof listEnvironment>>,
    selfThreadId: string,
  ): Promise<SiblingReview[]> {
    return Promise.all(
      entries
        .filter((entry) => entry.id !== selfThreadId)
        .map(async (entry) => ({
          id: entry.id,
          state: await readState(bb, entry.id),
          busy: isBusyStatus(entry.status),
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

    // Only another thread's review in flight parks this turn — two reviews
    // staging, committing and merging in one working tree at once is the one
    // thing to avoid. Threads that are merely running, including this thread's
    // own advisor or subagents, never do.
    const entries = await listEnvironment(environmentId);
    if (hasReviewInFlight(await siblingReviews(entries, thread.id), Date.now())) {
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
      const recheck = await listEnvironment(environmentId);
      if (
        hasReviewInFlight(await siblingReviews(recheck, thread.id), Date.now())
      ) {
        await deferTurn(thread, state, environmentId, {
          commit: decision.commit,
          merge: decision.merge,
          base,
          isWorktree,
          scopePaths: scope,
        });
        return;
      }
      const contended = hasBusyCodingSibling(recheck, thread.id);

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
   * A thread in this checkout just went idle — possibly ending the review that
   * parked its siblings — so let one deferred sibling through. One per call:
   * the released thread latches its own review immediately, and that review's
   * idle drives the next release.
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
    const threadId = pickDeferredRelease(
      await siblingReviews(await listEnvironment(environmentId), self.id),
      Date.now(),
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

  /**
   * Hold a plan's first presentation for review. The review turn is queued
   * BEFORE the approval is denied: a thread awaiting an interaction cannot take
   * a prompt, so the turn waits on the approval and core steers it in the
   * moment the deny settles — the agent reads the reason alongside the deny
   * instead of guessing why its plan was "rejected".
   */
  async function gatePlan(
    thread: GateThreadLike,
    approval: PlanApproval,
  ): Promise<void> {
    const state = await readState(bb, thread.id);
    const project = await readProjectConfig(bb, thread.projectId);
    const config = effectiveConfig(globals, project, state.skip === true);
    if (!config.enabled || config.skipped) {
      return;
    }

    const action = planGateAction(state, approval.plan);
    if (action === "commit-plan") {
      await recordFire(thread.projectId, thread.id, "stood-down", "commit-plan");
      return;
    }
    if (action === "release") {
      await writeState(bb, thread.id, {}, [...PLAN_GATE_KEYS]);
      await recordFire(thread.projectId, thread.id, "stood-down", "plan-reviewed");
      return;
    }
    if (action === "hold") {
      await holdOrReleasePlan(thread, state, approval);
      return;
    }

    await writeState(bb, thread.id, { planReviewArmedAt: Date.now() });
    let queuedMessageId: string | null = null;
    try {
      const result = await bb.sdk.threads.send({
        threadId: thread.id,
        mode: "auto",
        input: [
          {
            type: "text",
            text: buildPlanReviewPrompt({
              reviewMode: config.reviewMode,
              planFilePath: approval.planFilePath,
            }),
            mentions: [],
          },
        ],
      });
      if (result.delivery === "queued") {
        queuedMessageId = result.queuedMessage.id;
        await writeState(bb, thread.id, { planReviewEntryId: queuedMessageId });
      }
    } catch (error) {
      // Nothing was queued, so leave the plan with the user untouched.
      bb.log.warn(
        `auto-review: failed to queue the plan review for ${thread.id}; leaving the plan for the user: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      await writeState(bb, thread.id, {}, [...PLAN_GATE_KEYS]);
      await recordFire(thread.projectId, thread.id, "stood-down", "send-failed");
      return;
    }
    if (await denyPlan(thread, approval, queuedMessageId)) {
      await recordFire(thread.projectId, thread.id, "fired", "plan-review");
    }
  }

  /**
   * A plan re-presented while its review is recorded as queued. Hold it only
   * while the review really is still in the queue and has not been there past
   * the stale window: the recorded id is cleared only by `message.dispatched`
   * or `message.cancelled`, so trusting it alone would turn one missed event
   * into a bare deny of every plan the thread presents from then on.
   */
  async function holdOrReleasePlan(
    thread: GateThreadLike,
    state: ThreadState,
    approval: PlanApproval,
  ): Promise<void> {
    const entryId = state.planReviewEntryId ?? null;
    const queued =
      entryId !== null && (await queuedRowExists(thread.id, entryId));
    const expired = planHoldExpired(state, Date.now());
    if (queued && !expired) {
      // The review is still queued behind this approval; denying lets it in.
      await denyPlan(thread, approval, entryId);
      return;
    }
    if (queued && entryId !== null) {
      // Withdraw it, or it would land in the middle of implementing the plan
      // this release hands to the user.
      await withdrawQueuedReview(thread.id, entryId);
    }
    // Not queued any more means the review was dispatched and this is the
    // reviewed plan, whose dispatch event never reached us.
    await writeState(bb, thread.id, {}, [...PLAN_GATE_KEYS]);
    await recordFire(
      thread.projectId,
      thread.id,
      "stood-down",
      queued ? "plan-hold-expired" : "plan-reviewed",
    );
  }

  async function withdrawQueuedReview(
    threadId: string,
    queuedMessageId: string,
  ): Promise<void> {
    await bb.sdk.threads.queuedMessages
      .delete({ threadId, queuedMessageId })
      .catch((deleteError: unknown) => {
        bb.log.warn(
          `auto-review: could not withdraw the queued plan review ${queuedMessageId} in ${threadId}: ${
            deleteError instanceof Error ? deleteError.message : String(deleteError)
          }`,
        );
      });
  }

  /**
   * Deny a held plan. If the deny fails the plan is still with the user (or
   * they already answered it), so pull the queued review back out — otherwise
   * it would land after an approval and send the agent back to planning in the
   * middle of implementing — and disarm. A review that was delivered straight
   * into the turn (no queued row) cannot be withdrawn; that is only logged.
   */
  async function denyPlan(
    thread: GateThreadLike,
    approval: PlanApproval,
    queuedMessageId: string | null,
  ): Promise<boolean> {
    try {
      await bb.sdk.threads.interactions.resolve({
        threadId: thread.id,
        interactionId: approval.interactionId,
        resolution: { decision: "deny" },
      });
      return true;
    } catch (error) {
      bb.log.warn(
        `auto-review: could not hold the plan for review in ${thread.id}; leaving it for the user: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      if (queuedMessageId !== null) {
        await withdrawQueuedReview(thread.id, queuedMessageId);
      }
      await writeState(bb, thread.id, {}, [...PLAN_GATE_KEYS]);
      await recordFire(thread.projectId, thread.id, "stood-down", "send-failed");
      return false;
    }
  }

  bb.events.on("interaction.pending", async ({ thread, interaction }) => {
    const approval = planApprovalOf(interaction);
    if (approval === null || !passesThreadGate(thread)) {
      return;
    }
    await withThreadLock(thread.id, () => gatePlan(thread, approval));
  });

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
      if (state.planReviewEntryId === entry.id) {
        // The review is in the agent's hands; its next presentation is the
        // reviewed plan.
        await writeState(bb, entry.threadId, {}, ["planReviewEntryId"]);
        return;
      }
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
      if (state.planReviewEntryId === entry.id) {
        // The review never ran, so the next plan still owes one.
        await writeState(bb, entry.threadId, {}, [...PLAN_GATE_KEYS]);
        return;
      }
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
   * The backstop for a release no event delivered. The review that parked a
   * turn normally releases it from its own idle, but that idle can be missed —
   * a restart, or a blocker that failed, was deleted, or left a stale latch
   * behind. Each pass retries every parked turn whose checkout no longer has a
   * review in flight.
   */
  async function sweepDeferrals(): Promise<void> {
    for (const entry of await readDeferrals(bb)) {
      const state = await readState(bb, entry.threadId);
      if (state.phase !== "deferred") {
        await removeDeferral(bb, entry.threadId);
        continue;
      }
      // Same veto `releaseDeferred` applies, and it is what keeps this loop to
      // one release per checkout: `evaluate` latches `awaiting-review` before
      // it sends, so a second entry in the same environment sees the first
      // thread's review in flight and waits for the next pass.
      if (
        hasReviewInFlight(
          await siblingReviews(
            await listEnvironment(entry.environmentId),
            entry.threadId,
          ),
          Date.now(),
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

  bb.background.schedule("sweep-deferrals", "*/5 * * * *", sweepDeferrals);

  // A failed or archived thread may have been the review a sibling was parked
  // behind, and it will not go idle to release it.
  bb.events.on("thread.failed", async ({ thread }) => {
    await unlatch(thread.id);
    await releaseDeferred(thread);
  });
  bb.events.on("thread.archived", async ({ thread }) => {
    await unlatch(thread.id);
    await releaseDeferred(thread);
  });
  bb.events.on("thread.deleted", async ({ thread }) => {
    await unlatch(thread.id);
  });

  registerAutoReviewCli(bb, settings, () => globals);
}
