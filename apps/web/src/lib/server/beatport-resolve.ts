// Worker-safe Beatport resolve side: turn a recording Fluncle already holds into its Beatport
// track URL, EXACTLY, by matching the ISRC Beatport publishes against the ISRC Fluncle holds.
//
// WHY THERE IS NO API CALL HERE. Beatport HAS a catalogue API, and it is partner-gated: access is
// granted per application, and Fluncle holds no key. The ecosystem's well-known workaround —
// borrowing the `client_id` the public web player ships in its own bundle — is FORBIDDEN, flatly
// and permanently. It is unauthorised access to a gated API under Beatport's terms, and no amount
// of "everyone does it" makes it something this repo does. If the operator's access application is
// granted, an approved key REPLACES this fetcher wholesale and this module becomes a thin API call.
// Until then the leg reads only what Beatport serves the public web, which is the same thing a
// person with a browser sees.
//
// WHY FIRECRAWL AND NOT `fetch`. Beatport sits behind Cloudflare: a bare Worker `fetch` of a
// beatport.com page answers 403. Firecrawl renders the page the way a browser would and hands back
// the HTML, and Fluncle already holds a Firecrawl key for the artist-social gap-fill — so this leg
// adds a caller, not a vendor. The request shape here deliberately mirrors artist-resolution.ts's
// (bearer key, hard abort deadline, best-effort null on any non-2xx) so there is ONE Firecrawl
// client shape in the codebase rather than two that drift.
//
// ── THE ONE-CALL SHAPE, AND WHY IT IS NOT THE TWO-HOP IT LOOKS LIKE ──────────────────────────
// Beatport's public search page is a Next.js page, and its `__NEXT_DATA__` island carries the FULL
// track objects for its results — `isrc` and `track_id` included. So one scrape of the search URL
// answers both questions at once: which result is this recording (by ISRC), and where does it live
// (by the `<a href>` Beatport itself renders for that id). No candidate-page hop is needed, and the
// leg costs exactly one Firecrawl call per recording.
//
// THE URL IS READ, NEVER CONSTRUCTED, and that is load-bearing rather than fussy. A Beatport track
// URL is `/track/<slug>/<id>`, and the site serves the right track for a WRONG slug — but its
// `<link rel="canonical">` then echoes the wrong slug straight back (measured 2026-07-30 against
// `/track/x/19385810`, which answered with the real track and a canonical naming the fake slug).
// So a fabricated URL is not self-correcting and cannot be validated by fetching it. The only
// trustworthy source of the slug is a link Beatport rendered itself, which is exactly what this
// module reads. Consequence, deliberate: an ISRC that matches a result Beatport did NOT render a
// link for is a clean MISS, not a guess.
//
// ── §F: WHAT THIS MODULE IS ALLOWED TO KEEP ──────────────────────────────────────────────────
// Beatport's terms prohibit using site content, metadata included, for text/data mining or for
// training or feeding AI. This resolver therefore keeps exactly ONE field — the track URL — plus
// the timestamp of its own write. The parsed page object also carries Beatport's key, BPM, genre,
// label, and length; every one of them is dropped on the floor. The ISRC itself is compared in
// memory and never stored from this source (Fluncle already holds his own). Nothing read here may
// reach the FTS5 index, the LLM search tier, or any embedding — see the rail written onto
// `tracks.beatport_url` in db/schema.ts.

import { logEvent } from "./log";
import { readOptionalEnv } from "./env";

const FIRECRAWL_SCRAPE_URL = "https://api.firecrawl.dev/v2/scrape";

// Matches artist-resolution.ts's deadline: a rendered scrape is slow, and a leg that gives up too
// early burns an attempt on a page that would have answered.
const FIRECRAWL_TIMEOUT_MS = 45_000;

// How many ISRC-matching results to consider. Beatport legitimately returns the SAME ISRC on
// several track ids — a clean edit, an intro edit, and the original are one recording by ISRC
// identity but three rows in the store — so this is a tie-break bound, not a search width. The
// first one Beatport ranked that carries a rendered link wins; they are the same recording, so
// there is nothing to choose between them on correctness.
const MAX_CANDIDATES = 5;

/**
 * The outcome of one recording's resolve. The three failure-ish shapes are deliberately distinct,
 * because the backfill ledger writes a DIFFERENT thing for each:
 *   - `{ configured: false }` — no Firecrawl key. A silent no-op; the caller records NOTHING, so
 *     the row stays eligible for the day the key lands.
 *   - `{ configured: true, ok: true, url: null }` — the search ran and concluded: Beatport does not
 *     carry this recording (or carries it without a link we may trust). A CLEAN MISS — the caller
 *     records a `tried`, and the receipt reads "Not found · checked <date>".
 *   - `{ configured: true, ok: false, error }` — the scrape failed, timed out, or came back in a
 *     shape this module does not understand. NOTHING was learned, so the caller records a FAILURE
 *     and the row backs off. Never a clean miss: saying "not on Beatport" because Firecrawl
 *     timed out is the exact lie the identity surface exists to avoid.
 */
export type BeatportResolveOutcome =
  | { configured: false }
  | { configured: true; ok: true; url: null | string }
  | { configured: true; error: string; ok: false };

/** The Beatport search URL for a recording. */
export function beatportSearchUrl(artists: string[], title: string): string {
  const query = `${artists.join(" ")} ${title}`.trim();

  return `https://www.beatport.com/search?q=${encodeURIComponent(query)}`;
}

/** The fields this module reads off a Beatport search result. Everything else is dropped (§F). */
type BeatportSearchTrack = { isrc?: null | string; track_id?: number | string };

/**
 * A Firecrawl scrape returning the page's raw HTML, or null on any non-2xx, network error, or
 * timeout. Best-effort by construction — this never throws, and a null is a FAILURE to the caller
 * rather than an answer.
 */
async function scrapeRawHtml(url: string, apiKey: string): Promise<null | string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FIRECRAWL_TIMEOUT_MS);

  try {
    const response = await fetch(FIRECRAWL_SCRAPE_URL, {
      body: JSON.stringify({ formats: ["rawHtml"], url }),
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      method: "POST",
      signal: controller.signal,
    });

    if (!response.ok) {
      logEvent("warn", "beatport.scrape-failed", { status: response.status });

      return null;
    }

    const payload = (await response.json()) as { data?: { rawHtml?: string } };

    return payload.data?.rawHtml ?? null;
  } catch (err) {
    logEvent("warn", "beatport.scrape-error", { error: err });

    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The search results embedded in the page, as Beatport's own data rather than as rendered text.
 *
 * Returns null when the island is missing or unparseable — a STRUCTURAL failure, distinct from an
 * empty result list, which is a real "Beatport has nothing for this query". The caller maps the two
 * to different ledger writes, so collapsing them here would silently turn a Beatport redesign into
 * a wave of confident "not found" receipts.
 */
export function parseSearchTracks(html: string): BeatportSearchTrack[] | null {
  const island = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html);

  if (!island?.[1]) {
    return null;
  }

  try {
    const data = JSON.parse(island[1]) as {
      props?: { pageProps?: { dehydratedState?: { queries?: unknown[] } } };
    };
    const queries = data.props?.pageProps?.dehydratedState?.queries;

    if (!Array.isArray(queries)) {
      return null;
    }

    // The search page hydrates one query per page shape; the one that matters is whichever carries
    // a `tracks.data` array. Found by shape rather than by index or key name, so a reordering (or a
    // new sibling query) does not break the read.
    for (const query of queries) {
      const rows = (query as { state?: { data?: { tracks?: { data?: unknown } } } })?.state?.data
        ?.tracks?.data;

      if (Array.isArray(rows)) {
        return rows as BeatportSearchTrack[];
      }
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Beatport's OWN links for the results on this page, as `track_id → absolute URL`.
 *
 * This is the only sanctioned source of a track's URL (see the header): the slug cannot be derived
 * and a wrong one does not announce itself. First link per id wins — the same track can appear in
 * more than one block on the page, and they agree.
 */
export function parseTrackLinks(html: string): Map<string, string> {
  const links = new Map<string, string>();
  const pattern = /href="(https:\/\/www\.beatport\.com\/track\/[a-z0-9%-]+\/(\d+))"/g;
  let match = pattern.exec(html);

  while (match) {
    const [, url, id] = match;

    if (url && id && !links.has(id)) {
      links.set(id, url);
    }

    match = pattern.exec(html);
  }

  return links;
}

/**
 * Pick this recording's URL out of one search page.
 *
 * THE GATE IS EXACT ISRC EQUALITY AND NOTHING ELSE. No title similarity, no artist overlap, no
 * duration window — a result whose ISRC is not byte-equal to the one Fluncle holds is not this
 * recording, however close its title reads. That is what makes the stored link safe to render
 * without a human ever checking it.
 */
export function pickBeatportUrl(
  html: string,
  isrc: string,
): { ok: false } | { ok: true; url: null | string } {
  const tracks = parseSearchTracks(html);

  if (tracks === null) {
    // The page did not carry the data island in the shape we understand. Nothing learned.
    return { ok: false };
  }

  const wanted = isrc.trim().toUpperCase();

  if (!wanted) {
    return { ok: true, url: null };
  }

  const links = parseTrackLinks(html);
  const hits = tracks
    .filter((track) => (track.isrc ?? "").trim().toUpperCase() === wanted)
    .slice(0, MAX_CANDIDATES);

  for (const hit of hits) {
    const url = links.get(String(hit.track_id ?? ""));

    if (url) {
      return { ok: true, url };
    }
  }

  // Either no result carried this ISRC, or the ones that did were not linked on the page. Both are
  // honest conclusions from a search that ran to the end.
  return { ok: true, url: null };
}

/**
 * Resolve ONE recording's Beatport URL: one search scrape, then the exact-ISRC pick.
 *
 * A no-op returning `{ configured: false }` when `FIRECRAWL_API_KEY` is unset, exactly as the Apple
 * leg no-ops without its MusicKit secrets — so this whole ecosystem ships dark and lights up when
 * the key is present, and never records an attempt it did not make.
 */
export async function resolveBeatportUrl(input: {
  artists: string[];
  isrc: string;
  title: string;
}): Promise<BeatportResolveOutcome> {
  const apiKey = await readOptionalEnv("FIRECRAWL_API_KEY");

  if (!apiKey) {
    return { configured: false };
  }

  const isrc = input.isrc.trim();

  if (!isrc) {
    // The worklist is ISRC-gated, so this is a caller bug rather than a real state; answer as a
    // clean conclusion rather than spending a scrape that could not decide anything.
    return { configured: true, ok: true, url: null };
  }

  const html = await scrapeRawHtml(beatportSearchUrl(input.artists, input.title), apiKey);

  if (html === null) {
    return { configured: true, error: "beatport search scrape failed", ok: false };
  }

  const picked = pickBeatportUrl(html, isrc);

  if (!picked.ok) {
    return { configured: true, error: "beatport search page shape not recognised", ok: false };
  }

  return { configured: true, ok: true, url: picked.url };
}
