export interface SkillIndexEntry {
  slug: string;
  description: string;
  category: string;
  keywords: string[];
  tokens: string[];
}

export interface SkillIndex {
  generatedAt: string;
  categories: string[];
  skills: SkillIndexEntry[];
}

export interface RankedSkill {
  slug: string;
  description: string;
}

export function clampLimit(limit: unknown): number;

export function rankSkills(
  entries: readonly SkillIndexEntry[],
  topic: string,
  limit: number,
): RankedSkill[];
