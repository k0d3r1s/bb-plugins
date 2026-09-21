import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { tokenize } from "../src/text.mjs";
import { SLUG_RE } from "../src/loader.mjs";
import { ESSENTIALS } from "../src/select-skills.mjs";

const MAX_DESCRIPTION = 1024;

function parseFrontmatter(text) {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("---")) return null;
  const end = trimmed.indexOf("\n---", 3);
  if (end < 0) return null;
  const block = trimmed.slice(3, end + 1);
  const data = yaml.load(block);
  return data && typeof data === "object" ? data : null;
}

function categoryOf(slug, fm) {
  const type = fm?.metadata?.type;
  if (typeof type === "string" && type.trim().length > 0) return type.trim();
  const prefix = slug.split("-")[0];
  return prefix.length >= 2 ? prefix : "misc";
}

function normalizeKeywords(fm) {
  const raw = fm?.metadata?.keywords;
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.flatMap((k) => tokenize(String(k))))];
}

/**
 * Build the searchable skill index from `<contentDir>/skills/<slug>/SKILL.md`.
 * Re-validates Tier-B frontmatter (bb's own validator never sees these files),
 * failing loudly on any violation.
 *
 * @param {string} contentDir
 * @returns {Promise<{ entries: object[], categories: string[], errors: string[] }>}
 */
export async function buildIndex(contentDir) {
  const skillsDir = path.join(contentDir, "skills");
  const errors = [];
  const entries = [];
  const seen = new Map();

  let dirents;
  try {
    dirents = await readdir(skillsDir, { withFileTypes: true });
  } catch {
    return { entries, categories: [], errors: [`content skills dir missing: ${skillsDir}`] };
  }

  for (const dirent of dirents.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (!dirent.isDirectory()) continue;
    const slug = dirent.name;
    const file = path.join(skillsDir, slug, "SKILL.md");
    let text;
    try {
      text = await readFile(file, "utf8");
    } catch {
      errors.push(`${slug}: missing SKILL.md`);
      continue;
    }
    let fm;
    try {
      fm = parseFrontmatter(text);
    } catch (error) {
      errors.push(`${slug}: unparseable frontmatter (${error instanceof Error ? error.message : String(error)})`);
      continue;
    }
    if (fm === null) {
      errors.push(`${slug}: no frontmatter block`);
      continue;
    }
    const name = typeof fm.name === "string" ? fm.name : "";
    const description = typeof fm.description === "string" ? fm.description.trim() : "";
    if (name !== slug) errors.push(`${slug}: frontmatter name '${name}' must equal directory name`);
    if (!SLUG_RE.test(slug)) errors.push(`${slug}: slug violates the name pattern`);
    if (description.length === 0) errors.push(`${slug}: empty description`);
    if (description.length > MAX_DESCRIPTION) errors.push(`${slug}: description exceeds ${MAX_DESCRIPTION} chars`);
    if (seen.has(slug)) errors.push(`${slug}: duplicate slug`);
    seen.set(slug, true);

    const keywords = normalizeKeywords(fm);
    const category = categoryOf(slug, fm);
    const tokens = [...new Set([...tokenize(slug), ...tokenize(description), ...keywords])];
    entries.push({ slug, description, category, keywords, tokens });
  }

  const categories = [...new Set(entries.map((e) => e.category))].sort();
  return { entries, categories, errors };
}

/** Author-time CLI: regenerate the committed content/index.json, failing loudly on any validation error. */
async function main() {
  const contentDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "content");
  const { entries, categories, errors } = await buildIndex(contentDir);
  if (errors.length > 0) {
    console.error(`k0d3 build-index: ${errors.length} skill validation error(s):`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  const index = { generatedAt: new Date().toISOString(), categories, skills: entries };
  await writeFile(path.join(contentDir, "index.json"), `${JSON.stringify(index, null, 0)}\n`, "utf8");

  // Tier-C: generate the curated essentials as native skills from their content/ bodies.
  const genRoot = path.resolve(contentDir, "..", "skills-generated");
  await rm(genRoot, { recursive: true, force: true });
  for (const slug of ESSENTIALS) {
    const src = path.join(contentDir, "skills", slug, "SKILL.md");
    const dst = path.join(genRoot, slug, "SKILL.md");
    await mkdir(path.dirname(dst), { recursive: true });
    await cp(src, dst);
  }
  console.log(
    `k0d3 build-index: wrote content/index.json (${entries.length} skills, ${categories.length} categories) + ${ESSENTIALS.length} native essentials`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`k0d3 build-index failed: ${error instanceof Error ? error.stack : String(error)}`);
    process.exit(1);
  });
}
