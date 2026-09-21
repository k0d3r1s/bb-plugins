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
  const merge = input.isDedicatedWorktree && personal && !onMainline;
  const commit = input.isDedicatedWorktree || personal;
  return { commit, merge };
}
