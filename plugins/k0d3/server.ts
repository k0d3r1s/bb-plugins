import { readFile } from "node:fs/promises";
import path from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { rankSkills } from "./src/rank.mjs";
import type { SkillIndex, SkillIndexEntry } from "./src/rank.mjs";
import { loadSkill } from "./src/loader.mjs";
import { runK0d3Cli } from "./src/cli.mjs";
import { fetchDocs } from "./src/docs.mjs";
import { selectSkills } from "./src/select-skills.mjs";

/**
 * The committed `content/` tree (skill bodies, references, index.json) is the
 * single runtime data source — this works for every install path: run from
 * source (server.ts in the plugin root) or from a bundle (dist/server.js).
 */
export function resolveDataRoot(moduleDir: string): string {
  const root = path.basename(moduleDir) === "dist" ? path.dirname(moduleDir) : moduleDir;
  return path.join(root, "content");
}

const EMPTY_INDEX: SkillIndex = { generatedAt: "", categories: [], skills: [] };

function isEntry(value: unknown): value is SkillIndexEntry {
  if (value === null || typeof value !== "object") return false;
  const e = value as Record<string, unknown>;
  return typeof e.slug === "string" && typeof e.description === "string";
}

export async function loadIndex(dataRoot: string, warn: (message: string) => void): Promise<SkillIndex> {
  try {
    const raw = await readFile(path.join(dataRoot, "index.json"), "utf8");
    const parsed = JSON.parse(raw) as Partial<SkillIndex>;
    if (!Array.isArray(parsed.skills)) throw new Error("index.json has no skills array");
    return {
      generatedAt: typeof parsed.generatedAt === "string" ? parsed.generatedAt : "",
      categories: Array.isArray(parsed.categories) ? parsed.categories.filter((c): c is string => typeof c === "string") : [],
      skills: parsed.skills.filter(isEntry),
    };
  } catch (error) {
    warn(
      `k0d3: could not load skill index at ${dataRoot}/index.json — find/load tools will be empty: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return EMPTY_INDEX;
  }
}

type ToolResult = string | { content: { type: "text"; text: string }[]; isError?: boolean };

interface ToolSpec {
  name: string;
  description: string;
  instructions: string;
  parameters: z.ZodTypeAny;
  execute: (args: Record<string, unknown>, ctx?: { signal?: AbortSignal }) => Promise<ToolResult>;
}

/** The k0d3_docs tool, factored out with an injectable fetch so its ok/error mapping is unit-testable. */
export function buildDocsToolSpec(opts: { fetchImpl?: typeof fetch } = {}): ToolSpec {
  return {
    name: "k0d3_docs",
    description:
      "Look up current library/framework documentation via Context7 (k0d3's bundled docs lookup). " +
      "Search with `query`, or fetch a library's docs with `libraryId` (e.g. \"/vercel/next.js\").",
    instructions: "For up-to-date library/API docs, prefer k0d3_docs over guessing from memory.",
    parameters: z
      .object({
        query: z.string().min(1).max(200).optional(),
        libraryId: z.string().min(1).max(120).optional(),
      })
      .refine((d) => d.query !== undefined || d.libraryId !== undefined, {
        message: "Provide query or libraryId.",
      }),
    async execute(args, ctx) {
      const { query, libraryId } = args as { query?: string; libraryId?: string };
      const fetchOpts: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {};
      if (ctx?.signal) fetchOpts.signal = ctx.signal;
      if (opts.fetchImpl) fetchOpts.fetchImpl = opts.fetchImpl;
      const result = await fetchDocs({ query, libraryId }, fetchOpts);
      return result.ok ? result.content : { content: [{ type: "text", text: result.message }], isError: true };
    },
  };
}

/** Build the two tool specs. Pure over (index, dataRoot) so it can be unit-tested without bb. */
export function buildToolSpecs(index: SkillIndex, dataRoot: string): ToolSpec[] {
  const categoryHint = index.categories.length > 0 ? ` Domains covered: ${index.categories.join(", ")}.` : "";
  const emptyIndexNote = index.skills.length === 0
    ? " (the k0d3 skill index is currently empty — its data may have failed to load)"
    : "";

  return [
    {
      name: "k0d3_find_skills",
      description:
        `Locate k0d3 skills relevant to a topic. Returns ranked slugs + descriptions; ` +
        `then load a body with k0d3_load_skill. Call before answering from memory on any ` +
        `domain/language/tooling task.${categoryHint}`,
      instructions:
        "For domain/language/tooling guidance, call k0d3_find_skills then k0d3_load_skill. " +
        "Do not answer from memory when a k0d3 skill covers it.",
      parameters: z.object({
        topic: z.string().min(1).max(200),
        limit: z.number().int().min(1).max(25).default(8),
      }),
      async execute(args) {
        const { topic, limit } = args as { topic: string; limit?: number };
        const hits = rankSkills(index.skills, topic, limit ?? 8);
        if (hits.length === 0) {
          const domains = index.categories.length > 0 ? ` Domains: ${index.categories.join(", ")}.` : "";
          return `No k0d3 skill matched "${topic}"${emptyIndexNote}. Try a broader term.${domains}`;
        }
        const lines = hits.map((h) => `- ${h.slug}: ${h.description}`);
        return `k0d3 skills for "${topic}" (load with k0d3_load_skill):\n${lines.join("\n")}`;
      },
    },
    {
      name: "k0d3_load_skill",
      description:
        "Load one k0d3 skill body by slug, or one named shared reference file (pass `reference`). " +
        "Discover slugs with k0d3_find_skills first.",
      instructions:
        "After k0d3_find_skills names a slug, call k0d3_load_skill to read its body before acting; " +
        "read a reference the body cites by passing that reference name.",
      parameters: z
        .object({
          slug: z.string().min(1).max(64).optional(),
          reference: z.string().min(1).max(64).optional(),
        })
        .refine((d) => d.slug !== undefined || d.reference !== undefined, {
          message: "Provide slug or reference.",
        }),
      async execute(args) {
        const { slug, reference } = args as { slug?: string; reference?: string };
        const result = await loadSkill(dataRoot, slug, reference);
        if (!result.ok) {
          return { content: [{ type: "text", text: result.message }], isError: true };
        }
        return result.content;
      },
    },
  ];
}

export default async function plugin(bb: BbPluginApi): Promise<void> {
  const dataRoot = resolveDataRoot(import.meta.dirname);
  const index = await loadIndex(dataRoot, (m) => bb.log.warn(m));
  for (const spec of buildToolSpecs(index, dataRoot)) {
    bb.agents.registerTool(spec);
  }

  bb.agents.registerTool(buildDocsToolSpec());

  bb.agents.contributeInstructions(
    () =>
      "k0d3 is available: call k0d3_find_skills for domain/language/tooling guidance before " +
      "answering from memory, then k0d3_load_skill to read the chosen skill.",
  );

  // Tier-C: keep all tools active; surface Tier-A always, plus the curated essentials for
  // non-side-chat threads. configure() replaces the default selection, so tools are listed explicitly.
  bb.agents.configure((context) => ({
    tools: ["k0d3_find_skills", "k0d3_load_skill", "k0d3_docs"],
    skills: selectSkills(context),
  }));

  bb.cli.register({
    name: "k0d3",
    summary: "Browse the k0d3 skill library and run calibrated reviews / command workflows",
    commands: [
      { name: "review", summary: "Run the calibrated review (injects a review turn in-thread, else prints instructions)", usage: "bb k0d3 review <code|impl <base>..<head>|plan <path>>" },
      { name: "commands", summary: "List the ported k0d3 command workflows", usage: "bb k0d3 commands" },
      { name: "run", summary: "Print instructions to run a command workflow", usage: "bb k0d3 run <command> [args...]" },
      { name: "skills", summary: "Browse the skill library", usage: "bb k0d3 skills <list|find <topic>|show <slug>>" },
    ],
    run: (argv, ctx) =>
      runK0d3Cli(argv, {
        index,
        dataRoot,
        requestReview: async (instruction) => {
          const threadId = ctx?.threadId;
          if (threadId === undefined || threadId === null) return false;
          await bb.sdk.threads.send({
            threadId,
            mode: "auto",
            input: [{ type: "text", text: instruction, mentions: [] }],
          });
          return true;
        },
      }),
  });
}
