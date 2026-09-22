import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { REVIEW_IN_FLIGHT_PHASES, type AutoReviewPhase } from "./state.js";

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

export function hasActiveSibling(
  entries: readonly ThreadListEntry[],
  selfThreadId: string,
): boolean {
  return entries.some(
    (entry) => entry.id !== selfThreadId && BUSY_STATUSES.has(entry.status),
  );
}

export function selfIsWorktree(
  entries: readonly ThreadListEntry[],
  selfThreadId: string,
): boolean {
  const self = entries.find((entry) => entry.id === selfThreadId);
  return self?.environmentIsWorktree === true;
}

export interface SiblingPhase {
  id: string;
  phase: AutoReviewPhase;
}

/**
 * Which deferred sibling — if any — may take the now-quiet checkout.
 *
 * At most one: the thread released here immediately occupies the environment,
 * and its own idle drives the next release. A sibling whose review is already
 * queued or in flight vetoes the whole sweep — that review is about to write
 * to this tree even though no thread reads as busy yet.
 */
export function hasReviewInFlight(
  siblings: readonly SiblingPhase[],
): boolean {
  return siblings.some((s) => REVIEW_IN_FLIGHT_PHASES.includes(s.phase));
}

export function pickDeferredRelease(
  siblings: readonly SiblingPhase[],
): string | null {
  if (hasReviewInFlight(siblings)) {
    return null;
  }
  return siblings.find((s) => s.phase === "deferred")?.id ?? null;
}
