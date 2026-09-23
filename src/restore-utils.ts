// Pure text-level restore helpers, shared by content.ts and the test suite.
//
// The reply-side restore bug these exist to prevent: AI chat UIs render a
// decoy like "John Doe" with a line break, a non-breaking space, or nested
// markup between the words. An exact indexOf/includes then misses it, the
// response guard never fires, and "copy with real values" copies the decoy —
// restore silently fails. Every lookup here therefore tolerates whitespace
// variants of multi-word replacements.

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Any whitespace run in the replacement matches any whitespace run
 *  (including NBSP variants) in the page text. Null for empty strings. */
export function flexPattern(replacement: string): RegExp | null {
  const parts = replacement.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  return new RegExp(parts.map(escapeRegex).join('[\\s\\u00a0\\u2007\\u202f]+'), 'g');
}

/** True if `text` contains the replacement, tolerating whitespace variants. */
export function containsReplacement(text: string, replacement: string): boolean {
  if (text.includes(replacement)) return true;
  if (!/\s/.test(replacement)) return false;
  const re = flexPattern(replacement);
  return re ? re.test(text) : false;
}

/**
 * Swap every replacement back to its original. `pairs` must already be sorted
 * longest-replacement-first so a substring replacement cannot clobber a longer
 * one. Exact swap first (fast path), then the whitespace-tolerant pass for
 * multi-word replacements the AI's renderer reformatted.
 */
export function restoreWithPairs(
  text: string,
  pairs: readonly [replacement: string, original: string][],
): string {
  let out = text;
  for (const [replacement, original] of pairs) {
    if (replacement.length === 0) continue;
    out = out.split(replacement).join(original);
    if (/\s/.test(replacement)) {
      const re = flexPattern(replacement);
      if (re) out = out.replace(re, original);
    }
  }
  return out;
}
