import type { SkillIndex } from "./rank.mjs";

export interface CliResult {
  exitCode: number;
  stdout?: string;
  stderr?: string;
}

export function runDevkitCli(
  argv: readonly string[],
  deps: {
    index: SkillIndex;
    dataRoot: string;
    injectInstruction?: (instruction: string) => Promise<boolean>;
  },
): Promise<CliResult>;
