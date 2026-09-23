import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

/**
 * The index of threads whose auto-review is queued or running, with the
 * provider each one runs on.
 *
 * Reviews on one provider share that provider's limits, so they run one at a
 * time across every project; reviews on different providers never wait on
 * each other. Checking that from per-thread state alone would mean reading
 * every thread in every project, so this index is the enumeration instead.
 *
 * It may over-include — an entry outlives its review until a reader finds the
 * thread no longer holds one and prunes it — but never under-includes: the
 * entry is written under the provider lock, right after the review latches.
 * One key per thread for the same reason as the deferral index: the KV API has
 * no compare-and-swap.
 */
export const reviewEntrySchema = z.object({
  threadId: z.string(),
  providerId: z.string(),
});
export type ReviewEntry = z.infer<typeof reviewEntrySchema>;

const KEY_PREFIX = "review:";

function key(threadId: string): string {
  return `${KEY_PREFIX}${threadId}`;
}

export async function readReviews(bb: BbPluginApi): Promise<ReviewEntry[]> {
  const keys = await bb.storage.kv.list(KEY_PREFIX);
  const rows: ReviewEntry[] = [];
  for (const entryKey of keys) {
    const parsed = reviewEntrySchema.safeParse(
      await bb.storage.kv.get<unknown>(entryKey),
    );
    if (parsed.success) {
      rows.push(parsed.data);
    } else {
      await bb.storage.kv.delete(entryKey);
    }
  }
  return rows;
}

export async function addReview(
  bb: BbPluginApi,
  entry: ReviewEntry,
): Promise<void> {
  await bb.storage.kv.set(key(entry.threadId), entry);
}

export async function removeReview(
  bb: BbPluginApi,
  threadId: string,
): Promise<void> {
  await bb.storage.kv.delete(key(threadId));
}
