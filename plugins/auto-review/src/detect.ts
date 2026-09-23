import { createHash } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { TreeSnapshot, TurnStart } from "./state.js";

type StatusResult = Awaited<
  ReturnType<BbPluginApi["sdk"]["environments"]["status"]>
>;
export type AvailableWorkspace = Extract<
  StatusResult,
  { outcome: "available" }
>["workspace"];

type TimelineResult = Awaited<
  ReturnType<BbPluginApi["sdk"]["threads"]["timeline"]>
>;
type TimelineRow = TimelineResult["rows"][number];

export async function fetchWorkspace(
  bb: BbPluginApi,
  environmentId: string,
): Promise<AvailableWorkspace | null> {
  const result = await bb.sdk.environments.status({ environmentId });
  return result.outcome === "available" ? result.workspace : null;
}

export async function captureSinceSeq(
  bb: BbPluginApi,
  threadId: string,
): Promise<number> {
  const timeline = await bb.sdk.threads.timeline({ threadId });
  return timeline.maxSeq;
}

function nestedRows(row: TimelineRow): readonly TimelineRow[] {
  if ("childRows" in row && Array.isArray(row.childRows)) {
    return row.childRows;
  }
  if ("children" in row && Array.isArray(row.children)) {
    return row.children;
  }
  return [];
}

function* walkRows(
  rows: readonly TimelineRow[],
): Generator<TimelineRow, void, void> {
  for (const row of rows) {
    yield row;
    yield* walkRows(nestedRows(row));
  }
}

/** The timeline endpoint's own ceiling; asking for more is rejected with a 400. */
export const AUTHORSHIP_SEGMENT_LIMIT = 100;
/** Bounds the walk back through a very long turn: 50 pages of 100 segments. */
export const AUTHORSHIP_MAX_PAGES = 50;

export function authoredPathsFromRows(
  rows: readonly TimelineRow[],
  sinceSeq: number,
): string[] {
  const paths = new Set<string>();
  for (const row of walkRows(rows)) {
    if (
      row.kind === "work" &&
      row.workKind === "file-change" &&
      row.sourceSeqStart > sinceSeq
    ) {
      paths.add(row.change.path);
      if (row.change.movePath !== null) {
        paths.add(row.change.movePath);
      }
    }
  }
  return [...paths];
}

/**
 * Pages back from the latest segment until the page boundary falls at or before
 * the turn-start cursor, so a long turn is not truncated to its last segments.
 */
export async function authoredPaths(
  bb: BbPluginApi,
  threadId: string,
  sinceSeq: number,
): Promise<string[]> {
  const rows = await recentTimelineRows(bb, threadId, (timeline) => {
    const { olderRowsSourceSeqEnd } = timeline.timelinePage;
    return (
      olderRowsSourceSeqEnd === undefined ||
      olderRowsSourceSeqEnd === null ||
      olderRowsSourceSeqEnd > sinceSeq
    );
  });
  return authoredPathsFromRows(rows, sinceSeq);
}

/**
 * Pages a thread's timeline back from the latest segment for as long as
 * `olderMayMatter` says the next older page can still hold relevant rows.
 */
async function recentTimelineRows(
  bb: BbPluginApi,
  threadId: string,
  olderMayMatter: (timeline: TimelineResult) => boolean,
): Promise<TimelineRow[]> {
  const rows: TimelineRow[] = [];
  let before: { anchorId: string; anchorSeq: number } | null = null;
  for (let page = 0; page < AUTHORSHIP_MAX_PAGES; page += 1) {
    const timeline: TimelineResult = await bb.sdk.threads.timeline({
      threadId,
      segmentLimit: String(AUTHORSHIP_SEGMENT_LIMIT),
      includeNestedRows: "true",
      ...(before === null
        ? {}
        : {
            beforeAnchorId: before.anchorId,
            beforeAnchorSeq: String(before.anchorSeq),
          }),
    });
    rows.push(...timeline.rows);
    const { hasOlderRows, olderCursor } = timeline.timelinePage;
    if (!hasOlderRows || olderCursor === null || !olderMayMatter(timeline)) {
      break;
    }
    before = olderCursor;
  }
  return rows;
}

type WorkingTreeFile = AvailableWorkspace["workingTree"]["files"][number];
type ThreadListEntry = Awaited<
  ReturnType<BbPluginApi["sdk"]["threads"]["list"]>
>[number];

/** Content-hash at most this many uncommitted files; the rest compare by line stats alone. */
export const MAX_HASHED_FILES = 200;
const HASH_CONCURRENCY = 8;
/**
 * Commits made during the turn whose files are read back. A longer run is a
 * rebase or a merge of the base, not work to attribute file by file.
 */
export const MAX_NEW_COMMITS = 20;

async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await run(items[index] as T);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return results;
}

function statPart(file: WorkingTreeFile): string {
  return `${file.status}:${file.insertions ?? "-"}:${file.deletions ?? "-"}`;
}

/** An empty string when the content cannot be read (deleted, binary-too-large, a directory). */
async function contentHash(
  bb: BbPluginApi,
  environmentId: string,
  file: WorkingTreeFile,
): Promise<string> {
  if (file.status === "D") {
    return "";
  }
  try {
    const result = await bb.sdk.environments.diffFile({
      environmentId,
      target: "uncommitted",
      path: file.path,
      side: "new",
    });
    return createHash("sha256").update(result.content).digest("hex").slice(0, 16);
  } catch {
    return "";
  }
}

/**
 * Same content unless the line stats differ, or both sides carry a content hash
 * and those differ. A side whose content could not be read compares by stats.
 */
export function fingerprintsMatch(before: string, after: string): boolean {
  const [statBefore, hashBefore = ""] = before.split("|");
  const [statAfter, hashAfter = ""] = after.split("|");
  if (statBefore !== statAfter) {
    return false;
  }
  return hashBefore === "" || hashAfter === "" || hashBefore === hashAfter;
}

function headShaOf(workspace: AvailableWorkspace): string | null {
  const { checkout } = workspace;
  return checkout.kind === "branch" || checkout.kind === "detached"
    ? checkout.headSha
    : null;
}

/**
 * Untracked harness output is left out: it is never attributed anyway, and a
 * checkout full of edit backups would otherwise spend the hash budget on them.
 * Files without line stats (untracked) are hashed first, since for them the
 * hash is the only way to see a rewrite.
 */
export async function snapshotTree(
  bb: BbPluginApi,
  environmentId: string,
  workspace: AvailableWorkspace,
): Promise<TreeSnapshot> {
  const files = workspace.workingTree.files
    .filter((file) => !isHarnessOutput(file))
    .sort(
      (a, b) => Number(a.insertions !== null) - Number(b.insertions !== null),
    );
  const hashes = await mapLimit(
    files.slice(0, MAX_HASHED_FILES),
    HASH_CONCURRENCY,
    (file) => contentHash(bb, environmentId, file),
  );
  return {
    headSha: headShaOf(workspace),
    files: Object.fromEntries(
      files.map((file, index) => [
        file.path,
        `${statPart(file)}|${hashes[index] ?? ""}`,
      ]),
    ),
    commits: workspace.mergeBase?.commits.map((commit) => commit.sha) ?? [],
  };
}

/** Turn-start tree capture that never throws: a failure leaves the timeline to decide alone. */
export async function captureTree(
  bb: BbPluginApi,
  environmentId: string,
): Promise<TreeSnapshot | undefined> {
  try {
    const workspace = await fetchWorkspace(bb, environmentId);
    return workspace === null
      ? undefined
      : await snapshotTree(bb, environmentId, workspace);
  } catch (error) {
    bb.log.warn(
      `auto-review: could not snapshot the working tree of ${environmentId}; this turn is attributed by its timeline alone: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return undefined;
  }
}

async function commitPaths(
  bb: BbPluginApi,
  environmentId: string,
  sha: string,
): Promise<string[]> {
  try {
    const result = await bb.sdk.environments.diffFiles({
      environmentId,
      target: "commit",
      sha,
    });
    if (result.outcome !== "available") {
      return [];
    }
    return result.files.flatMap((file) =>
      file.previousPath === null ? [file.path] : [file.path, file.previousPath],
    );
  } catch {
    return [];
  }
}

/**
 * Paths the working tree shows changed since `before`, however they changed:
 * newly uncommitted, uncommitted with different content, or touched by a
 * commit made during the turn.
 */
export async function treeChangedPaths(
  bb: BbPluginApi,
  environmentId: string,
  before: TreeSnapshot,
  workspace: AvailableWorkspace,
): Promise<string[]> {
  const changed = new Set<string>();
  const recheck: Array<{ file: WorkingTreeFile; prior: string }> = [];
  for (const file of workspace.workingTree.files) {
    const prior = before.files[file.path];
    if (prior === undefined) {
      changed.add(file.path);
    } else if (!fingerprintsMatch(prior, `${statPart(file)}|`)) {
      changed.add(file.path);
    } else if (!prior.endsWith("|")) {
      recheck.push({ file, prior });
    }
  }
  await mapLimit(recheck, HASH_CONCURRENCY, async ({ file, prior }) => {
    const now = `${statPart(file)}|${await contentHash(bb, environmentId, file)}`;
    if (!fingerprintsMatch(prior, now)) {
      changed.add(file.path);
    }
  });

  if (headShaOf(workspace) !== before.headSha) {
    const known = new Set(before.commits);
    const fresh = (workspace.mergeBase?.commits ?? [])
      .filter((commit) => !known.has(commit.sha))
      .slice(0, MAX_NEW_COMMITS);
    const perCommit = await mapLimit(fresh, HASH_CONCURRENCY, (commit) =>
      commitPaths(bb, environmentId, commit.sha),
    );
    for (const path of perCommit.flat()) {
      changed.add(path);
    }
  }
  return [...changed];
}

/** This thread plus every thread it spawned or owns, transitively. */
function ownThreadIds(
  entries: readonly ThreadListEntry[],
  selfThreadId: string,
): Set<string> {
  const own = new Set([selfThreadId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const entry of entries) {
      if (own.has(entry.id)) {
        continue;
      }
      const owners = [entry.parentThreadId, entry.lifecycleOwnerThreadId];
      if (owners.some((owner) => owner !== null && own.has(owner))) {
        own.add(entry.id);
        grew = true;
      }
    }
  }
  return own;
}

function oldestCreatedAt(rows: readonly TimelineRow[]): number | null {
  let oldest: number | null = null;
  for (const row of rows) {
    if ("createdAt" in row && typeof row.createdAt === "number") {
      oldest = oldest === null ? row.createdAt : Math.min(oldest, row.createdAt);
    }
  }
  return oldest;
}

/**
 * Paths another thread in the same checkout changed through its own tools
 * since `startedAt`. A thread that has been idle and untouched since before
 * the turn began cannot have, so its timeline is not read.
 */
export async function siblingAuthoredPaths(
  bb: BbPluginApi,
  entries: readonly ThreadListEntry[],
  selfThreadId: string,
  startedAt: number,
): Promise<Set<string>> {
  const own = ownThreadIds(entries, selfThreadId);
  const siblings = entries.filter(
    (entry) =>
      !own.has(entry.id) &&
      entry.deletedAt === null &&
      (entry.status !== "idle" || entry.updatedAt >= startedAt),
  );
  const paths = new Set<string>();
  for (const sibling of siblings) {
    let rows: TimelineRow[];
    try {
      rows = await recentTimelineRows(bb, sibling.id, (timeline) => {
        const oldest = oldestCreatedAt(timeline.rows);
        return oldest === null || oldest >= startedAt;
      });
    } catch {
      // Gone since it was listed; it has nothing left to review.
      continue;
    }
    for (const row of walkRows(rows)) {
      if (
        row.kind === "work" &&
        row.workKind === "file-change" &&
        row.createdAt >= startedAt
      ) {
        paths.add(row.change.path);
        if (row.change.movePath !== null) {
          paths.add(row.change.movePath);
        }
      }
    }
  }
  return paths;
}

/**
 * Agent-harness state directories. Hooks and harnesses drop untracked files
 * there during every turn (edit backups, logs, memory), so an untracked file
 * the tree alone shows there is harness output, not the turn's work. The
 * thread's own tool edits there still count.
 */
export const HARNESS_STATE_DIRS: readonly string[] = [".claude/", ".codex/", ".bb/"];

function isHarnessOutput(file: WorkingTreeFile): boolean {
  return (
    file.status === "??" &&
    HARNESS_STATE_DIRS.some((dir) => file.path.startsWith(dir))
  );
}

export interface TurnChangeInput {
  threadId: string;
  environmentId: string;
  turnStart: TurnStart;
  workspace: AvailableWorkspace;
  threadEntries: readonly ThreadListEntry[];
}

/**
 * Every path this turn changed. The thread's own `file-change` rows always
 * count. On top of them, whatever the working tree shows changed since turn
 * start counts too — edits from shell commands, scripts and commits leave no
 * such row — except paths a sibling thread in the same checkout changed
 * through its own tools during the turn, which are the sibling's to review.
 */
export async function turnChangedPaths(
  bb: BbPluginApi,
  input: TurnChangeInput,
): Promise<string[]> {
  const { threadId, environmentId, turnStart, workspace } = input;
  const own = await authoredPaths(bb, threadId, turnStart.sinceSeq);
  if (turnStart.tree === undefined) {
    return own;
  }
  const ownSet = new Set(own);
  const harnessOutput = new Set(
    workspace.workingTree.files.filter(isHarnessOutput).map((file) => file.path),
  );
  const unattributed = (
    await treeChangedPaths(bb, environmentId, turnStart.tree, workspace)
  ).filter((path) => !ownSet.has(path) && !harnessOutput.has(path));
  if (unattributed.length === 0) {
    return own;
  }
  const foreign =
    turnStart.startedAt === undefined
      ? new Set<string>()
      : await siblingAuthoredPaths(
          bb,
          input.threadEntries,
          threadId,
          turnStart.startedAt,
        );
  return [...own, ...unattributed.filter((path) => !foreign.has(path))];
}

export function dirtyOrAheadPaths(workspace: AvailableWorkspace): Set<string> {
  const paths = new Set<string>();
  for (const file of workspace.workingTree.files) {
    paths.add(file.path);
  }
  if (workspace.mergeBase !== null) {
    for (const file of workspace.mergeBase.files) {
      paths.add(file.path);
    }
  }
  return paths;
}

export function computeScope(
  authored: readonly string[],
  dirtyOrAhead: ReadonlySet<string>,
): string[] {
  return authored.filter((path) => dirtyOrAhead.has(path));
}

export function mainlineBase(workspace: AvailableWorkspace): string {
  return workspace.mergeBase?.mergeBaseBranch ?? workspace.branch.defaultBranch;
}

export function isBranchCheckout(workspace: AvailableWorkspace): boolean {
  return workspace.checkout.kind === "branch";
}
