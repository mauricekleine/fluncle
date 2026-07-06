// The plan handle: an auto Galaxy-vocab slug for a Plan → Recording → Mixtape
// take. Minted once from a seed and stored on the plan (never date-predicted, so
// the drift bug that killed `predictedMixtapeLogId` can't come back) — the
// copy-paste label an operator carries onto Beatport / Rekordbox / a USB stick.
// Shape: `adjective-cosmos-scenenoun` (e.g. `liquid-nebula-roller`,
// `molten-gravity-dubplate`). Deterministic per seed, salted-re-roll on collision.
//
// Client-safe and dependency-free — a sibling to `parseDuration` in `../util.ts`.
// The vocabulary is a CURATED ALLOW-LIST drawn from the Voice canon
// (VOICE.md → packages/skills/copywriting-fluncle/references/voice.md §3
// Vocabulary + §4 The Sauce, the sci-fi sublime), guarded by a load-bearing test
// (`galaxy-slug.test.ts`) that asserts no pool word is in `BANNED`.

/**
 * Stable 32-bit FNV-1a hash → non-negative integer. Replicated from
 * `apps/web/src/lib/log-id-shared.ts` (contracts can't depend on `apps/web` —
 * the dependency runs the other way), kept byte-identical so a Log ID and a plan
 * handle hash the same. Pure and dependency-free.
 */
export function fnv1a(value: string): number {
  let hash = 0x811c9dc5;

  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }

  return hash >>> 0;
}

// The three curated vocab pools. Every word is a single lowercase `[a-z]+` token
// (no digits, no internal hyphen) so a three-word slug always matches
// `/^[a-z]+(-[a-z]+){2}$/`. On-canon, allow-list only — new words earn their place
// against the Voice canon and must clear `BANNED` (the test enforces it).

/**
 * Pool 1 — energy / scene ADJECTIVES. The words the scene reaches for to describe
 * how a roller moves and how it feels (voice.md §2 Scene-native, §3, §4 The Sauce:
 * the sci-fi sublime — space/time/physics/scale, awe reached through the machine,
 * never the spiritual register).
 */
export const GALAXY_ADJECTIVES = [
  "liquid",
  "rolling",
  "deep",
  "dark",
  "heavy",
  "molten",
  "weightless",
  "hypnotic",
  "feral",
  "luminous",
  "drifting",
  "glacial",
  "restless",
  "distant",
  "boundless",
  "radiant",
  "seismic",
  "fathomless",
] as const;

/**
 * Pool 2 — COSMOS nouns. The sci-fi-sublime domain (voice.md §4 The Sauce:
 * space, time, physics, exploration, scale). `dimension` is core canon ("bangers
 * from another dimension"); the rest are physical cosmos objects. Deliberately
 * excludes `eclipse`/`void` (DESIGN.md's one identity image / the nihilist word,
 * both in `BANNED`) and `sector` (allowed as first-person prose colour, never a
 * label — and a slug is a label).
 */
export const GALAXY_COSMOS = [
  "nebula",
  "orbit",
  "pulsar",
  "quasar",
  "comet",
  "horizon",
  "dimension",
  "cosmos",
  "meteor",
  "aurora",
  "supernova",
  "parsec",
  "singularity",
  "gravity",
] as const;

/**
 * Pool 3 — DnB SCENE nouns (voice.md §2 Scene-native: "roller, rinse, rewind,
 * dubplate, selector, junglist" — full drum & bass vocabulary, used confidently
 * and never explained). Excludes `banger`/`tune`: the Banger Budget keeps those
 * scarce certification words for a track Fluncle actually certified — never
 * machine-minted onto an unrecorded plan.
 */
export const GALAXY_SCENE = [
  "roller",
  "rinse",
  "dubplate",
  "rewind",
  "riddim",
  "stepper",
  "amen",
  "breakbeat",
  "jungle",
  "sublow",
  "bassline",
  "skank",
] as const;

/**
 * The hard exclusions. A slug is a permanent machine-minted LABEL, so the label
 * rules bite even though the generated slug is the chosen handle. Each word cites
 * the Voice canon that bans it:
 *   - `banger`, `tune` — the Banger Budget (voice.md §4): scarce certification
 *     words for a certified track, never minted onto a plan. `liquid-nebula-banger`
 *     is out; `liquid-nebula-roller` is in.
 *   - `sector` — allowed as first-person prose colour, NEVER a UI label or
 *     structural noun (voice.md §3). A slug is a label.
 *   - `eclipse`, `void` — the brand's one identity image / the nihilist word
 *     (DESIGN.md; voice.md "never nihilist"). Not machine-scattered onto handles.
 *   - `transmission`, `signal`, `anomaly`, `curated`, `content`, `stream` — the
 *     standard banned set (voice.md §3 Banned: retired radio metaphor, sci-fi
 *     cliché, gallery word, "a banger is never content", Spotify streams).
 *   - the spiritual register — `nirvana`, `ayahuasca`, `meditation`, `buddhism`,
 *     `hippie`, `incense` — off-limits (voice.md §4 The Sauce: Fluncle reaches awe
 *     through physics and the future, he doesn't bliss out into it).
 */
export const BANNED: ReadonlySet<string> = new Set([
  "banger",
  "tune",
  "sector",
  "eclipse",
  "void",
  "transmission",
  "signal",
  "anomaly",
  "curated",
  "content",
  "stream",
  "nirvana",
  "ayahuasca",
  "meditation",
  "buddhism",
  "hippie",
  "incense",
]);

/** The size of the combination space: |adjectives| × |cosmos| × |scene|. */
export const GALAXY_SLUG_COMBINATIONS =
  GALAXY_ADJECTIVES.length * GALAXY_COSMOS.length * GALAXY_SCENE.length;

/**
 * A 32-bit integer finalizer (the `lowbias32` avalanche mix). FNV-1a has weak
 * low-bit diffusion on near-identical short seeds, and `% len` reads exactly
 * those low bits — so sequential seeds (`seed-0`, `seed-1`, …) would cluster.
 * Mixing the hash first spreads it, restoring an even spread across a pool.
 */
function mix32(value: number): number {
  let hash = value >>> 0;
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x7feb352d);
  hash ^= hash >>> 15;
  hash = Math.imul(hash, 0x846ca68b);
  hash ^= hash >>> 16;

  return hash >>> 0;
}

/**
 * Pick a pool word from a decorrelated hash slice: the salted seed is re-hashed
 * per axis (a NUL-separated axis tag) then avalanche-mixed, so the three pools
 * index independently and two axes never move together. The `?? pool[0] ?? ""`
 * tail only satisfies `noUncheckedIndexedAccess`; the modulo index is always in
 * range for a non-empty pool.
 */
function pick(pool: readonly string[], saltedSeed: string, axis: number): string {
  const index = mix32(fnv1a(`${saltedSeed}\u0000${axis}`)) % pool.length;

  return pool[index] ?? pool[0] ?? "";
}

/**
 * Turn any seed into a deterministic `adjective-cosmos-scenenoun` plan handle.
 *
 * Deterministic per `(seed, attempt)`: the same pair always yields the same slug.
 * Collision handling is the caller's loop — on a clash, call again with the next
 * `attempt`; the counter salts the seed and re-rolls all three axes to a fresh
 * combination. Only once the whole ~3k-combination space is exhausted (an
 * `attempt` at or beyond `GALAXY_SLUG_COMBINATIONS`, effectively never) does a
 * numeric suffix get appended to guarantee a novel string.
 */
export function galaxySlug(seed: string, attempt = 0): string {
  const saltedSeed = `${seed}\u0000${attempt}`;
  const adjective = pick(GALAXY_ADJECTIVES, saltedSeed, 0);
  const cosmos = pick(GALAXY_COSMOS, saltedSeed, 1);
  const scene = pick(GALAXY_SCENE, saltedSeed, 2);
  const base = `${adjective}-${cosmos}-${scene}`;

  return attempt >= GALAXY_SLUG_COMBINATIONS ? `${base}-${attempt}` : base;
}

/**
 * Slugify an arbitrary title into a `lowercase-hyphenated` token string: strip
 * punctuation, collapse whitespace/separators to single hyphens, trim edges.
 * Returns `""` for an all-punctuation input. Provided for completeness alongside
 * the generated handle (e.g. deriving a fallback slug straight from a title).
 */
export function slugify(title: string): string {
  return title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
