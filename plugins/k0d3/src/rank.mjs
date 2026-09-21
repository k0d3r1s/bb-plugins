import { tokenize } from "./text.mjs";

const KEYWORD_WEIGHT = 5;
const TOKEN_WEIGHT = 2;
const EXACT_SLUG_BONUS = 10;
const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 25;

/**
 * Clamp a caller-supplied limit into [1, MAX_LIMIT]; non-positive or non-finite
 * values fall back to DEFAULT_LIMIT.
 * @param {unknown} limit
 */
export function clampLimit(limit) {
  const n = Math.trunc(Number(limit));
  if (!Number.isFinite(n) || n < 1) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

/**
 * Score every index entry against a free-text topic and return the best matches.
 * Pure and deterministic: equal scores break by slug ascending, so the same
 * topic always yields the same ranked slugs.
 *
 * @param {ReadonlyArray<import("./rank.mjs").SkillIndexEntry>} entries
 * @param {string} topic
 * @param {number} limit
 * @returns {import("./rank.mjs").RankedSkill[]}
 */
export function rankSkills(entries, topic, limit) {
  const qTokens = tokenize(topic);
  const normalizedTopic = String(topic).trim().toLowerCase();
  const scored = [];
  for (const entry of entries) {
    const keywords = new Set(entry.keywords ?? []);
    const tokens = new Set(entry.tokens ?? []);
    let score = 0;
    for (const q of qTokens) {
      if (keywords.has(q)) score += KEYWORD_WEIGHT;
      else if (tokens.has(q)) score += TOKEN_WEIGHT;
    }
    if (normalizedTopic === entry.slug) score += EXACT_SLUG_BONUS;
    if (score > 0) scored.push({ slug: entry.slug, description: entry.description, score });
  }
  scored.sort((a, b) => (b.score - a.score) || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  return scored.slice(0, clampLimit(limit)).map(({ slug, description }) => ({ slug, description }));
}
