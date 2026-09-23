import { describe, expect, it, vi } from "vitest";
import { fetchDocs, MAX_DOCS_BYTES } from "./docs.mjs";

function fakeFetch(body: string, ok = true, status = 200) {
  return vi.fn(async (_url: string, _init?: unknown) => ({ ok, status, text: async () => body })) as unknown as typeof fetch;
}

describe("fetchDocs", () => {
  it("builds a search URL from a query", async () => {
    const fetchImpl = fakeFetch("results");
    const r = await fetchDocs({ query: "next.js routing" }, { base: "https://x/api", fetchImpl });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.url).toBe("https://x/api/search?query=next.js%20routing");
  });

  it("builds a docs URL from a libraryId, encoding each path segment", async () => {
    const fetchImpl = fakeFetch("docs");
    const r = await fetchDocs({ libraryId: "vercel/next.js" }, { base: "https://x/api", fetchImpl });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.url).toBe("https://x/api/vercel/next.js?type=txt");
  });

  it("accepts the canonical leading-slash Context7 id without doubling the slash", async () => {
    const fetchImpl = fakeFetch("docs");
    const r = await fetchDocs({ libraryId: "/vercel/next.js" }, { base: "https://x/api", fetchImpl });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.url).toBe("https://x/api/vercel/next.js?type=txt");
  });

  it("libraryId takes precedence when both are supplied", async () => {
    const fetchImpl = fakeFetch("docs");
    const r = await fetchDocs({ query: "q", libraryId: "vercel/next.js" }, { base: "https://x/api", fetchImpl });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.url).toContain("/vercel/next.js?type=txt");
  });

  it("rejects a libraryId with .. or empty segments before fetching", async () => {
    const fetchImpl = fakeFetch("nope");
    for (const libraryId of ["../../search", "a/../b", "a//b", "..", "has space", "/", "//vercel/next.js", "/../search"]) {
      expect((await fetchDocs({ libraryId }, { fetchImpl })).ok).toBe(false);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("accepts natural-language query punctuation but rejects control chars", async () => {
    const fetchImpl = fakeFetch("ok");
    expect((await fetchDocs({ query: "how do I use hooks? next.js's router" }, { base: "https://x/api", fetchImpl })).ok).toBe(true);
    expect((await fetchDocs({ query: "bad\nnewline" }, { fetchImpl })).ok).toBe(false);
  });

  it("requires at least one of query/libraryId", async () => {
    expect((await fetchDocs({}, { fetchImpl: fakeFetch("") })).ok).toBe(false);
  });

  it("forwards the abort signal to fetch", async () => {
    const fetchImpl = fakeFetch("ok");
    const controller = new AbortController();
    await fetchDocs({ query: "x" }, { base: "https://x/api", fetchImpl, signal: controller.signal });
    expect(fetchImpl).toHaveBeenCalledWith(expect.any(String), { signal: controller.signal });
  });

  it("surfaces a non-OK status, a network error, and a body-read error uniformly", async () => {
    expect((await fetchDocs({ query: "x" }, { base: "https://x/api", fetchImpl: fakeFetch("", false, 503) })).ok).toBe(false);
    const thrower = vi.fn(async () => { throw new Error("boom"); }) as unknown as typeof fetch;
    expect((await fetchDocs({ query: "x" }, { base: "https://x/api", fetchImpl: thrower })).ok).toBe(false);
    const badBody = vi.fn(async () => ({ ok: true, status: 200, text: async () => { throw new Error("reset"); } })) as unknown as typeof fetch;
    expect((await fetchDocs({ query: "x" }, { base: "https://x/api", fetchImpl: badBody })).ok).toBe(false);
  });

  it("byte-caps an oversized response but not one exactly at the cap", async () => {
    const over = await fetchDocs({ query: "x" }, { base: "https://x/api", fetchImpl: fakeFetch("y".repeat(MAX_DOCS_BYTES + 1)) });
    expect(over.ok).toBe(true);
    if (over.ok) expect(over.content).toContain("[truncated");
    const exact = await fetchDocs({ query: "x" }, { base: "https://x/api", fetchImpl: fakeFetch("y".repeat(MAX_DOCS_BYTES)) });
    expect(exact.ok).toBe(true);
    if (exact.ok) expect(exact.content).not.toContain("[truncated");
  });
});
