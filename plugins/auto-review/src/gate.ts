import type { BbPluginApi } from "@get-bb/plugin-sdk";

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
