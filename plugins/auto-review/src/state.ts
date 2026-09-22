import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const AUTO_REVIEW_PHASES = [
  "idle",
  "deferred",
  "pending-dispatch",
  "awaiting-review",
] as const;
export type AutoReviewPhase = (typeof AUTO_REVIEW_PHASES)[number];

/** Phases where a review turn is already queued or in flight for a thread. */
export const REVIEW_IN_FLIGHT_PHASES: readonly AutoReviewPhase[] = [
  "pending-dispatch",
  "awaiting-review",
];

export const STALE_WINDOW_MS = 30 * 60 * 1_000;

/**
 * How long a turn may sit deferred behind a busy sibling before auto-review
 * gives up on a quiet tree and fires a contention-aware review instead.
 *
 * Independent of STALE_WINDOW_MS despite the matching value — that one bounds a
 * dispatch that may never have landed, this one bounds a wait for a quiet
 * checkout. Nothing relies on them being equal; change either alone.
 */
export const DEFER_WINDOW_MS = 30 * 60 * 1_000;

export const turnStartSchema = z.object({
  sinceSeq: z.number().int().nonnegative(),
});
export type TurnStart = z.infer<typeof turnStartSchema>;

export const threadStateSchema = z.object({
  phase: z.enum(AUTO_REVIEW_PHASES).default("idle"),
  turnStart: turnStartSchema.optional(),
  pendingEntryId: z.string().optional(),
  dispatchedAt: z.number().optional(),
  deferredSince: z.number().optional(),
  skip: z.literal(true).optional(),
});
export type ThreadState = z.infer<typeof threadStateSchema>;

export const IDLE_STATE: ThreadState = { phase: "idle" };

const locks = new Map<string, Promise<unknown>>();

export function withThreadLock<T>(
  threadId: string,
  run: () => Promise<T>,
): Promise<T> {
  const previous = locks.get(threadId) ?? Promise.resolve();
  const next = previous.then(run, run);
  const settled = next.then(
    () => undefined,
    () => undefined,
  );
  locks.set(threadId, settled);
  void settled.then(() => {
    if (locks.get(threadId) === settled) {
      locks.delete(threadId);
    }
  });
  return next;
}

export async function readState(
  bb: BbPluginApi,
  threadId: string,
): Promise<ThreadState> {
  const raw = await bb.sdk.threads.getPluginMetadata({ threadId });
  const parsed = threadStateSchema.safeParse(raw);
  if (parsed.success) {
    return parsed.data;
  }
  if (raw !== null && typeof raw === "object" && Object.keys(raw).length > 0) {
    bb.log.warn(
      `auto-review: discarding unparseable thread state for ${threadId}; resetting the loop-guard to idle`,
    );
  }
  return { ...IDLE_STATE };
}

type MetadataSet = NonNullable<
  Parameters<BbPluginApi["sdk"]["threads"]["updatePluginMetadata"]>[0]["set"]
>;

export async function writeState(
  bb: BbPluginApi,
  threadId: string,
  set: Partial<ThreadState>,
  remove?: string[],
): Promise<void> {
  await bb.sdk.threads.updatePluginMetadata({
    threadId,
    set: set as unknown as MetadataSet,
    ...(remove === undefined ? {} : { remove }),
  });
}

export const LATCH_KEYS: readonly string[] = [
  "turnStart",
  "pendingEntryId",
  "dispatchedAt",
  "deferredSince",
];

export function resetToIdlePatch(): {
  set: Partial<ThreadState>;
  remove: string[];
} {
  return { set: { phase: "idle" }, remove: [...LATCH_KEYS] };
}

function elapsedBeyond(
  since: number | undefined,
  now: number,
  window: number,
): boolean {
  return since !== undefined && now - since > window;
}

export function isStale(state: ThreadState, now: number): boolean {
  return (
    state.phase !== "idle" &&
    elapsedBeyond(state.dispatchedAt, now, STALE_WINDOW_MS)
  );
}

/**
 * True once a deferred turn has waited out the defer window. Waiting is the
 * preferred answer to a contended checkout, but a sibling that never goes idle
 * must not strand the review forever — past this point auto-review fires a
 * contention-aware review rather than keeping the turn queued indefinitely.
 */
export function deferralExpired(state: ThreadState, now: number): boolean {
  return elapsedBeyond(state.deferredSince, now, DEFER_WINDOW_MS);
}
