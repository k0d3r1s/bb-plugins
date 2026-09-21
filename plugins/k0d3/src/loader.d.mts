export const SLUG_RE: RegExp;
export const REFERENCE_RE: RegExp;
export const MAX_BODY_BYTES: number;

export type LoadResult =
  | { ok: true; slug: string | null; reference: string | null; content: string; truncated: boolean }
  | { ok: false; code: "invalid_slug" | "invalid_reference" | "out_of_bounds" | "not_found" | "read_failed"; message: string };

export function loadSkill(dataRoot: string, slug?: string, reference?: string): Promise<LoadResult>;
