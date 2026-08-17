import { diffArrays } from "diff";
import type { ColumnSpan } from "../../types";

/**
 * Port of difftastic's two-tier novelty decision for changed content
 * (`split_atom_words` in `src/parse/syntax.rs`, plus `src/words.rs` and
 * `src/diff/lcs_diff.rs`, difftastic 0.69.0).
 *
 * difftastic renders a changed region in two tiers: `NovelWord` (bold plus
 * underline) for the words that actually differ, and `UnchangedPartOfNovelItem`
 * (plain novel color) for the rest. Its JSON writer keeps every span whose
 * `MatchKind::is_novel()` holds, which covers both tiers, then drops the tier
 * label (difftastic issue #658). A payload's `changes` array is therefore
 * already the output of difftastic's word diff with the tier missing: the span
 * boundaries are correct and only the per-span tier has to be recovered.
 *
 * The decision is one rule in two parts, and a caller needs both:
 *
 * 1. `isWordSplitScope` - difftastic splits words only when both sides are
 *    comment atoms or both are string atoms of the same kind.
 * 2. `classifyNovelWords` - tokenize both atom contents, LCS them, apply the
 *    similarity gate, and report the ranges that are the changed word.
 *
 * Both are pure and free of rendering concerns. Offsets are UTF-16 code units,
 * the space the mapper's `ColumnSpan`s already live in, so callers reuse the
 * mapper's byte-to-code-unit remap instead of adding a second one.
 */

/** Ranges that are the changed word on each side, relative to that side's atom content. */
export interface NovelWordRanges {
  lhs: ColumnSpan[];
  rhs: ColumnSpan[];
}

/**
 * JSON `highlight` kinds whose atoms difftastic word-splits.
 *
 * `Highlight::from_match` maps `AtomKind::Comment` to `comment` and
 * `AtomKind::String(StringKind::StringLiteral)` to `string`. It maps
 * `AtomKind::String(StringKind::Text)` to `normal`, so a Text atom (plain-text
 * and markdown bodies) is word-split by difftastic yet indistinguishable in the
 * JSON from a changed identifier. Excluding `normal` therefore costs emphasis on
 * Text atoms and never adds emphasis difftastic would not draw.
 */
const WORD_SPLIT_HIGHLIGHTS = new Set(["comment", "string"]);

/**
 * Step 1: is this atom pair one difftastic splits into words?
 *
 * Mirrors the `ReplacedComment` / `ReplacedString` edge condition in
 * `src/diff/graph.rs`: both sides are comment or string atoms of the same kind.
 * Everything else, a changed identifier or keyword included, stays whole-atom
 * novel with no inner emphasis.
 */
export function isWordSplitScope(lhsHighlight: string, rhsHighlight: string): boolean {
  return lhsHighlight === rhsHighlight && WORD_SPLIT_HIGHLIGHTS.has(lhsHighlight);
}

/** Rust `char::is_alphanumeric() || c == '_'`: Alphabetic plus the Nd/Nl/No categories. */
const WORD_CHARACTER = /[\p{Alphabetic}\p{Nd}\p{Nl}\p{No}_]/u;
/** Rust `char::is_ascii_digit()`, the boundary `split_words_and_numbers` splits on. */
const ASCII_DIGIT = /[0-9]/;
/** Rust `char::is_whitespace()`, the Unicode White_Space property (not JS `\s`). */
const WHITE_SPACE_ONLY = /^\p{White_Space}*$/u;

/**
 * Port of difftastic's `split_words_and_numbers`: a token is a maximal run of
 * word characters, additionally split at every ASCII-digit / non-digit boundary;
 * every other character is its own single-character token.
 *
 * `"foo..bar23"` -> `["foo", ".", ".", "bar", "23"]`.
 *
 * Iteration is by code point, so an astral character is one token rather than a
 * surrogate pair, and the returned tokens concatenate back to the input.
 */
export function splitWordsAndNumbers(content: string): string[] {
  const tokens: string[] = [];
  let wordStart = -1;
  let wordStartIsDigit = false;
  let offset = 0;
  for (const character of content) {
    if (WORD_CHARACTER.test(character)) {
      const isDigit = ASCII_DIGIT.test(character);
      if (wordStart === -1) {
        wordStart = offset;
        wordStartIsDigit = isDigit;
      } else if (isDigit !== wordStartIsDigit) {
        tokens.push(content.slice(wordStart, offset));
        wordStart = offset;
        wordStartIsDigit = isDigit;
      }
    } else {
      if (wordStart !== -1) {
        tokens.push(content.slice(wordStart, offset));
        wordStart = -1;
      }
      tokens.push(character);
    }
    offset += character.length;
  }
  if (wordStart !== -1) tokens.push(content.slice(wordStart));
  return tokens;
}

type TokenSide = "both" | "lhs" | "rhs";

interface TokenResult {
  token: string;
  side: TokenSide;
}

/**
 * LCS over the two token arrays, flattened to one result per token.
 *
 * difftastic runs Wu's O(NP) algorithm (`lcs_diff::slice_by_hash` over the
 * `wu-diff` crate); this uses the `diff` package's Myers implementation. Both
 * produce a maximal common subsequence, so the counts the gate reads agree, but
 * when a token repeats the two can pair different occurrences and place a
 * changed word one repeat away from where difftastic placed it.
 */
function diffTokens(lhsTokens: string[], rhsTokens: string[]): TokenResult[] {
  const results: TokenResult[] = [];
  for (const change of diffArrays(lhsTokens, rhsTokens)) {
    const side: TokenSide = change.added ? "rhs" : change.removed ? "lhs" : "both";
    for (const token of change.value) results.push({ token, side });
  }
  return results;
}

/**
 * Step 2: which ranges of each atom content are the changed word.
 *
 * Returns `null` when difftastic's similarity gate (`has_common_words`) rejects
 * the pair, meaning the whole atom is plain novel with no inner emphasis. A
 * caller must also satisfy `isWordSplitScope` first; this function is the rule
 * for content that is already in scope.
 *
 * Ranges are 0-based, end-exclusive UTF-16 code-unit offsets into the side's own
 * content, one range per changed token exactly as difftastic emits one
 * `MatchedPos` per `NovelWord`. Whitespace-only changed tokens are dropped, so
 * ranges are not merged across the gap a dropped token leaves.
 */
export function classifyNovelWords(lhsContent: string, rhsContent: string): NovelWordRanges | null {
  const results = diffTokens(splitWordsAndNumbers(lhsContent), splitWordsAndNumbers(rhsContent));

  // `has_common_words`: a single space never counts as shared content, and a
  // changed word costs two novel tokens (one per side) against one unchanged
  // token, hence the doubling. The `> 2` floor exists because the content
  // includes the comment or string delimiters.
  let unchanged = 0;
  let novel = 0;
  for (const result of results) {
    if (result.side === "both") {
      if (result.token !== " ") unchanged += 1;
    } else {
      novel += 1;
    }
  }
  if (!(unchanged > 2 && unchanged * 2 >= novel)) return null;

  const lhs: ColumnSpan[] = [];
  const rhs: ColumnSpan[] = [];
  let lhsOffset = 0;
  let rhsOffset = 0;
  for (const { token, side } of results) {
    if (side === "both") {
      // A shared token is the same string on both sides, so one length advances both.
      lhsOffset += token.length;
      rhsOffset += token.length;
      continue;
    }
    // A whitespace-only changed token advances the offset without being
    // emphasised, so the run of changed words around it stays split.
    if (side === "lhs") {
      if (!WHITE_SPACE_ONLY.test(token)) lhs.push([lhsOffset, lhsOffset + token.length]);
      lhsOffset += token.length;
    } else {
      if (!WHITE_SPACE_ONLY.test(token)) rhs.push([rhsOffset, rhsOffset + token.length]);
      rhsOffset += token.length;
    }
  }
  return { lhs, rhs };
}
