/** Hand-authored always-on native skills. */
export const TIER_A = ["using-devkit", "honest-completion"];

/**
 * Tier-C: a small curated essentials set promoted to native skills (generated into
 * skills-generated/ from the content/ bodies at build time) so the most common guidance is
 * discoverable without a devkit_find_skills round-trip. Kept tiny to preserve "locate, not autoload".
 */
export const ESSENTIALS = [
  "go-essentials",
  "python-essentials",
  "typescript",
  "security",
  "testing-strategy",
  "debugging",
];

/**
 * Context-aware native-skill selection for bb.agents.configure. Always surfaces Tier-A; adds the
 * essentials for normal threads but not side-chats (forks), which want a minimal surface.
 *
 * @param {{ origin?: { kind?: string | null } | null } | undefined} ctx
 * @returns {string[]}
 */
export function selectSkills(ctx) {
  const isFork = ctx?.origin?.kind === "fork";
  return isFork ? [...TIER_A] : [...TIER_A, ...ESSENTIALS];
}
