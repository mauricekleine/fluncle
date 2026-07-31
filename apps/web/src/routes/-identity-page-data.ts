// The identity page's server-side resolution, lifted out of `identity.$key.tsx` — the
// `-artist-page-data.ts` sibling-module pattern. That file holds the long note on WHY: a route's
// loader/head live in the route's critical half, so a resolver referenced there keeps its
// `lib/server/**` imports — and the `getDb` → `@libsql/client` + `drizzle-orm` + `db/schema.ts`
// chain behind them — alive in the eager browser chunk every page downloads before first paint.
//
// The route reaches this by a DYNAMIC import inside its handler and by `import type`, so the whole
// chain stays server-side.
//
// ── THE PAGE IS A METERED READ ────────────────────────────────────────────────────────────────
// The identity answer is the one public read whose value to a scraper is the AGGREGATE rather than
// the row (identity-dials.ts holds the argument), so the page's server fn charges the same two
// dials the `get_track` identity projection does — ruling 8: one answer, one meter, whichever door
// the caller came through. A spent dial is not an error here; it is a state the page renders, so
// the 429 the limiter throws is caught and folded into the returned union rather than escaping as
// a fault.

import { getRequest } from "@tanstack/react-start/server";
import {
  type IdentityEnvelope,
  type IdentityKey,
  readIdentity,
} from "@/lib/server/identity-envelope";
import { assertIdentityReadAllowed } from "@/lib/server/identity-dials";
import {
  canonicalIdentityKey,
  normalizeIsrcKey,
  normalizeMbidKey,
  platformIdentityKey,
} from "@/lib/identity-key";

/**
 * Which kind of key a caller's path segment turned out to be. Carried on the page data so
 * the page can name the key it answered for without re-reading it.
 *
 *   · `isrc`      — the recording's own international standard code.
 *   · `mbid`      — a MusicBrainz recording id.
 *   · `platform`  — a pasted Spotify or Deezer track link, collapsed to `<platform>:track:<id>`.
 *   · `reference` — a Log ID coordinate or Fluncle's own track id. One branch, because both answer
 *                   through the same indexed `track_id = ? or log_id = ?` read and neither has a
 *                   shape a caller has to be taught to tell apart.
 */
export type IdentityKeyKind = "isrc" | "mbid" | "platform" | "reference";

/**
 * The key as Fluncle stores it, plus what kind it is. A reader may type an ISRC with hyphens
 * (`GB-ABC-12-34567`) or a MusicBrainz id in any case, or paste a Spotify or Deezer link straight
 * off a share sheet with its locale segment and its tracking parameters still attached; all of them
 * normalize here, and the page canonicalizes its URL onto the normalized spelling so one recording
 * is not reachable at a dozen spellings of one identifier.
 */
export function identityKeyFor(raw: string): { key: IdentityKey; kind: IdentityKeyKind } {
  const isrc = normalizeIsrcKey(raw);

  if (isrc) {
    return { key: { isrcs: [isrc], kind: "isrc" }, kind: "isrc" };
  }

  const mbid = normalizeMbidKey(raw);

  if (mbid) {
    return { key: { kind: "mbid", mbid }, kind: "mbid" };
  }

  // A link, or the URI spelling the door redirects onto. `platformIdentityKey` reads only the forms
  // that NAME their platform, never a bare id — a bare Spotify id and Fluncle's own track id for a
  // finding are the same string, so the reference branch below keeps that case.
  const platform = platformIdentityKey(raw);

  if (platform?.platform === "spotify") {
    return { key: { kind: "spotify", spotifyId: platform.id }, kind: "platform" };
  }

  if (platform?.platform === "deezer") {
    return { key: { deezerId: platform.id, kind: "deezer" }, kind: "platform" };
  }

  // Anything else is tried as a Log ID coordinate or a track id. A string that is neither simply
  // matches no row and the page says so: there is no malformed-key state to render, because a
  // reference key has no shape to be malformed against. (The OP does 422 a malformed ISRC/MBID —
  // a machine caller has passed a value it believes is one. A reader who mistypes gets the same
  // honest "nothing under this" a wrong-but-well-formed key gets, which is the truth either way.)
  return { key: { idOrLogId: raw.trim(), kind: "idOrLogId" }, kind: "reference" };
}

export type IdentityPageData =
  | { envelope: IdentityEnvelope; key: string; kind: IdentityKeyKind; status: "found" }
  | { key: string; kind: IdentityKeyKind; status: "missing" }
  | { status: "limited" };

/**
 * One key → one page. The three outcomes are all renderable states rather than errors: an answer,
 * an honest nothing, and a caller who has spent the allowance.
 */
export async function resolveIdentityPageData(raw: string): Promise<IdentityPageData> {
  const { key, kind } = identityKeyFor(raw);
  const canonical = canonicalIdentityKey(raw);

  try {
    await assertIdentityReadAllowed(getRequest());
  } catch {
    // The limiter throws a 429 `ApiError`, and a page has somewhere better to put that than a
    // fault: the reader gets a calm line and a way back. Any other bookkeeping failure lands here
    // too and degrades the same way, which is the right side to fail on for a read that changes
    // nothing.
    return { status: "limited" };
  }

  // FIRST-PARTY, and that is the one thing the page reads differently from the API: an Apple Music
  // link renders here exactly as it renders on the recording's own `/log` page. The API's `machine`
  // read still answers `unsupported` for Apple, because passing those links to a third party is what
  // Apple's terms bar (identity-envelope.ts holds the clause and the split).
  const envelope = await readIdentity(key, "first-party");

  return envelope
    ? { envelope, key: canonical, kind, status: "found" }
    : { key: canonical, kind, status: "missing" };
}
