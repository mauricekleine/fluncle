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
// An ISRC is not unique in this archive (468 of 33,472 ISRCs are shared, ~1.4%)
// and neither is a MusicBrainz recording id across birth paths. So a key lookup always answers with
// an ARRAY, and each entry says how it stands to the others: `canonical` when it is the only answer,
// `duplicate-of:<trackId>` when Fluncle has already ruled it a duplicate, and `ambiguous` when
// several rows survive and nobody has ruled. Collapsing that to one row would be picking a winner
// silently, which is exactly the vendor behaviour this surface exists to not repeat.

import { type AnchorRefusalReason, anchorRefusalReason, ANCHOR_MAX_ATTEMPTS } from "./track-work";
import { getDb, typedRows } from "./db";
import { parseArtistsJson } from "./artists";
import { siteUrl } from "../fluncle-links";
import { ALL_TRACK_OR_LOG_ID_MATCHES_CTE } from "./track-id-resolver";

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
 * a hedge: ADPLA §3.3.6(D) (MusicKit), retrieved verbatim, says "You agree not to call
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
 *   · `fingerprint`    — Fluncle matched the audio against the official preview, either while
 *                        buying a capture or while re-deriving an older one's provenance. The
 *                        only method here where the EVIDENCE IS THE SOUND rather than metadata.
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
  | "fingerprint"
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
  "fingerprint",
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
    youtube: IdentityState;
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
    t.backfill_deezer_attempted_at, t.backfill_deezer_attempts,
    t.youtube_video_id, t.youtube_video_official, t.youtube_verified_at,
    t.youtube_verified_by,
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
  backfill_deezer_attempted_at: null | string;
  backfill_deezer_attempts: null | number;
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
  youtube_verified_at: null | string;
  youtube_verified_by: null | string;
  youtube_video_id: null | string;
  youtube_video_official: null | number;
};

/**
 * The keys a caller may look a recording up by. Exactly one KIND is honoured; the op enforces that.
 *
 * The ISRC arm carries a LIST rather than a single value: an ISRC is the one key a caller holds in
 * bulk (a whole library's worth arrives from one export), so it is the one that answers a batch.
 * A single ISRC is a one-element list and reads exactly as it always did.
 */
export type IdentityKey =
  | { idOrLogId: string; kind: "idOrLogId" }
  | { isrcs: string[]; kind: "isrc" }
  | { kind: "mbid"; mbid: string }
  | { kind: "spotify"; spotifyId: string }
  | { deezerId: string; kind: "deezer" };

/**
 * The key grammar itself lives in the CLIENT-SAFE `lib/identity-key.ts` — pure string work with no
 * imports — and is re-exported here so every server caller keeps this one entrypoint. The split
 * exists so `/identity`'s route can canonicalize a submitted key inside its eagerly-bundled
 * `loader` without dragging the `getDb` chain into the browser's entry chunk
 * (docs/client-bundle.md rule 1).
 */
export {
  normalizeDeezerKey,
  normalizeIsrcKey,
  normalizeMbidKey,
  normalizeSpotifyKey,
} from "../identity-key";

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
 * THE DEEZER ANSWER, off the id Fluncle keeps for a recording (`tracks.deezer_track_id`) and the
 * honest-miss ledger beside it (`tracks.backfill_deezer_*`).
 *
 * THREE STATES, each backed by a real column:
 *   · a held id → `verified` with the rung that won it (`isrc` | `search` | `search-subset`, all
 *     three gated at the write) and `atMeaning: "verified"`, since the stamp beside it is the moment
 *     the link was WRITTEN rather than a look concluding. A NULL method reads `unknown-legacy` — the
 *     same honest "we hold no record of how" the Spotify answer serves, though no write path can
 *     produce one here.
 *   · no id but an attempt on file → `absent`, carrying the real monotone `attempts` tally. The
 *     Beatport shape exactly, and for the same reason: `retry: "single-shot"` with `terminal: null`
 *     says the receipt states the attempt and promises nothing, because no re-check cadence is ruled
 *     for this leg. `terminal: null` is "we do not know whether we will look again", never a claim
 *     that we will not — and when a cadence is ruled this becomes `recheckable` with no other change.
 *   · neither → `unattempted`. Nobody has gone looking, which is exactly true.
 *
 * THE `absent` BRANCH IS NARROW ON PURPOSE, and that narrowness is the whole point of the ledger.
 * Only a concluded Deezer look stamps it — today the anchor rung's ISRC recovery, on a verified hit
 * or on a gate-clean miss (anchor.ts § recoverIsrcViaDeezer). A quota-shaped empty result, an
 * unverifiable row, and every publish-time read stamp NOTHING (schema.ts § `backfill_deezer_*` lists
 * each one and why), so they keep reading `unattempted`. The failure mode this rules out is the one
 * that matters: a row that was checked and missed must never keep saying "Not checked yet", and a row
 * nothing could conclude on must never be dressed up as a search that came back empty.
 *
 * There is still nothing to `refuse`: this leg has no attempt cap to spend.
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

  if (row.backfill_deezer_attempted_at) {
    return {
      attempts: row.backfill_deezer_attempts ?? 0,
      cap: null,
      lastAttemptedAt: row.backfill_deezer_attempted_at,
      retry: "single-shot",
      state: "absent",
      terminal: null,
    };
  }

  return { state: "unattempted" };
}

/**
 * How a held YouTube id came to be trusted, read off the stored column and NARROWED rather than
 * cast. The column is written by one server path, but a value it does not recognise must degrade to
 * the honest legacy answer instead of reaching `methodFragment` as a method that does not exist —
 * the receipt would then print nothing at all and the reader would be told less, not more.
 */
function youtubeMethod(storedBy: null | string): IdentityMethod {
  return storedBy === "search" ? "search" : "fingerprint";
}

/**
 * THE YOUTUBE ANSWER, off the capture provenance Fluncle keeps for a recording
 * (`tracks.youtube_video_id` + `youtube_video_official`).
 *
 * TWO STATES, and only two — the same shape as Deezer's, for a related reason and a different one.
 *
 * The related reason: NO YOUTUBE SEARCH EVER CONCLUDES HERE. The id is a by-product of the capture
 * sweep buying this recording's audio, not of a look for a YouTube link, so there is no attempt to
 * report and `absent` would be a lie — it would claim a search ran and came back empty. There is
 * likewise nothing to refuse.
 *
 * The different one, and the load-bearing half: TWO SEPARATE FACTS HAVE TO BE TRUE before a link
 * renders. The fingerprint proved the AUDIO is this recording; it proved nothing about whether the
 * upload is legitimate, because a rip carries the same bytes as the master. So `official === 1` —
 * the server-side oEmbed verdict (lib/server/youtube-official.ts) — is the permission, and the id
 * alone is not. A held id whose verdict is 0 (checked, refused) or NULL (never concluded) reads
 * exactly as one Fluncle does not hold: `unattempted`, rendering nothing, saying nothing. That is
 * honest rather than evasive — no look was made on the reader's behalf either way, and the archive
 * declining to point somewhere is not a fact about the recording.
 *
 * A shown link's METHOD IS STORED (`youtube_verified_by`), on the Deezer precedent, because there is
 * now more than one way to earn one. A fingerprint match — the capture gate, the findings backfill,
 * the catalogue ladder's segment rung — is `fingerprint`, the only method in the envelope whose
 * evidence is the sound. An `<Artist> - Topic` art track accepted on artist, title and length alone
 * is `search`, the same claim class the Spotify anchor makes, and it renders as the weaker sentence
 * it is: nothing was listened to, and the receipt says so. NULL is the shape of a row written before
 * the column existed, when the fingerprint was the only path that could write an id at all — so the
 * fallback is `fingerprint` rather than `unknown-legacy`, and every historic receipt reads exactly
 * as it did.
 *
 * `atMeaning: "verified"`, because the stamp beside it is the moment the check ran and the link was
 * written, not the moment a search concluded.
 *
 * SERVED TO BOTH AUDIENCES, like every row but Apple's.
 */
function youtubeState(row: IdentityRow): IdentityState {
  const id = row.youtube_video_id?.trim();

  // The verdict is the permission. `Number(...)` rather than a truthiness test: 0 and null are
  // different facts internally, and both must fall through to the same silence here.
  if (id && Number(row.youtube_video_official) === 1) {
    return verified(youtubeMethod(row.youtube_verified_by), row.youtube_verified_at, "verified", {
      url: `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`,
      value: id,
    });
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
      youtube: youtubeState(row),
    },
    logId: row.log_id,
    relation,
    title: row.title,
    trackId: row.track_id,
  };
}

/**
 * Wrap rows in the envelope.
 *
 * The argument is a list of GROUPS, one per key the caller asked about, and that grouping is
 * load-bearing rather than tidy: `relationsFor` decides `canonical` vs `ambiguous` by counting the
 * unruled rows BESIDE a row, and beside means "under the same key". A batch of twenty ISRCs that
 * each match one recording is twenty canonical answers; flattened first, it would be twenty rows
 * calling each other ambiguous — the envelope's one claim about Fluncle's own opinion, inverted by
 * an argument shape. A single key is one group and reads exactly as it always did.
 */
function toEnvelope(groups: IdentityRow[][], audience: IdentityAudience): IdentityEnvelope {
  return {
    meta: {
      asOf: new Date().toISOString(),
      attribution: IDENTITY_ATTRIBUTION,
      contact: IDENTITY_CONTACT,
    },
    recordings: groups.flatMap((rows) => {
      const relations = relationsFor(rows);

      return rows.map((row) =>
        toRecording(row, relations.get(row.track_id) ?? "canonical", audience),
      );
    }),
  };
}

/**
 * The most rows one key may answer with. An ISRC collision is 2–3 rows in the measured corpus, so
 * this never bites in practice; it exists so a pathological key cannot turn one read into an
 * unbounded page. A batch is bounded by this PER KEY (the statement's `limit` scales with the key
 * count, and each key's group is capped again in memory), so no single pathological ISRC can eat a
 * batch's whole budget and starve the nineteen keys behind it.
 */
const IDENTITY_MAX_ROWS = 25;

/**
 * The stored spellings of ONE Spotify track id, all three of them.
 *
 * A recording reaches this archive by more than one road and each road spells the same Spotify
 * track differently, so a link handed in at the door has to be matched against all three or the
 * answer depends on how the row happened to be born:
 *
 *   · `<id>`               — a published finding. Its row IS keyed by the Spotify id (publish.ts).
 *   · `sp_<id>`            — the freshness tap's catalogue mint (label-releases.ts, `sp_` namespace).
 *   · `spotify:track:<id>` — the `spotify_uri` an anchor wrote onto a crawler row (anchor.ts),
 *                            whose own key is the MusicBrainz `mb_<uuid>` mint instead.
 *
 * All three are EQUALITIES — two on the primary key, one on `tracks_spotify_uri_idx` — never a
 * `like`. SQLite plans the disjunction as a `MULTI-INDEX OR` across those indexes; a `like` (or one
 * unindexed arm) collapses the whole statement into a scan of a table where every embedded row
 * drags a 4 KB vector blob off the page.
 */
function spotifyKeyArms(spotifyId: string): { args: string[]; where: string } {
  return {
    args: [spotifyId, `sp_${spotifyId}`, `spotify:track:${spotifyId}`],
    where: `(t.track_id = ? or t.track_id = ? or t.spotify_uri = ?)`,
  };
}

/**
 * Read a recording's identity by whichever key the caller supplied. `undefined` means the key
 * matched nothing — the op turns that into a 404 with no submission affordance, because a machine
 * caller must never be invited to file into the crew's triage queue.
 *
 * `audience` defaults to `machine`, the cautious side: a new caller has to ASK for the first-party
 * Apple state rather than inherit it by forgetting the argument.
 *
 * Every branch is ONE indexed statement, and only the named columns come back — no embedding blob is
 * ever dragged across this read, which over a table this shape is the whole cost question. The
 * index behind each: the PK / `findings.log_id` for the path key, `tracks_isrc_idx` for an ISRC
 * (one seek per key in the batch), `tracks_mb_recording_id_idx` for an MBID, the PK +
 * `tracks_spotify_uri_idx` for a Spotify link, and `tracks_deezer_track_id_idx` for a Deezer one.
 */
export async function readIdentity(
  key: IdentityKey,
  audience: IdentityAudience = "machine",
): Promise<IdentityEnvelope | undefined> {
  const db = await getDb();

  // A BATCH IS ONE STATEMENT. `in (?, ?, …)` over `tracks_isrc_idx` is one seek per key, where a
  // request per key would be twenty round trips from a Worker; the row budget scales with the key
  // count so twenty keys can answer as fully as one does.
  const isrcs = key.kind === "isrc" ? key.isrcs : [];

  // An empty ISRC list can only mean the op let a keyless batch through; answer nothing rather than
  // emit `in ()`, which SQLite reads as a syntax error.
  if (key.kind === "isrc" && isrcs.length === 0) {
    return undefined;
  }

  const query =
    key.kind === "isrc"
      ? {
          args: [...isrcs, IDENTITY_MAX_ROWS * Math.max(isrcs.length, 1)],
          where: `t.isrc in (${isrcs.map(() => "?").join(", ")})`,
        }
      : key.kind === "mbid"
        ? { args: [key.mbid, IDENTITY_MAX_ROWS], where: `t.mb_recording_id = ?` }
        : key.kind === "spotify"
          ? (() => {
              const arms = spotifyKeyArms(key.spotifyId);

              return { args: [...arms.args, IDENTITY_MAX_ROWS], where: arms.where };
            })()
          : key.kind === "deezer"
            ? { args: [key.deezerId, IDENTITY_MAX_ROWS], where: `t.deezer_track_id = ?` }
            : {
                args: [key.idOrLogId, key.idOrLogId, key.idOrLogId, IDENTITY_MAX_ROWS],
                where: "1 = 1",
              };
  const referenceLookup = key.kind === "idOrLogId";

  const result = await db.execute({
    args: query.args,
    // Non-reference branches retain their established SQL ordering. A reference has at most two
    // indexed matches, so it is sorted below in memory instead of buying a temporary compound-query
    // sort; callers still receive the same track-ID order.
    sql: `${referenceLookup ? `with ${ALL_TRACK_OR_LOG_ID_MATCHES_CTE}` : ""}
          select ${IDENTITY_SELECT}
          ${
            referenceLookup
              ? `from resolved_tracks
                 join tracks t on t.track_id = resolved_tracks.track_id
                 left join findings f on f.track_id = t.track_id`
              : IDENTITY_FROM
          }
          where ${query.where}
          ${referenceLookup ? "" : "order by t.track_id asc"}
          limit ?`,
  });

  const rows = typedRows<IdentityRow>(result.rows);

  if (referenceLookup) {
    // The removed SQL `order by t.track_id` used SQLite's default BINARY collation. Keep that exact
    // ordering without a compound-query temp sort; localeCompare would reorder case/punctuation.
    rows.sort((left, right) =>
      left.track_id < right.track_id ? -1 : left.track_id > right.track_id ? 1 : 0,
    );
  }

  if (rows.length === 0) {
    return undefined;
  }

  return toEnvelope(key.kind === "isrc" ? groupByIsrc(rows, isrcs) : [rows], audience);
}

/**
 * Split a batch's rows back into one group per ISRC the caller asked for, IN THE ORDER THEY ASKED.
 *
 * Two things ride on this. The order means a caller reading the answer top to bottom reads it in
 * the order of their own request, and a key that matched nothing simply contributes no rows (the
 * response carries every match's own ISRC, so the caller maps by value rather than by position).
 * The grouping is what keeps `relation` honest — see `toEnvelope`.
 */
function groupByIsrc(rows: IdentityRow[], isrcs: string[]): IdentityRow[][] {
  return isrcs
    .map((isrc) => rows.filter((row) => row.isrc === isrc).slice(0, IDENTITY_MAX_ROWS))
    .filter((group) => group.length > 0);
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
