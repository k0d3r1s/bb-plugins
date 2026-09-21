export interface DecideInput {
  base: string | null;
  currentBranch: string | null;
  isDedicatedWorktree: boolean;
  mergeEligibleMainlines: readonly string[];
}

export interface Decision {
  commit: boolean;
  merge: boolean;
}

export function isPersonalMainline(input: DecideInput): boolean {
  return input.base !== null && input.mergeEligibleMainlines.includes(input.base);
}

export function decide(input: DecideInput): Decision {
  const personal = isPersonalMainline(input);
  const onMainline =
    input.currentBranch !== null && input.currentBranch === input.base;
  // Merge a feature branch into a personal mainline (e.g. master) in a dedicated
  // worktree or the primary checkout alike — a worktree is not required. The merge
  // is local-only and its working-tree-safety guard lives in the injected prompt,
  // not in a worktree precondition. A non-personal mainline (e.g. main) is never a
  // merge target. commit still depends on isDedicatedWorktree, just below.
  const merge = personal && !onMainline;
  const commit = input.isDedicatedWorktree || personal;
  return { commit, merge };
}
