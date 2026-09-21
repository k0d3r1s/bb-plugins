import type { BbPluginApi } from "@get-bb/plugin-sdk";

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

export const AUTHORSHIP_SEGMENT_LIMIT = 1000;

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

export async function authoredPaths(
  bb: BbPluginApi,
  threadId: string,
  sinceSeq: number,
): Promise<string[]> {
  const timeline = await bb.sdk.threads.timeline({
    threadId,
    segmentLimit: String(AUTHORSHIP_SEGMENT_LIMIT),
    includeNestedRows: "true",
  });
  return authoredPathsFromRows(timeline.rows, sinceSeq);
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
