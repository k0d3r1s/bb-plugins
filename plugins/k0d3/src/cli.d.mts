import type { SkillIndex } from "./rank.mjs";

export interface CliResult {
  exitCode: number;
  stdout?: string;
  stderr?: string;
}

export function runK0d3Cli(
  argv: readonly string[],
  deps: {
    index: SkillIndex;
    dataRoot: string;
    requestReview?: (instruction: string) => Promise<boolean>;
  },
): Promise<CliResult>;
