import { readFile } from "node:fs/promises";
import path from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { rankSkills } from "./src/rank.mjs";
import type { SkillIndex, SkillIndexEntry } from "./src/rank.mjs";
import { loadSkill } from "./src/loader.mjs";

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

interface ToolSpec {
  name: string;
  description: string;
  instructions: string;
  parameters: z.ZodTypeAny;
  execute: (args: Record<string, unknown>) => Promise<string | { content: { type: "text"; text: string }[]; isError?: boolean }>;
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
}
