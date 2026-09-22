export const CONTEXT7_BASE: string;
export const MAX_DOCS_BYTES: number;

export type DocsResult =
  | { ok: true; url: string; content: string }
  | { ok: false; message: string };

export function fetchDocs(
  input: { query?: string; libraryId?: string },
  opts?: { base?: string; fetchImpl?: typeof fetch; maxBytes?: number; signal?: AbortSignal },
): Promise<DocsResult>;
