// THE IDENTITY ENVELOPE (RFC dnb-identity-graph, Unit 2) — one honest answer about one recording's
// identifiers and platform links, keyed by Fluncle's track id, a Log ID, an ISRC, or a MusicBrainz
// recording id. Served by `get_track`'s identity projection.
//
// WHAT MAKES IT DIFFERENT from every other link resolver: it says the NEGATIVE out loud. Per
// platform the answer is one of
//
//   · `verified`    — we hold a link, and here is how and when we checked it;
//   · `absent`      — we looked, it was not there, and here is when we last looked and whether we
//                     will look again;
//   · `refused`     — we will not look, and here is which of the row's own conditions stops us;
//   · `unattempted` — nobody has looked yet;
//   · `unsupported` — Fluncle hands out no link of that kind at all.
//
// ONE field answers by AUDIENCE, and only one: Apple Music. A machine caller reads `unsupported`
// (the ADPLA clause below bars passing those links on), while Fluncle's own `/identity` page reads
// the real state, exactly as that recording's `/log` page already renders it. See
// `IdentityAudience`; nothing else in the answer differs between the two readers.
//
// Nobody says the middle three, and Fluncle can because the acquisition machinery has counted its
// attempts all along. Every state below is computed from a real column. Where no column backs a
// claim the field is `null` rather than a guess: `terminal: null` on a platform with no cap and no
// doctrine, `at: null` with `atMeaning: null` on a link that predates its own timestamp column.
// That is the whole discipline here — it is better to say "we do not know" than to say a number.
//
// ── WHAT IT NEVER SAYS ────────────────────────────────────────────────────────────────────────
// Tier lives in exactly ONE field: the `certified` boolean. No field name, no enum value, and no
// reason string carries a noun for the tier, so an uncertified recording is served the same shape
// as a certified one and simply reads `certified: false` with a null `logId`. Identifiers and links
// are data and are served for every row (the precedent: six public unauthenticated ops already do);
// the coordinate, the note, and every Fluncle-authored word belong to the certification and stay
// absent. `title` / `artists` are the RECORDING's own metadata, not Fluncle's words, and ride along
// so a caller resolving a shared ISRC can tell the returned rows apart at all.
//
// ── THE ARRAY IS NOT A CONVENIENCE ────────────────────────────────────────────────────────────
// An ISRC is not unique in this archive (measured 2026-07-29: 468 of 33,472 ISRCs are shared, ~1.4%)
// and neither is a MusicBrainz recording id across birth paths. So a key lookup always answers with
// an ARRAY, and each entry says how it stands to the others: `canonical` when it is the only answer,
// `duplicate-of:<trackId>` when Fluncle has already ruled it a duplicate, and `ambiguous` when
// several rows survive and nobody has ruled. Collapsing that to one row would be picking a winner
// silently, which is exactly the vendor behaviour this surface exists to not repeat.

import { type AnchorRefusalReason, anchorRefusalReason, ANCHOR_MAX_ATTEMPTS } from "./track-work";
import { getDb, typedRows } from "./db";
import { parseArtistsJson } from "./artists";
import { siteUrl } from "../fluncle-links";

/** The public fix-it address (RFC ruling 6) — the one channel for "this answer is wrong". */
export const IDENTITY_CONTACT = "hey@fluncle.com";

/**
 * The MusicBrainz attribution the envelope carries, per MetaBrainz's terms: core recording data
 * (recordings, relationships, identifiers) is CC0, and saying where it came from is both the
 * courtesy and the audit trail for anyone checking Fluncle's homework.
 */
export const IDENTITY_ATTRIBUTION =
  "Recording identifiers include data from MusicBrainz (musicbrainz.org), released under CC0.";

/**
 * WHETHER APPLE MUSIC LINKS ARE SERVED TO MACHINES. `false`, and the reason is a clause rather than
 * a hedge: ADPLA §3.3.6(D) (MusicKit), retrieved verbatim 2026-07-29, says "You agree not to call
 * the MusicKit APIs … for purposes unrelated to facilitating access to Your end users' Apple Music
 * subscriptions" and "album art and music-related text from the MusicKit API may not be used
 * separately from music playback or managing playlists". Fluncle's Apple links come from that API
 * (the exact-ISRC `filter[isrc]` backfill), and handing them to an arbitrary machine caller is
 * neither of those permitted purposes.
 *
 * WHAT IT DOES NOT REACH: Fluncle's own pages. The clause bars REDISTRIBUTION, and rendering an
 * Apple link on `/identity/<key>` is the same first-party act as rendering it on that recording's
 * `/log` page, which has always done so. So the gate is keyed on the AUDIENCE
 * ({@link IdentityAudience}) rather than on the envelope: a machine caller reads `unsupported`, the
 * page reads the real state. If the posture is ever re-ruled, this constant is the only line that
 * moves.
 */
export const APPLE_LINKS_MACHINE_SERVED = false;

/**
 * WHO IS ASKING. It changes exactly one field in the whole envelope — Apple Music — and the default
 * is the cautious one.
 *
 *   · `machine`     — a third party through `get_track`'s identity projection. Apple answers
 *                     `unsupported` while {@link APPLE_LINKS_MACHINE_SERVED} is false.
 *   · `first-party` — Fluncle's own `/identity` page, rendering the Apple link exactly as `/log`
 *                     already renders it, honest negatives included.
 *
 * Nothing else in the answer differs by audience: same rows, same identifiers, same tier discipline,
 * same meter. A reader and a machine that disagreed about anything more than Apple's licence would
 * make this surface's whole "the page and the API cannot answer differently" claim a lie.
 */
export type IdentityAudience = "first-party" | "machine";

/**
 * How a link or identifier came to be trusted. CLOSED; every value is backed by a stored column or
 * by the row's own primary key, and the set is asserted equal to the contract's enum by a test.
 *
 *   · `isrc`           — an ISRC equality decided it. The recording's real identity.
 *   · `operator`       — a human read the evidence and ruled.
 *   · `pk-derived`     — the identifier IS the row's origin, not a lookup result.
 *   · `publish`        — the link came in with the add, re-read through the platform's own API.
 *   · `search`         — the full verified triple cleared.
 *   · `search-subset`  — the tighter proper-subset fallback cleared. A weaker artist signal paid
 *                        for with a harder duration one, and deliberately not folded into `search`.
 *   · `unknown-legacy` — Fluncle holds no record of how. Never a claim about the check itself.
 */
export type IdentityMethod =
  | "isrc"
  | "operator"
  | "pk-derived"
  | "publish"
  | "search"
  | "search-subset"
  | "unknown-legacy";

/**
 * The same set as a runtime value, so the contract's enum and this union can be asserted equal by a
 * test instead of drifting apart the first time one side gains a member. The `satisfies` keeps the
 * two definitions honest with each other in the type system as well.
 */
export const IDENTITY_METHODS = [
  "isrc",
  "operator",
  "pk-derived",
  "publish",
  "search",
  "search-subset",
  "unknown-legacy",
] as const satisfies readonly IdentityMethod[];

/**
 * What happens next after a miss.
 *
 *   · `capped`      — a bounded run of retries, then the row is left alone (`cap` says how many).
 *   · `recheckable` — asked again indefinitely, because the upstream catalogue can grow.
 *   · `single-shot` — asked once. A second look would ask the same question of the same data.
 */
export type IdentityRetry = "capped" | "recheckable" | "single-shot";

/** How one entry stands to the others a key returned. */
export type IdentityRelation = "ambiguous" | "canonical" | `duplicate-of:${string}`;

/** The per-platform / per-identifier answer. `state` is the discriminant. */
export type IdentityState =
  | {
      /**
       * Total concluded looks. Present ONLY where a monotone counter backs it. Deliberately ABSENT
       * for Spotify: `spotify_anchor_attempts` is a spend BUDGET that the kill-flag requeue
       * DECREMENTS, so serving it as "how many times we looked" would be a false claim. The
       * `lastAttemptedAt` and the cap-derived `terminal` beside it are true either way.
       */
      attempts?: number;
      /** The retry ceiling when `retry` is `capped`; null otherwise. */
      cap: null | number;
      lastAttemptedAt: null | string;
      retry: IdentityRetry;
      state: "absent";
      /**
       * Whether Fluncle will ever look again. `null` where no column backs a verdict either way —
       * an honest "we do not know", never a guess in either direction.
       */
      terminal: boolean | null;
    }
  | { reason: AnchorRefusalReason; state: "refused" }
  | { state: "unattempted" }
  | { state: "unsupported" }
  | {
      state: "verified";
      url?: string;
      value?: string;
      verification: {
        at: null | string;
        /**
         * What `at` MEANS. `verified` = the moment the link was written. `attempted` = the moment a
         * look concluded, which is close but is not the same claim. `null` = no timestamp column
         * backs it. This field exists because serving an attempt time as a verification time is the
         * easiest lie in the whole envelope to tell by accident.
         */
        atMeaning: "attempted" | "verified" | null;
        method: IdentityMethod;
        /** Which rung fetched the candidate, where one is recorded. */
        source: null | string;
      };
    };

/** One recording's identity, as served. */
export type IdentityRecording = {
  artists: string[];
  /** The ONLY tier carrier in the whole envelope. */
  certified: boolean;
  identifiers: { isrc: IdentityState; mbRecordingId: IdentityState };
  links: {
    appleMusic: IdentityState;
    beatport: IdentityState;
    deezer: IdentityState;
    discogs: IdentityState;
    spotify: IdentityState;
    tidal: IdentityState;
  };
  /** Carried beside `certified`, never inferred from it (a straggler mid-publish has neither). */
  logId: null | string;
  relation: IdentityRelation;
  title: string;
  trackId: string;
};

export type IdentityEnvelope = {
  meta: { asOf: string; attribution: string; contact: string };
  recordings: IdentityRecording[];
};

/** The columns one recording's answer is computed from. Explicit: no blob ever crosses this wire. */
const IDENTITY_SELECT = `t.track_id, t.title, t.artists_json, t.duration_ms,
    t.isrc, t.isrc_attempted_at,
    t.mb_recording_id, t.mb_recording_id_attempted_at,
    t.spotify_uri, t.spotify_anchor_attempted_at, t.spotify_anchor_attempts,
    t.spotify_anchor_source, t.spotify_anchor_verified_by, t.spotify_anchored_at,
    t.apple_music_url, t.backfill_apple_music_attempted_at, t.backfill_apple_music_attempts,
    t.backfill_apple_music_done_at,
    t.in_release_id, t.backfill_discogs_attempted_at, t.backfill_discogs_attempts,
    t.backfill_discogs_done_at,
    t.beatport_url, t.beatport_verified_at, t.backfill_beatport_attempted_at,
    t.backfill_beatport_attempts,
    t.deezer_track_id, t.deezer_verified_at, t.deezer_verified_by,
    t.dismissed_at, t.duplicate_of_track_id,
    f.log_id as log_id, (f.track_id is not null) as has_finding`;

const IDENTITY_FROM = `from tracks t left join findings f on f.track_id = t.track_id`;

type IdentityRow = {
  apple_music_url: null | string;
  artists_json: null | string;
  backfill_apple_music_attempted_at: null | string;
  backfill_apple_music_attempts: null | number;
  backfill_apple_music_done_at: null | string;
  backfill_beatport_attempted_at: null | string;
  backfill_beatport_attempts: null | number;
  backfill_discogs_attempted_at: null | string;
  backfill_discogs_attempts: null | number;
  backfill_discogs_done_at: null | string;
  beatport_url: null | string;
  beatport_verified_at: null | string;
  deezer_track_id: null | string;
  deezer_verified_at: null | string;
  deezer_verified_by: null | string;
  dismissed_at: null | string;
  duplicate_of_track_id: null | string;
  duration_ms: null | number;
  has_finding: number;
  in_release_id: null | number;
  isrc: null | string;
  isrc_attempted_at: null | string;
  log_id: null | string;
  mb_recording_id: null | string;
  mb_recording_id_attempted_at: null | string;
  spotify_anchor_attempted_at: null | string;
  spotify_anchor_attempts: null | number;
  spotify_anchor_source: null | string;
  spotify_anchor_verified_by: null | string;
  spotify_anchored_at: null | string;
  spotify_uri: null | string;
  title: string;
  track_id: string;
};

/** The keys a caller may look a recording up by. Exactly one is honoured; the op enforces that. */
export type IdentityKey =
  | { idOrLogId: string; kind: "idOrLogId" }
  | { isrc: string; kind: "isrc" }
  | { kind: "mbid"; mbid: string };

/**
 * The key grammar itself lives in the CLIENT-SAFE `lib/identity-key.ts` — pure string work with no
 * imports — and is re-exported here so every server caller keeps this one entrypoint. The split
 * exists so `/identity`'s route can canonicalize a submitted key inside its eagerly-bundled
 * `loader` without dragging the `getDb` chain into the browser's entry chunk
 * (docs/client-bundle.md rule 1).
 */
export { normalizeIsrcKey, normalizeMbidKey } from "../identity-key";

/** The bare Spotify track id behind a stored `spotify:track:<id>` URI. */
function spotifyTrackId(uri: null | string): string | undefined {
  const id = (uri ?? "").replace(/^spotify:track:/, "").trim();

  return id && id !== uri?.trim() ? id : undefined;
}

/**
 * THE SPOTIFY HOP (RFC ruling 7). Every Spotify link Fluncle SERVES for following is his own
 * `/out/spotify/<trackId>` 302, keyed on Fluncle's track id and never on the Spotify id, because an
 * id in the path would BE the mapping this surface is metered to hand out deliberately. The raw
 * link stays stored and is what the redirect resolves to.
 *
 * The one carve-out lives elsewhere and is enforced by its own test: JSON-LD `sameAs` keeps the RAW
 * link, because that block is a machine identity ASSERTION rather than a link being served, and a
 * redirect there would poison the knowledge-graph anchoring.
 */
export function spotifyHopUrl(trackId: string): string {
  return `${siteUrl}/out/spotify/${encodeURIComponent(trackId)}`;
}

/** The `verified` arm, spelled once. */
function verified(
  method: IdentityMethod,
  at: null | string,
  atMeaning: "attempted" | "verified" | null,
  extra: { source?: null | string; url?: string; value?: string } = {},
): IdentityState {
  return {
    state: "verified",
    ...(extra.url ? { url: extra.url } : {}),
    ...(extra.value ? { value: extra.value } : {}),
    verification: {
      at: at ?? null,
      // A timestamp we do not hold cannot mean anything, so the two move together.
      atMeaning: at ? atMeaning : null,
      method,
      source: extra.source ?? null,
    },
  };
}

/**
 * THE SPOTIFY ANSWER. Ordered `verified` → `refused` → `absent` → `unattempted`, and the order is
 * the information gradient: "we hold it" beats "we will not look", which beats "we looked", which
 * beats "nobody has looked". A row at the attempt cap is `refused` rather than `absent`, because
 * "we looked six times and stopped" is the more useful of the two true things.
 */
function spotifyState(row: IdentityRow): IdentityState {
  const id = spotifyTrackId(row.spotify_uri);

  if (id) {
    return verified(
      // NULL provenance ⇒ `unknown-legacy`: anchored before the columns existed. It is "we hold no
      // record of how", never a claim about the check itself. Every live write path now records
      // one, publish included, so this reading drains rather than accumulating.
      (row.spotify_anchor_verified_by as IdentityMethod | null) ?? "unknown-legacy",
      row.spotify_anchored_at,
      "verified",
      { source: row.spotify_anchor_source, url: spotifyHopUrl(row.track_id), value: id },
    );
  }

  // The SHARED predicate: the five permanent exclusions the anchor worklist itself is built on
  // (track-work.ts `anchorEligibilityClause`), so the wire and the queue cannot drift.
  const refusal = anchorRefusalReason({
    artistsJson: row.artists_json,
    dismissedAt: row.dismissed_at,
    duplicateOfTrackId: row.duplicate_of_track_id,
    durationMs: row.duration_ms,
    spotifyAnchorAttempts: row.spotify_anchor_attempts,
  });

  if (refusal) {
    return { reason: refusal, state: "refused" };
  }

  if (row.spotify_anchor_attempted_at) {
    return {
      // No `attempts`: the counter is a spend budget the requeue decrements (see IdentityState).
      cap: ANCHOR_MAX_ATTEMPTS,
      lastAttemptedAt: row.spotify_anchor_attempted_at,
      retry: "capped",
      state: "absent",
      // Under the cap and not refused above, so more looks are coming. Backed by the counter the
      // worklist itself gates on, which is the only thing that decides it.
      terminal: false,
    };
  }

  return { state: "unattempted" };
}

/**
 * THE ISRC ANSWER. Every fill path re-runs whenever a row is eligible (the crawl's MusicBrainz read,
 * publish's Spotify read, the Deezer recovery rung), so a miss is `recheckable` and `terminal` is
 * `null`: no column anywhere says "stop asking for this row's ISRC", and inventing a `false` would
 * be as much a guess as inventing a `true`.
 *
 * The stamp is an ATTEMPT time even on a hit, because that is the only ISRC timestamp Fluncle keeps
 * and there is no separate "filled at". `atMeaning: "attempted"` says so on the wire.
 */
function isrcState(row: IdentityRow): IdentityState {
  const isrc = row.isrc?.trim();

  if (isrc) {
    return verified("unknown-legacy", row.isrc_attempted_at, "attempted", { value: isrc });
  }

  if (row.isrc_attempted_at) {
    return {
      cap: null,
      lastAttemptedAt: row.isrc_attempted_at,
      retry: "recheckable",
      state: "absent",
      terminal: null,
    };
  }

  return { state: "unattempted" };
}

/**
 * THE MUSICBRAINZ ANSWER. `pk-derived` when the row was born from a MusicBrainz recording (its
 * primary key IS `mb_<mbid>`, so the identifier is not a lookup result but the row's own origin);
 * `unknown-legacy` otherwise, because the ISRC→recording drain that filled the rest records no rung.
 *
 * A miss is `single-shot`: the drain stamps every terminal outcome and never revisits, so a stamped
 * miss really is the end of it. That makes `terminal: true` a claim a column supports.
 */
function musicbrainzState(row: IdentityRow): IdentityState {
  const mbid = row.mb_recording_id?.replace(/^mb_/, "").trim();

  if (mbid) {
    return verified(
      row.track_id.startsWith("mb_") ? "pk-derived" : "unknown-legacy",
      row.mb_recording_id_attempted_at,
      "attempted",
      { url: `https://musicbrainz.org/recording/${mbid}`, value: mbid },
    );
  }

  if (row.mb_recording_id_attempted_at) {
    return {
      cap: null,
      lastAttemptedAt: row.mb_recording_id_attempted_at,
      retry: "single-shot",
      state: "absent",
      terminal: true,
    };
  }

  return { state: "unattempted" };
}

/**
 * THE DISCOGS ANSWER, off the recording-grain attempt record on `tracks`.
 *
 * The retry class SPLITS by tier, and honestly: only the per-finding sweep ever revisits a Discogs
 * look, and it cannot reach a row with no `findings` row, so an uncertified recording's mint-time
 * look is the only one it will ever get (`single-shot`) while a certified one is re-asked under the
 * sweep's cooldown (`recheckable`). `terminal` is `null` for both: neither has a cap, and neither
 * carries a doctrine that would let Fluncle promise a verdict.
 */
function discogsState(row: IdentityRow): IdentityState {
  const releaseId = row.in_release_id;
  const certified = Number(row.has_finding) === 1;

  if (releaseId !== null && releaseId !== undefined) {
    return verified("unknown-legacy", row.backfill_discogs_done_at, "verified", {
      url: `https://www.discogs.com/release/${releaseId}`,
      value: String(releaseId),
    });
  }

  if (row.backfill_discogs_attempted_at) {
    return {
      attempts: row.backfill_discogs_attempts ?? 0,
      cap: null,
      lastAttemptedAt: row.backfill_discogs_attempted_at,
      retry: certified ? "recheckable" : "single-shot",
      state: "absent",
      terminal: null,
    };
  }

  return { state: "unattempted" };
}

/**
 * THE DEEZER ANSWER, off the id Fluncle keeps for a recording (`tracks.deezer_track_id`).
 *
 * TWO STATES, and only two, because only two are backed by a column. Fluncle holds a Deezer id or he
 * does not, and there is NO attempt record here at all: the id is kept as a by-product of reads run
 * for other reasons (the anchor rung's ISRC recovery, the add flow's ISRC fallback and its
 * label/preview enrichment), and none of those is a Deezer LOOK that could conclude. So a row with
 * no id reads `unattempted` — nobody has gone looking, which is exactly true — and never `absent`,
 * which would claim a search ran and came back empty. There is likewise nothing to `refuse`.
 *
 * A held id is `verified` with the rung that won it (`isrc` | `search` | `search-subset`, all three
 * gated at the write) and `atMeaning: "verified"`, since the stamp beside it is the moment the link
 * was WRITTEN rather than a look concluding. A NULL method reads `unknown-legacy` — the same honest
 * "we hold no record of how" the Spotify answer serves, though no write path can produce one here.
 *
 * SERVED TO BOTH AUDIENCES. Unlike Apple, no licence clause bars passing a Deezer link on, so the
 * page and the API answer identically and this function takes no audience.
 */
function deezerState(row: IdentityRow): IdentityState {
  const id = row.deezer_track_id?.trim();

  if (id) {
    return verified(
      (row.deezer_verified_by as IdentityMethod | null) ?? "unknown-legacy",
      row.deezer_verified_at,
      "verified",
      { url: `https://www.deezer.com/track/${encodeURIComponent(id)}`, value: id },
    );
  }

  return { state: "unattempted" };
}

/**
 * THE BEATPORT ANSWER, off the store link Fluncle keeps for a recording (`tracks.beatport_url`).
 *
 * THE ONE PLACE THIS LINK IS ALLOWED TO SURFACE. `beatport_url` is a terminal artifact under
 * Beatport's terms (the §F rail on the column in db/schema.ts): this function and the /identity page
 * are its whole readership. It reaches no feed, no JSON-LD `sameAs`, no index, no embedding.
 *
 * THREE STATES, each backed by a real column:
 *   · a held URL → `verified`, `method: "isrc"` HARDCODED rather than stored. Exact ISRC equality is
 *     the only gate this leg has or could have — there is no looser rung to distinguish it from — so
 *     a `beatport_verified_by` column would be one value repeated forever. `atMeaning: "verified"`,
 *     because the stamp beside it is the moment the link was WRITTEN.
 *   · no URL but an attempt on file → `absent`, carrying the real monotone `attempts` tally (this one
 *     may print: unlike Spotify's, it is a count of looks, not a spend budget to be decremented).
 *     `retry: "single-shot"` and `terminal: null` together are the honest shape: no re-check policy
 *     is ruled for this leg yet, so the receipt reads "Not found · checked <date>" and promises
 *     nothing. `terminal: null` is "we do not know whether we will look again", never a claim that
 *     we will not — and when a re-check cadence is ruled, this becomes `recheckable` with no other
 *     change needed here.
 *   · neither → `unattempted`. Nobody has gone looking, which is exactly true of every finding until
 *     the sweep first runs.
 *
 * SERVED TO BOTH AUDIENCES. The Apple gate exists because Apple's licence bars passing its links to
 * machine callers; Beatport's terms bar MINING its content, which is a different constraint and one
 * this envelope already honours by keeping only a URL. So the page and the API answer identically
 * and this function takes no audience.
 */
function beatportState(row: IdentityRow): IdentityState {
  const url = row.beatport_url?.trim();

  if (url) {
    return verified("isrc", row.beatport_verified_at, "verified", { url, value: url });
  }

  if (row.backfill_beatport_attempted_at) {
    return {
      attempts: row.backfill_beatport_attempts ?? 0,
      cap: null,
      lastAttemptedAt: row.backfill_beatport_attempted_at,
      retry: "single-shot",
      state: "absent",
      terminal: null,
    };
  }

  return { state: "unattempted" };
}

/**
 * THE APPLE MUSIC ANSWER, computed in full off its real columns and then gated for a MACHINE caller
 * by {@link APPLE_LINKS_MACHINE_SERVED}. A `first-party` read (the `/identity` page) gets the real
 * state, because rendering an Apple link on Fluncle's own page is what `/log` has always done and is
 * not the redistribution the clause bars.
 *
 * The state: `verified` with `method: "isrc"` (the Apple leg is exact-ISRC or nothing, by the
 * column's own contract, so a wrong link cannot render) and `at` the moment the ISRC resolved to a
 * URL; a miss is `recheckable` and never terminal, because Apple's catalogue grows and a clean
 * no-match today is not a no-match forever.
 */
function appleMusicState(row: IdentityRow, audience: IdentityAudience): IdentityState {
  if (audience === "machine" && !APPLE_LINKS_MACHINE_SERVED) {
    return { state: "unsupported" };
  }

  const url = row.apple_music_url?.trim();

  if (url) {
    return verified("isrc", row.backfill_apple_music_done_at, "verified", { url, value: url });
  }

  if (row.backfill_apple_music_attempted_at) {
    return {
      attempts: row.backfill_apple_music_attempts ?? 0,
      cap: null,
      lastAttemptedAt: row.backfill_apple_music_attempted_at,
      retry: "recheckable",
      state: "absent",
      terminal: false,
    };
  }

  return { state: "unattempted" };
}

/**
 * Decide each returned row's relation to the others.
 *
 * A row Fluncle has already ruled a duplicate names what it duplicates. Of what is left, ONE
 * survivor is `canonical` and several are all `ambiguous` — nobody has ruled between them, and the
 * envelope says exactly that rather than picking a winner silently (the vendor behaviour measured
 * on Deezer's ISRC endpoint: it picks, with a ~7% silent title mismatch).
 */
function relationsFor(rows: IdentityRow[]): Map<string, IdentityRelation> {
  const undecided = rows.filter((row) => !row.duplicate_of_track_id);
  const out = new Map<string, IdentityRelation>();

  for (const row of rows) {
    const duplicateOf = row.duplicate_of_track_id;

    out.set(
      row.track_id,
      duplicateOf
        ? `duplicate-of:${duplicateOf}`
        : undecided.length > 1
          ? "ambiguous"
          : "canonical",
    );
  }

  return out;
}

/** One row → one served recording. */
function toRecording(
  row: IdentityRow,
  relation: IdentityRelation,
  audience: IdentityAudience,
): IdentityRecording {
  return {
    artists: parseArtistsJson(row.artists_json ?? "[]"),
    // The STRONG sense: a findings row that carries a Log ID. A straggler mid-publish has the row
    // but not the coordinate, and it is not certified until it has both — which is why `certified`
    // and `logId` are carried separately and neither is inferred from the other.
    certified: Number(row.has_finding) === 1 && Boolean(row.log_id),
    identifiers: { isrc: isrcState(row), mbRecordingId: musicbrainzState(row) },
    links: {
      appleMusic: appleMusicState(row, audience),
      beatport: beatportState(row),
      deezer: deezerState(row),
      discogs: discogsState(row),
      spotify: spotifyState(row),
      // No Tidal integration exists at all. Honest, and cheaper than pretending.
      tidal: { state: "unsupported" },
    },
    logId: row.log_id,
    relation,
    title: row.title,
    trackId: row.track_id,
  };
}

/** Wrap rows in the envelope, newest metadata first. */
function toEnvelope(rows: IdentityRow[], audience: IdentityAudience): IdentityEnvelope {
  const relations = relationsFor(rows);

  return {
    meta: {
      asOf: new Date().toISOString(),
      attribution: IDENTITY_ATTRIBUTION,
      contact: IDENTITY_CONTACT,
    },
    recordings: rows.map((row) =>
      toRecording(row, relations.get(row.track_id) ?? "canonical", audience),
    ),
  };
}

/**
 * The most rows one key may answer with. An ISRC collision is 2–3 rows in the measured corpus, so
 * this never bites in practice; it exists so a pathological key cannot turn one read into an
 * unbounded page.
 */
const IDENTITY_MAX_ROWS = 25;

/**
 * Read one recording's identity by whichever key the caller supplied. `undefined` means the key
 * matched nothing — the op turns that into a 404 with no submission affordance, because a machine
 * caller must never be invited to file into the crew's triage queue.
 *
 * `audience` defaults to `machine`, the cautious side: a new caller has to ASK for the first-party
 * Apple state rather than inherit it by forgetting the argument.
 *
 * Each branch is ONE indexed statement: the PK / `findings.log_id` for the path key, `tracks_isrc_idx`
 * for an ISRC, and `tracks_mb_recording_id_idx` for an MBID. Only the named columns come back — no
 * embedding blob is ever dragged across this read, which over a table this shape is the whole cost
 * question.
 */
export async function readIdentity(
  key: IdentityKey,
  audience: IdentityAudience = "machine",
): Promise<IdentityEnvelope | undefined> {
  const db = await getDb();

  const query =
    key.kind === "isrc"
      ? { args: [key.isrc, IDENTITY_MAX_ROWS], where: `t.isrc = ?` }
      : key.kind === "mbid"
        ? { args: [key.mbid, IDENTITY_MAX_ROWS], where: `t.mb_recording_id = ?` }
        : {
            args: [key.idOrLogId, key.idOrLogId, IDENTITY_MAX_ROWS],
            // The same OR shape `getTrackByIdOrLogId` has always used against production: SQLite's
            // OR optimization takes the PK for one arm and `findings.log_id` for the other.
            where: `(t.track_id = ? or f.log_id = ?)`,
          };

  const result = await db.execute({
    args: query.args,
    sql: `select ${IDENTITY_SELECT} ${IDENTITY_FROM}
          where ${query.where}
          order by t.track_id asc
          limit ?`,
  });

  const rows = typedRows<IdentityRow>(result.rows);

  return rows.length === 0 ? undefined : toEnvelope(rows, audience);
}

/**
 * The stored raw Spotify URL behind a track id, for the `/out/spotify/<trackId>` hop. `undefined`
 * when the id is unknown OR the row carries no anchor — the redirect 404s on both, since there is
 * nowhere honest to send the visitor.
 */
export async function readSpotifyHopTarget(trackId: string): Promise<string | undefined> {
  const db = await getDb();
  const result = await db.execute({
    args: [trackId],
    sql: `select spotify_url from tracks where track_id = ? limit 1`,
  });

  const url = typedRows<{ spotify_url: null | string }>(result.rows)[0]?.spotify_url?.trim();

  return url ? url : undefined;
}
