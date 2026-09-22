// Two-char tech tokens are meaningful in this corpus (go, js, ts, ci, ui, db, …),
// so the minimum length is 2; these short grammar words are dropped instead.
const STOPWORDS = new Set([
  "is", "in", "on", "at", "to", "of", "or", "if", "it", "be", "as", "by", "we",
  "do", "no", "so", "up", "an", "my", "me", "us", "the", "and", "for", "with",
  "use", "used", "using", "when", "into", "from", "your", "that", "this", "you",
  "are", "not", "any", "its", "how", "why", "what", "which", "will", "can",
  "get", "set", "via", "per", "out", "new", "one", "two", "all", "but", "has",
  "have", "had", "was", "were", "them", "then", "than", "over", "under",
  "before", "after", "code", "task", "work",
]);

function singularize(word) {
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) {
    return word.slice(0, -1);
  }
  return word;
}

/**
 * Deterministic tokenizer shared by the index builder and the query ranker so
 * both sides agree on what counts as a matchable token.
 */
export function tokenize(input) {
  const seen = new Set();
  for (const raw of String(input).toLowerCase().split(/[^a-z0-9]+/u)) {
    if (raw.length < 2) continue;
    const word = singularize(raw);
    if (word.length < 2 || STOPWORDS.has(word)) continue;
    seen.add(word);
  }
  return [...seen];
}
