// The PURE core of Fluncle's search — everything that turns a raw string into something
// the database can be asked, with no database, no network, and no LLM in sight.
//
// It lives outside `lib/server/` because every function here is side-effect-free and
// unit-testable against fixtures, and because the classifier is the same on both sides of
// the wire: the client uses it to decide whether a keystroke is even worth a round trip.
//
// THE RESOLUTION ORDER, and the reason it is an order at all: an LLM must never sit on the
// hot path of a common query. So a query is classified deterministically first, and the
// model is reached for only when the deterministic tiers have all declined.
//
//   1. coordinate — `004.7.2I`, or `fluncle://004.7.2I`. Pure regex. No model, and no
//      candidate scan: it resolves to exactly one finding or to nothing.
//   2. entity     — an EXACT artist / label / album name. One indexed lookup.
//   3. token      — a single bare word (`netsky`). FTS5 + an artist prefix match.
//   4. filters    — anything else. THIS is the only tier that costs a model call, and even
//      it degrades to the FTS5 path when the model is slow, unprovisioned, or down.
//
// Tiers 2 and 4 need the database to answer, so they are decided in `lib/server/search.ts`;
// what lives here is the deterministic shape work each of them rests on.

// ── 1 · The coordinate ───────────────────────────────────────────────────────────────

/**
 * A Log ID as it is written: `sector.orbit.mark` — 3+ digits, a digit, then a digit and a
 * letter (`004.7.2I`). A mixtape's coordinate carries `F` in the orbit slot (`012.F.03`),
 * so the orbit accepts that letter too and the mark accepts a bare number pair. Anchored,
 * case-insensitive, and tolerant of the `fluncle://` scheme the coordinate is quoted with
 * across the surfaces.
 *
 * Deliberately shaped, never validated: this says "the user typed something that IS a
 * coordinate", not "that coordinate exists". Existence is one indexed lookup away, and a
 * miss is an honest empty state, not a parse error.
 */
const COORDINATE_PATTERN = /^(?:fluncle:\/\/)?(\d{3,}\.(?:\d|f)\.(?:\d[a-z]|\d{2}))$/i;

/**
 * The canonical coordinate a query names, or `null`. Uppercased, scheme stripped — the
 * exact form `findings.log_id` stores, so the caller can use it as a bind arg directly.
 */
export function parseCoordinate(query: string): string | null {
  const match = COORDINATE_PATTERN.exec(query.trim());

  return match?.[1] ? match[1].toUpperCase() : null;
}

// ── 3 · The bare token ───────────────────────────────────────────────────────────────

/**
 * Split a query into searchable word tokens: lowercase, punctuation dropped, empties gone.
 * Unicode-aware (`\p{L}\p{N}`) so `Nu:Tone` → `nu`,`tone` and `Andromedik` survives an
 * accent — the same boundaries FTS5's `unicode61` tokenizer draws, which is what keeps the
 * MATCH expression we build below in step with what was actually indexed.
 */
export function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 0);
}

/** True when the query is ONE bare word — tier 3, the cheapest interesting case. */
export function isBareToken(query: string): boolean {
  return tokenize(query).length === 1;
}

// ── 3½ · The sonic phrase ────────────────────────────────────────────────────────────

/**
 * "…sounds like <X>", "similar to <X>", "like <X>" — the canonical ways anyone asks for the
 * sonic tier, matched with a regex rather than a model.
 *
 * WHY THIS IS NOT LEFT TO THE LLM. Sonic search is the one thing no other drum & bass tool
 * has; it is the headline, and it is going to be one of the most-typed queries here. Putting
 * a model in front of the most valuable query in the product would break the rule the whole
 * resolver is built on — the LLM is never on the hot path of a common query — and it would
 * mean the headline feature goes down whenever the vendor does. "Sounds like X" needs no
 * understanding: it needs a pattern, and it has one.
 *
 * The model still owns everything this cannot see: an unusual phrasing, and — the real prize —
 * a COMPOUND query ("like Nine Clouds but on Hospital Records"), where the reference is only
 * half the question. The regex therefore matches the SIMPLE forms only: it declines the moment
 * a `but`/`on`/`in`/`from`/`under`/`over` clause appears, and hands that query to tier 4,
 * which can turn the rest of it into the btree pre-filter that goes in front of the scan.
 *
 * Returns the reference, or `null` when the query is not asking for neighbours at all.
 */
const SONIC_PATTERN =
  /^(?:(?:tracks?|songs?|findings?|anything|something|stuff)\s+)?(?:that\s+)?(?:sounds?\s+like|sound\s+like|similar\s+to|like)\s+(.+)$/i;

// A trailing clause the regex must NOT swallow into the reference — it is a FILTER, and it
// belongs to the model, which can compile it into columns. `["like X but slower"]` is a
// question about two things; this tier answers questions about one.
const COMPOUND_TAIL = /\s+(?:but|on|in|from|under|over|above|below|around|at)\s+\S/i;

export function parseSonicPhrase(query: string): string | null {
  const match = SONIC_PATTERN.exec(query.trim());
  const reference = match?.[1]?.trim();

  if (!reference || COMPOUND_TAIL.test(reference)) {
    return null;
  }

  return reference;
}

// ── The FTS5 MATCH expression ────────────────────────────────────────────────────────

/**
 * FTS5's MATCH argument is a QUERY LANGUAGE, not a string — `"`, `*`, `:`, `^`, `-`, `NEAR`,
 * `AND`, `OR` are all operators. Interpolating a user's raw text there is the FTS5 analogue
 * of SQL injection: at best a syntax error thrown at them (`fts5: syntax error near "-"`),
 * at worst a query that means something they did not ask for. The bind slot does NOT save
 * you — the string is parsed as an expression AFTER it is bound.
 *
 * So the expression is REBUILT, never passed through. Every token is stripped to letters and
 * digits by {@link tokenize} and then re-quoted as an FTS5 string literal, which makes every
 * remaining character inert. There is no path from user text to an operator.
 *
 * The join is the tier's semantics:
 *
 *   - `and` (the default) — every token must appear. What a deliberate multi-word query
 *     means (`nine clouds` = that track, not every track with a cloud in it).
 *   - `or` — any token may appear, and bm25 sorts by rarity, so the ONE distinctive word in
 *     a sentence carries the result. This is the LLM-down degradation path: asked
 *     "Andromedik tracks in A minor" with no model to parse it, an AND would return nothing
 *     while an OR still surfaces the Andromedik tracks — a worse answer than the filters,
 *     and a far better one than an empty page.
 *
 * The LAST token gets a `*` prefix-match suffix so a query is useful mid-word (`nets` finds
 * Netsky) — the type-ahead affordance the Command dialog is built on.
 *
 * Returns `null` when nothing survives tokenization (punctuation only): the caller must
 * treat that as "no text query", never run an empty MATCH.
 */
export function toFtsMatch(query: string, join: "and" | "or" = "and"): string | null {
  const tokens = tokenize(query);
  const searchable = join === "or" ? withoutStopwords(tokens) : tokens;

  if (searchable.length === 0) {
    return null;
  }

  const terms = searchable.map((token, index) =>
    index === searchable.length - 1 ? `"${token}"*` : `"${token}"`,
  );

  return terms.join(join === "or" ? " OR " : " ");
}

/**
 * The words a music search sentence is MADE of rather than ABOUT — the scaffolding a reader
 * hangs a real query on ("give me some tracks by …", "anything in A minor").
 *
 * They are dropped from the OR path only, and the reason is arithmetic, not taste. Under OR,
 * a document that matches two throwaway words can out-score one that matches the single word
 * the query was actually about: asked "Andromedik tracks in A minor" with the model down, the
 * fallback surfaced "Everything In Its Right Place" — which matched `in` — ABOVE the one
 * Andromedik track in the archive. bm25's IDF is not enough on its own when the query is a
 * sentence and the corpus is small.
 *
 * The AND path keeps every token, because there each word is a constraint the reader MEANT:
 * "nine clouds" is a title, not a sentence.
 *
 * If the query is nothing BUT scaffolding, the tokens are kept — a search for the band "The
 * The" should still search for something.
 */
const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "any",
  "anything",
  "at",
  "by",
  "find",
  "for",
  "from",
  "get",
  "give",
  "in",
  "is",
  "it",
  "like",
  "me",
  "more",
  "of",
  "on",
  "or",
  "show",
  "some",
  "something",
  "song",
  "songs",
  "sound",
  "sounds",
  "that",
  "the",
  "to",
  "track",
  "tracks",
  "tune",
  "tunes",
  "with",
]);

function withoutStopwords(tokens: string[]): string[] {
  const kept = tokens.filter((token) => !STOPWORDS.has(token));

  return kept.length > 0 ? kept : tokens;
}

// ── The key filter ───────────────────────────────────────────────────────────────────

// Every spelling of a pitch class that could have been written into `tracks.key`, indexed by
// pitch class (0 = C … 11 = B). The analyzer writes sharps ("C# minor"); a Rekordbox-graded
// or hand-entered key can arrive flat or with a Unicode accidental. Enharmonics fold to one
// class, so asking for "Bb minor" and asking for "A# minor" are the same question and both
// return the same rows.
const PITCH_SPELLINGS: Record<number, string[]> = {
  0: ["c", "b#"],
  1: ["c#", "db"],
  10: ["a#", "bb"],
  11: ["b", "cb"],
  2: ["d"],
  3: ["d#", "eb"],
  4: ["e", "fb"],
  5: ["f", "e#"],
  6: ["f#", "gb"],
  7: ["g"],
  8: ["g#", "ab"],
  9: ["a"],
};

// The mode words a stored key might carry, per mode. `parseKey` (lib/key-camelot.ts) accepts
// all of them on the way in, so all of them can be on the way out.
const MODE_WORDS: Record<"major" | "minor", string[]> = {
  major: ["major", "maj"],
  minor: ["minor", "min"],
};

/**
 * Every `lower(tracks.key)` value that means the SAME key as the parsed one — the IN-list a
 * key filter binds.
 *
 * Matching keys as text is the honest way to do it here: `tracks.key` is a display string,
 * there is no pitch-class column to compare against, and normalising one in SQL would mean a
 * function call per row (an unindexable scan). An `IN` over a dozen literal spellings is one
 * b-tree probe per spelling and stays a b-tree probe when the catalogue is 41k rows deep —
 * which is exactly the "btree pre-filter" a sonic query needs in front of its vector scan
 * (docs/local-database.md).
 *
 * Takes the already-parsed key so this file stays free of the parser's tolerance rules
 * (`lib/key-camelot.ts` owns those, and owns them once).
 */
export function keySpellings(parsed: { isMinor: boolean; pitchClass: number }): string[] {
  const notes = PITCH_SPELLINGS[parsed.pitchClass] ?? [];
  const modes = MODE_WORDS[parsed.isMinor ? "minor" : "major"];

  return notes.flatMap((note) => modes.map((mode) => `${note} ${mode}`));
}
