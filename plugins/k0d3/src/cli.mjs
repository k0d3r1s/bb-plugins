import { rankSkills } from "./rank.mjs";
import { loadSkill } from "./loader.mjs";

const REVIEW_MODES = new Set(["code", "impl", "plan"]);

const USAGE = [
  "Usage: bb k0d3 <command>",
  "  review <code | impl <base>..<head> | plan <path>>  Print agent instructions to run the calibrated review",
  "  skills list                                        List every k0d3 skill (slug: description)",
  "  skills find <topic>                                Rank skills relevant to a topic",
  "  skills show <slug>                                 Print one skill body",
].join("\n");

function reviewInstruction(mode, target) {
  const scope = mode === "code"
    ? "the uncommitted changes in this checkout"
    : mode === "impl"
      ? `the diff for range ${target}`
      : `the plan document at ${target}`;
  return [
    "[k0d3 review — instructions for a coding agent to run; this command prints the workflow, it does not produce the review itself]",
    "",
    `Run the k0d3 calibrated review over ${scope}.`,
    "Load the workflow with k0d3_load_skill({ slug: \"review-code\" }) and follow it:",
    "apply the four reviewer lenses, consolidate into Blockers/Concerns/Advisories/Verdict, then disposition.",
  ].join("\n");
}

/**
 * Dispatch a `bb k0d3 ...` invocation. Pure over its deps so it is unit-testable without bb.
 * @param {readonly string[]} argv argv with the top-level command name already stripped
 * @param {{ index: import("./rank.mjs").SkillIndex, dataRoot: string }} deps
 * @returns {Promise<{ exitCode: number, stdout?: string, stderr?: string }>}
 */
export async function runK0d3Cli(argv, deps) {
  const [command, ...rest] = argv;

  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    return { exitCode: 0, stdout: `${USAGE}\n` };
  }

  if (command === "review") {
    const [mode, target] = rest;
    if (mode === undefined || !REVIEW_MODES.has(mode)) {
      return { exitCode: 2, stderr: `review needs a mode: code | impl <base>..<head> | plan <path>\n` };
    }
    if ((mode === "impl" || mode === "plan") && (target === undefined || target.length === 0)) {
      const need = mode === "impl" ? "<base>..<head>" : "<path>";
      return { exitCode: 2, stderr: `review ${mode} needs ${need}\n` };
    }
    if (mode === "impl" && !target.includes("..")) {
      return { exitCode: 2, stderr: `review impl needs a range like <base>..<head> (got '${target}')\n` };
    }
    return { exitCode: 0, stdout: `${reviewInstruction(mode, target)}\n` };
  }

  if (command === "skills") {
    const [sub, ...args] = rest;
    if (sub === "list") {
      const lines = deps.index.skills
        .map((s) => `${s.slug}: ${s.description}`)
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      return { exitCode: 0, stdout: `${lines.join("\n")}\n` };
    }
    if (sub === "find") {
      const topic = args.join(" ").trim();
      if (topic.length === 0) return { exitCode: 2, stderr: "skills find needs a topic\n" };
      const hits = rankSkills(deps.index.skills, topic, 15);
      if (hits.length === 0) return { exitCode: 0, stdout: `No k0d3 skill matched "${topic}".\n` };
      return { exitCode: 0, stdout: `${hits.map((h) => `${h.slug}: ${h.description}`).join("\n")}\n` };
    }
    if (sub === "show") {
      const slug = args[0];
      if (slug === undefined) return { exitCode: 2, stderr: "skills show needs a slug\n" };
      const result = await loadSkill(deps.dataRoot, slug);
      if (!result.ok) return { exitCode: 1, stderr: `${result.message}\n` };
      return { exitCode: 0, stdout: result.content.endsWith("\n") ? result.content : `${result.content}\n` };
    }
    return { exitCode: 2, stderr: `unknown skills subcommand.\n${USAGE}\n` };
  }

  return { exitCode: 2, stderr: `unknown command '${command}'.\n${USAGE}\n` };
}
