import { execFileSync } from "node:child_process";
import { appendFileSync, readdirSync, readFileSync, existsSync } from "node:fs";

const BUMP_RANK = { patch: 1, minor: 2, major: 3 };
const VALID_BUMPS = new Set(["patch", "minor", "major", "prerelease"]);

const onlyPlugin = (process.env.ONLY_PLUGIN ?? "").trim();
const forcedBump = (process.env.FORCED_BUMP ?? "").trim();
if (forcedBump && !VALID_BUMPS.has(forcedBump)) {
  console.error(`Invalid release_type "${forcedBump}" (expected ${[...VALID_BUMPS].join(", ")}).`);
  process.exit(1);
}

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();

function latestTag(id) {
  const tags = git("tag", "--list", `${id}/v*`, "--sort=-v:refname")
    .split("\n")
    .map((t) => t.trim())
    .filter(Boolean);
  return tags[0] ?? null;
}

function pluginChangedSince(id, tag) {
  if (!tag) return true;
  try {
    execFileSync("git", ["diff", "--quiet", tag, "HEAD", "--", `plugins/${id}`]);
    return false;
  } catch {
    return true;
  }
}

function inferBump(id, tag) {
  if (forcedBump) return forcedBump;
  const range = tag ? `${tag}..HEAD` : "HEAD";
  const subjects = git("log", range, "--format=%s", "--", `plugins/${id}`)
    .split("\n")
    .filter(Boolean);
  let best = 0;
  for (const s of subjects) {
    const m = s.match(/\[(patch|minor|major)\]/i);
    if (m) best = Math.max(best, BUMP_RANK[m[1].toLowerCase()]);
  }
  // A normal commit cuts a patch; minor/major must be opted into with a
  // [minor]/[major] marker. prerelease is reachable only via a manual dispatch.
  return best ? Object.keys(BUMP_RANK)[best - 1] : "patch";
}

const pluginsDir = "plugins";
const selected = [];
for (const entry of readdirSync(pluginsDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const id = entry.name;
  if (onlyPlugin && id !== onlyPlugin) continue;
  const pkgPath = `${pluginsDir}/${id}/package.json`;
  if (!existsSync(pkgPath)) continue;
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));

  const tag = latestTag(id);
  const forced = onlyPlugin === id || Boolean(forcedBump);
  if (!forced && !pluginChangedSince(id, tag)) continue;

  selected.push({ id, dir: `${pluginsDir}/${id}`, name: pkg.name, bump: inferBump(id, tag) });
}

const matrix = JSON.stringify(selected);
const any = selected.length > 0 ? "true" : "false";
console.log(`Selected ${selected.length} plugin(s): ${selected.map((p) => `${p.id}(${p.bump})`).join(", ") || "none"}`);

const out = process.env.GITHUB_OUTPUT;
if (out) {
  appendFileSync(out, `matrix=${matrix}\n`);
  appendFileSync(out, `any=${any}\n`);
}
