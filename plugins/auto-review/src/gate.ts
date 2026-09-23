import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  isStale,
  REVIEW_IN_FLIGHT_PHASES,
  type ThreadState,
} from "./state.js";

export interface GateThread {
  parentThreadId: string | null;
  originPluginId: string | null;
  visibility: string;
  environmentId: string | null;
}

export function passesThreadGate(thread: GateThread): boolean {
  if (thread.parentThreadId !== null) {
    return false;
  }
  if (thread.originPluginId !== null) {
    return false;
  }
  if (thread.visibility !== "visible") {
    return false;
  }
  if (thread.environmentId === null) {
    return false;
  }
  return true;
}

const BUSY_STATUSES = new Set(["active", "starting", "stopping"]);

type ThreadListEntry = Awaited<
  ReturnType<BbPluginApi["sdk"]["threads"]["list"]>
>[number];

export function isBusyStatus(status: string): boolean {
  return BUSY_STATUSES.has(status);
}

/**
 * Whether another user coding thread is running in this checkout right now.
 * That never holds a review back, but the steps that need the tree to
 * themselves — continuing the plan, and the local merge, which switches
 * branches under whoever else is working here — are dropped. Hidden,
 * plugin-origin and child threads (an advisor, a subagent) belong to some
 * coding thread's own turn and do not count.
 */
export function hasBusyCodingSibling(
  entries: readonly ThreadListEntry[],
  selfThreadId: string,
): boolean {
  return entries.some(
    (entry) =>
      entry.id !== selfThreadId &&
      isBusyStatus(entry.status) &&
      passesThreadGate(entry),
  );
}

export function selfIsWorktree(
  entries: readonly ThreadListEntry[],
  selfThreadId: string,
): boolean {
  const self = entries.find((entry) => entry.id === selfThreadId);
  return self?.environmentIsWorktree === true;
}

export interface SiblingReview {
  id: string;
  state: ThreadState;
  busy: boolean;
}

/**
 * Whether this sibling's own auto-review is queued or running. That is the only
 * thing that parks another thread's turn: plain activity in the checkout does
 * not, because every review stages just the files its own turn authored. A
 * latch past the stale window on a thread that is no longer busy is a lost
 * idle, not a review, so it does not count — one missed event must not park
 * every other thread in the checkout for good. A latch with no dispatch time
 * on an idle thread cannot be dated at all, so it is treated the same way.
 */
export function reviewInFlight(sibling: SiblingReview, now: number): boolean {
  if (!REVIEW_IN_FLIGHT_PHASES.includes(sibling.state.phase)) {
    return false;
  }
  if (sibling.busy) {
    return true;
  }
  return sibling.state.dispatchedAt !== undefined && !isStale(sibling.state, now);
}

export function hasReviewInFlight(
  siblings: readonly SiblingReview[],
  now: number,
): boolean {
  return siblings.some((sibling) => reviewInFlight(sibling, now));
}

/**
 * Which deferred sibling — if any — may start its review now. At most one: the
 * thread released here latches its own review immediately, and that review's
 * idle drives the next release.
 */
export function pickDeferredRelease(
  siblings: readonly SiblingReview[],
  now: number,
): string | null {
  if (hasReviewInFlight(siblings, now)) {
    return null;
  }
  return siblings.find((s) => s.state.phase === "deferred")?.id ?? null;
}
