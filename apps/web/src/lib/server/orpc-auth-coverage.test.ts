import { describe, expect, it } from "vitest";
import { router } from "./orpc";
import { adminAuth, operatorGuard, privateUserAuth } from "./orpc-auth";

// The AUTH-TIER coverage scaffold for the oRPC migration — the exhaustiveness net
// the sibling orpc-coverage.test.ts / orpc-admin-coverage.test.ts draw over
// *contract presence*, drawn here over *auth tier*. Those nets guarantee every
// route has a contract; this one guarantees every contract op runs at exactly one
// EXPLICIT, deliberately-chosen auth tier — so an agent adding a new admin/`/me` op
// and forgetting the auth wiring fails the build instead of silently shipping an
// unauthenticated endpoint.
//
// The source of truth for an op's tier is the middleware chain its handler attaches
// in its domain module (../orpc-auth): a contract op is implemented as
// `os.<op>.use(<middleware>)…handler(…)`, and oRPC stores those middlewares on the
// built router at `router.<op>["~orpc"].middlewares`. Crucially, the static
// middleware singletons (`adminAuth`, `operatorGuard`, `privateUserAuth`) are
// REFERENCE-EQUAL on the router to the exports here — so the tier is read straight
// off the composed router, not parsed from source or re-derived by hand. There is
// no separate tier registry to drift; the running router IS the registry.
//
// The four tiers (../orpc-auth):
//   - "public-unauth"  — no auth middleware. An anonymous read/write (the public
//                        reads; the rate-limited device registry; GET /me, which
//                        returns user-or-null and never 401s). MUST be on the
//                        explicit allow-list below: a NEW op with no tier lands
//                        here and FAILS unless someone deliberately allow-lists it.
//   - "admin"          — `adminAuth` only. Any admin principal (operator OR agent).
//   - "operator"       — `adminAuth` + `operatorGuard`. Operator only (agent → 403).
//   - "private-session"— the `/me` cookie-session tier: either `privateUserAuth`
//                        (a signed-in read) or a `privateUserMutation(...)` factory
//                        middleware (a CSRF-guarded write). The factory returns a
//                        FRESH middleware per op (it closes over per-op
//                        action/limit), so it is not reference-identifiable like the
//                        singletons; it is recognised structurally as the one
//                        non-singleton auth middleware on the chain.
//
// How the guard bites:
//   - A new op with NO middleware derives "public-unauth"; if it is not on
//     PUBLIC_UNAUTH_OPS the "every op is on its declared tier" assertion fails —
//     the forgotten-auth case this test exists for.
//   - A new authenticated op (admin/operator/private) derives its tier from the
//     middleware refs; if EXPECTED_TIERS has no entry for it, the exhaustiveness
//     assertion fails — every op must be deliberately tiered.
//   - Going the other way: a public-read entry that gains a tier, or a tiered op
//     that loses its middleware, flips its derived tier and the equality fails.

type AuthTier = "admin" | "operator" | "private-session" | "public-unauth";

// The known static auth-middleware singletons, by reference. `privateUserMutation`
// is intentionally absent: it is a factory producing a fresh middleware per op, so
// it has no single reference to match — it is detected structurally below.
const STATIC_MIDDLEWARE_TIERS = new Map<unknown, "admin" | "operator" | "private-session">([
  [adminAuth, "admin"],
  [operatorGuard, "operator"],
  [privateUserAuth, "private-session"],
]);

// Read the middleware chain oRPC composed onto a router op. Typed loosely because
// oRPC's `~orpc` internals are not part of its public type surface.
function middlewaresOf(op: unknown): unknown[] {
  const orpc = (op as Record<string, unknown>)["~orpc"] as Record<string, unknown> | undefined;
  const middlewares = orpc?.middlewares;

  return Array.isArray(middlewares) ? middlewares : [];
}

// Derive an op's auth tier from its middleware chain.
//
//   - no middleware                       → "public-unauth"
//   - has `operatorGuard`                 → "operator" (it always rides on
//                                            `adminAuth`, so the operator tier wins)
//   - has `adminAuth` (no operatorGuard)  → "admin"
//   - has `privateUserAuth`               → "private-session"
//   - exactly one UNKNOWN (non-singleton) → "private-session" (the
//                                            `privateUserMutation(...)` write tier)
//   - anything else                       → null (unclassifiable → a hard failure,
//                                            never a silent pass)
function deriveTier(op: unknown): AuthTier | null {
  const middlewares = middlewaresOf(op);

  if (middlewares.length === 0) {
    return "public-unauth";
  }

  const tags = middlewares.map(
    (middleware) => STATIC_MIDDLEWARE_TIERS.get(middleware) ?? "unknown",
  );

  if (tags.includes("operator")) {
    return "operator";
  }

  if (tags.includes("admin")) {
    return "admin";
  }

  if (tags.includes("private-session")) {
    return "private-session";
  }

  // The only remaining legitimate shape is the `privateUserMutation(...)` write
  // tier: a single non-singleton auth middleware. Exactly one unknown ⇒ that. More
  // than one unknown, or any other mix, is an auth shape this guard does not
  // recognise — return null so it fails loudly rather than passing as a tier.
  if (tags.length === 1 && tags[0] === "unknown") {
    return "private-session";
  }

  return null;
}

// The ops that intentionally run UNAUTHENTICATED — the explicit allow-list. Adding
// a NEW public read forces a deliberate entry here (the test fails otherwise), so
// shipping an anonymous endpoint is always a conscious, reviewed choice.
const PUBLIC_UNAUTH_OPS = new Set<string>([
  // The public archive reads + Spotify candidate search (orpc-coverage.test.ts).
  // Artist reads — public, no auth required (Unit 4 of the artist-relationship RFC).
  "get_artist",
  "get_edition",
  // Galaxy reads — public, no auth (browse-by-feel RFC).
  "get_galaxy",
  // The GraphLink hover card's preview read — public, no auth. It carries the same facts
  // the entity's own public page already prints (its opening line, its finding count, a
  // few covers), so it exposes nothing the page does not.
  "get_graph_preview",
  "get_health",
  "get_radio_now_playing",
  "get_random_radio_track",
  "get_random_track",
  "get_similar_findings",
  "get_track",
  "list_artists",
  "list_editions",
  "list_galaxies",
  // The `/mix` rail read + the two taste-seed reads. All public-unauth: `/mix` is a free
  // tool a stranger uses with no account, and it exposes only what is already public on
  // every track chip (keys, BPMs, artist names). The `/mix` page's own gate is a live
  // archive-depth measurement, not auth.
  // What just came out — newest RELEASES over a 30-day window. Anonymous by design: it lists what
  // is already public everywhere (Spotify), and uncertified rows carry no coordinate (the Unlit Rule).
  "list_fresh",
  "list_mix_openers",
  "list_mixable_artists",
  "list_mixable_tracks",
  // Hydrate a whole shared `?set=` chain — the public twin of the web /mix loader's
  // getMixTracksByTokens. Public for the same reason as the openers/rail: a set row carries
  // only what every track chip already prints (keys, BPMs, artist names, cover).
  "list_set_tracks",
  "list_mixtapes",
  "list_stories",
  // The public /reach read — Fluncle's numbers across every platform, over time.
  // Anonymous by design: every number is already public on its own platform.
  "list_platform_stats",
  "list_tracks",
  // Fluncle's own archive search — the public read behind the CMD+K dialog and, at
  // catalogue scale, the primary navigation. Anonymous by design (it searches material that
  // is already public on every /log page); the LLM tier it can reach is bounded by the same
  // shared rate limiter `search_tracks` uses.
  "search_archive",
  "search_tracks",
  // Anonymous public writes, each guarded in-handler (rate limit / review queue),
  // not by an auth tier — intentionally open to non-signed-in callers.
  "deregister_device", // opt-out; idempotent, only shrinks the table.
  "register_device", // mobile push registry; in-handler rate limit, no identity.
  "submit_track", // public submission → the admin review queue.
  "subscribe_newsletter", // public newsletter opt-in.
  // GET /me returns user-or-null and never 401s, so it carries no auth tier (it is
  // the one `/me` op that is deliberately public — see orpc/me.ts).
  "get_current_private_user",
]);

// The deliberately-chosen tier for EVERY authenticated contract op. Together with
// PUBLIC_UNAUTH_OPS this map MUST cover the whole registry — that totality is the
// exhaustiveness guard: a new op missing from both fails the coverage assertion.
//
// admin       = any admin principal (operator OR agent): reads + the agent-driven
//               enrichment/observation/context writes the Hermes crons need.
// operator    = operator only: every publish-/irreversible-/credential-class op.
// private     = the `/me` cookie-session tier (read via privateUserAuth, write via
//               privateUserMutation).
const EXPECTED_TIERS: Record<string, "admin" | "operator" | "private-session"> = {
  // The `/admin/artists` follow queue's inline add (Unit 5, Epic B) — operator tier: an
  // operator-entered social lands confirmed + public at once.
  add_artist_social: "operator",
  // The render → publish AUTO-ADVANCE tick — ADMIN tier (adminAuth only, no
  // operatorGuard): the on-box `fluncle-publish-advance` cron drives it with the agent
  // token (the `drip_clips` / `capture_post_urls` precedent — the Worker owns the Postiz
  // key, the box only triggers). This is the op that lets the machine make a PUBLIC
  // YouTube push; the gate for that moved off the request tier onto the kill switch +
  // the readiness gates (see ../publish-advance.ts). `draft_track_social` still 403s an
  // agent-tier YouTube push, so nothing ELSE gained that power.
  advance_publish_queue: "admin",
  // The Spotify anchor write — ADMIN tier (adminAuth only, no operatorGuard), the
  // `rank_catalogue`/`verify_capture` precedent: the box's Apify anchor sweep POSTs verified
  // candidates and the Worker writes only catalogue-identity columns (`spotify_uri`/`spotify_url`),
  // never a certification, so the box's agent token drives it. See docs/catalogue-crawler.md § the anchor.
  anchor_track: "admin",
  // The crew announcement — operator tier: it posts a public Telegram crew callout
  // (and is one-shot, marker-guarded), so the agent token 403s.
  announce_mixtape: "operator",
  approve_submission: "operator",
  // The Apple catalogue drain — agent tier (adminAuth only): the catalogue sibling of
  // `backfill_apple_music`. It writes catalogue identity only (a URL on `tracks`, facts on
  // `albums`), never a certification, so the box's agent-token cron drives it.
  backfill_apple_catalogue: "admin",
  // The Apple Music URL backfill — agent tier (adminAuth only): internal + reversible
  // metadata enrichment (resolve each finding's Apple Music URL EXACTLY by ISRC, no
  // publish), so the box's agent-token cron drives it, the `backfill_discogs` precedent.
  backfill_apple_music: "admin",
  // The artist-avatar backfill — agent tier (adminAuth only): internal + reversible
  // enrichment (fetch each artist's Spotify image), same tier as backfill_artists.
  backfill_artist_images: "admin",
  // The artist-entity backfill — agent tier (adminAuth only, no operatorGuard):
  // internal + reversible metadata enrichment (no publish), so the box's agent-token
  // `fluncle-artist-backfill` cron drives it without an operator token.
  backfill_artists: "admin",
  // The owned-cover-master sweep (RFC U3b) — agent tier (adminAuth only): it resolves an
  // album's/artist's OWN ≤1200² cover into R2, publishes nothing, the `backfill_label_images`
  // precedent.
  backfill_cover_masters: "admin",
  backfill_discogs: "admin",
  // The label-logo resolve sweep — agent tier (adminAuth only): it resolves a label's OWN image
  // (Discogs → Wikidata) into R2, publishes nothing, so the box's agent-token cron drives it,
  // the `backfill_discogs` precedent.
  backfill_label_images: "admin",
  // The label-lineage resolve sweep — agent tier (adminAuth only): it writes a label's founding
  // facts + parent imprint onto the `labels` row (never mints a label, publishes nothing), so the
  // box's agent-token cron drives it, the `backfill_label_images` precedent.
  backfill_label_lineage: "admin",
  backfill_lastfm: "admin",
  // The MusicBrainz recording-MBID fill — agent tier (adminAuth only): the MusicBrainz identity
  // layer. It writes catalogue identity only (an MBID on `tracks`), never a certification, so the
  // box's agent-token cron drives it, the `backfill_label_images` precedent.
  backfill_recording_mbids: "admin",
  // The capture sweep is agent-allowed (admin tier): it only fills the public URL
  // Postiz withheld on create + links the analytics release-id — it publishes nothing.
  capture_post_urls: "admin",
  // Certify an existing catalogue row in place (docs/the-ear.md § The operator's actions) —
  // operator tier: certifying is the one act the catalogue domain forbids a machine (the
  // agent-tier sweep is agent-allowed precisely because it can never certify). The
  // `update_label` / `set_capture_budget` rule.
  certify_track: "operator",
  // The wrong-audio quarantine override (docs/the-ear.md § Wrong audio) — operator tier: an
  // agent does not get to reverse the machine's own wrong-audio verdict on its own output, the
  // same reasoning that keeps `update_label` and `set_capture_budget` operator-tier.
  clear_wrong_audio: "operator",
  collect_private_galaxy_log: "private-session",
  // The follow queue's one-tap confirm (candidate → confirmed) — operator tier: it lets
  // a Firecrawl-sourced link onto the public artist page.
  confirm_artist_social: "operator",
  // The label-alias review confirm (candidate → confirmed) — operator tier: deciding two
  // spellings are one label folds it into resolution + the public JSON-LD, an editorial act
  // (the confirm_artist_social / update_label precedent).
  confirm_label_alias: "operator",
  context_track: "admin",
  // The catalogue crawler — admin tier (adminAuth only, no operatorGuard): it acquires
  // METADATA and nothing else. It publishes nothing, certifies nothing (a crawled row has
  // no `findings` row, so no coordinate, no note, no video, no public surface), and
  // captures no audio. So the on-box `fluncle-crawl` sweep drives it with its agent token,
  // the `backfill_discogs` precedent. The act that decides what MAY be crawled — ruling on
  // a label — stays operator tier (`update_label`).
  crawl_catalogue: "admin",
  // The Fluncle Studio clip writes — operator tier: the agent never cuts/mints/prunes
  // clips, so an agent token 403s. `create_clip` is now recording-scoped (RFC
  // recording-primitive, Design B).
  create_clip: "operator",
  create_edition: "admin",
  // The logbook nightly author — admin tier (adminAuth only, no operatorGuard), the
  // note_track/create_edition precedent: the on-box `fluncle-logbook` cron drives the
  // fill-empty-only create with its agent token. A sector with an entry is a no-op.
  create_logbook_entry: "admin",
  // The RFC recording-primitive writes — operator tier: create/update/delete a captured
  // set + `promote` (mints a coordinate). The agent token 403s.
  create_recording: "operator",
  // The operator's private cost ledger (COST-02) — the writes are operator tier (the
  // operator's private spend data; a valid agent token 403s), the read is admin tier.
  create_subscription: "operator",
  delete_clip: "operator",
  // The operator's "unschedule" (take a clip off the drip queue) — operator tier, symmetric
  // with set_clip_schedule; the agent token 403s.
  delete_clip_schedule: "operator",
  delete_edition: "operator",
  delete_private_account: "private-session",
  // The recommendation-seed remove — private-session (privateUserMutation), the
  // delete_private_saved_set precedent (docs/the-ear.md § The per-user telescopes).
  delete_private_rec_seed: "private-session",
  delete_private_saved_set: "private-session",
  delete_recording: "operator",
  delete_subscription: "operator",
  // The album-bio authoring step — agent tier (adminAuth only, no operatorGuard), the
  // note_track precedent: the box's agent token drives the fill-empty-only voiced-bio write.
  describe_album: "admin",
  // The artist-bio authoring step — agent tier (adminAuth only, no operatorGuard), the
  // note_track precedent: the box's agent token drives the fill-empty-only voiced-bio write.
  describe_artist: "admin",
  // The label-bio authoring step — agent tier (adminAuth only): the note_track precedent.
  // Deliberately agent tier, unlike the operator-tier `update_label` crawl-seed ruling:
  // authoring a bio is enrichment, not an editorial ruling that steers the crawl.
  describe_label: "admin",
  // The album bio-draft — agent tier (adminAuth only), the describe_album precedent: the
  // box's bio sweep triggers this Worker-side grounding read (Firecrawl facts + finding
  // titles → a ready-to-author prompt) with its agent token. A pure read; it publishes nothing.
  draft_album_bio: "admin",
  // The artist bio-draft — agent tier (adminAuth only), the describe_artist precedent: the
  // box's bio sweep triggers this Worker-side grounding read (Firecrawl facts + finding
  // titles → a ready-to-author prompt) with its agent token. A pure read; it publishes nothing.
  draft_artist_bio: "admin",
  // The label bio-draft — agent tier (adminAuth only): the describe_label sibling of the
  // artist bio-draft. A pure read that gathers the box's grounding Worker-side; it publishes nothing.
  draft_label_bio: "admin",
  draft_track_social: "admin",
  // The clip drip-feed tick — ADMIN tier (adminAuth only, no operatorGuard): the on-box
  // `fluncle-clip-drip` cron drives it with the agent token (the `finalize_clip_cut` /
  // `record_health` box-cron precedent). The Worker owns the Postiz key; the box triggers.
  drip_clips: "admin",
  exchange_lastfm_session: "operator",
  export_private_account_data: "private-session",
  // The box's clip-cut finalize (Fluncle Studio Unit C) — agent tier (adminAuth only,
  // no operatorGuard), the finalize_track_video precedent: the on-box cron marks its
  // own cut done + the handler purges the stale edge renditions. The agent token drives it.
  finalize_clip_cut: "admin",
  finalize_mixtape_mixcloud: "operator",
  finalize_mixtape_youtube: "operator",
  // The autonomous render box links its own cut + sets video_url — agent tier
  // (adminAuth only, no operatorGuard); the box's agent token publishes its renders.
  finalize_track_video: "admin",
  // The wrong-audio counterpart flag — operator tier: it rewinds a PUBLIC finding's enrichment on
  // the strength of a human listen, a judgement a machine does not get to make (the
  // `clear_wrong_audio` reasoning).
  flag_wrong_audio: "operator",
  // The dupe-veto escape hatch (docs/the-ear.md § Duplicates) — operator tier: overruling the
  // machine's own duplicate verdict so a row can be captured is a judgement a machine does not get
  // to make about its own output (the `clear_wrong_audio` reasoning).
  force_capture: "operator",
  // The `/admin` attention-queue digest read — admin tier (adminAuth only, no
  // operatorGuard), the list_*_admin precedent: it composes the same admin-tier reads
  // the snapshot draws from and publishes nothing, so the operator's CLI + Raycast
  // menu bar (and the box) read it with the agent token.
  get_attention: "admin",
  // The capture budget's spend readout — admin tier (agent-allowed READ), the
  // `get_crawl_status` precedent. Reading what a metered budget has left spends nothing and
  // publishes nothing, and a sweep is entitled to know why the capture queue went quiet.
  // Its WRITE sibling (`set_capture_budget`) is operator-only — see below.
  get_capture_budget: "admin",
  // The built clip caption read — admin tier (agent-allowed), the list_clips precedent:
  // a read the clip-card UI + the box can both consume.
  get_clip_caption: "admin",
  // The crawl frontier's state — admin tier: the read half of `crawl_catalogue`, driven
  // by the same on-box sweep (and by the operator, to see where the walk got to).
  get_crawl_status: "admin",
  // The Frontier kill switch's READ — agent-allowed, the get_capture_budget precedent
  // (a read of an operator dial is not the dial).
  get_frontier_minting: "admin",
  // The catalogue funnel read (docs/rfcs/catalogue-funnel-rfc.md) — admin tier: the live
  // pipeline + the growth series behind `/admin/funnel`. A pure read (agent-allowed like
  // `get_crawl_status`); its snapshot WRITE sibling is `record_catalogue_snapshot`, below.
  get_funnel: "admin",
  // The dream-weaver's proposed-order read (RFC mixability-engine) — admin tier
  // (agent-allowed, like get_track_admin): a PURE read that never writes/publishes, so
  // no operatorGuard. `promote_recording` remains the only way a mixtape exists.
  get_mixable_order: "admin",
  get_mixtape_social: "admin",
  get_private_account_export: "private-session",
  // One of the signed-in user's frozen Frontier editions + its tracklist — private-session
  // (privateUserAuth), the get_private_frontier_playlist precedent. Scoped by the session
  // user; the number alone never reaches another user's edition.
  get_private_frontier_edition: "private-session",
  // The signed-in user's Frontier playlist state (E2) — private-session
  // (privateUserAuth), the get_private_galaxy_progress precedent.
  get_private_frontier_playlist: "private-session",
  get_private_galaxy_progress: "private-session",
  get_private_mutation_token: "private-session",
  // The signed-in user's cross-device preferences read (the key-notation sync) —
  // private-session (privateUserAuth), the get_private_galaxy_progress precedent.
  get_private_preferences: "private-session",
  // The recording reads — admin tier (agent-allowed): the box's clip-cut cron resolves a
  // clip's recording (r2Key + tracklist + promoted logId) via `get_recording`.
  // The prompt registry's per-tick resolve — AGENT tier (adminAuth only, no
  // operatorGuard), the record_cost/context_track precedent. This is THE read that lets a
  // prompt live in the database at all: the box runs a pinned CLI and a baked image, so
  // it can only reach a prompt over the API, with the agent token it already holds. It is
  // a pure read of an internal template (it publishes nothing), and it cannot fail — an
  // un-overridden slug resolves to the repo's baked default.
  get_prompt: "admin",
  get_recording: "admin",
  get_submission: "admin",
  // The single-finding admin lookup — admin tier (agent-allowed read), the
  // list_tracks_admin / get_recording precedent: an authoritative by-coordinate read
  // the board + CLI + box can all consume.
  get_track_admin: "admin",
  initiate_mixtape_youtube: "operator",
  // The album-bio worklist (albums with findings but no bio yet) — admin tier (agent-allowed
  // read), the list_labels_missing_bio precedent; the bio cron drains it. Publishes nothing.
  list_albums_missing_bio: "admin",
  // The `/admin/artists` review queue read — admin tier (agent-allowed), the list_*_admin
  // precedent; the operator's review-queue station consumes it.
  list_artist_socials: "admin",
  // The artist-bio worklist (artists with findings but no bio yet) — admin tier
  // (agent-allowed read), the list_unresolved_artists precedent; the future bio cron drains
  // it. A pure read; it publishes nothing.
  list_artists_missing_bio: "admin",
  // The ranked catalogue read (The Ear) — admin tier (agent-allowed), the
  // list_labels_admin precedent. An ordered walk of the columns the rank_catalogue
  // sweep precomputed; it returns catalogue rows only (no finding, no coordinate) and
  // publishes nothing.
  list_catalogue_tracks: "admin",
  // Every clip's IG drip row — admin tier (agent-allowed read), the list_*_admin
  // precedent; the CLI / library merge it onto the clips.
  list_clip_posts: "admin",
  // The clip library/editor read — admin tier (agent-allowed), the list_*_admin
  // precedent. Filterable by mixtapeId/status; serves the editor + the library.
  list_clips: "admin",
  list_editions_admin: "admin",
  // The full galaxy map read (browse-by-feel RFC) — admin tier (agent-allowed), the
  // list_*_admin precedent; the `fluncle-cluster` cron reads the prior map + split flags.
  list_galaxies_admin: "admin",
  // The open label-alias candidates the `/admin/labels` review section reads — admin tier
  // (agent-allowed), the list_labels_admin precedent. A pure read; it publishes nothing.
  list_label_aliases: "admin",
  // Every label with its crawl-seed state — admin tier (agent-allowed), the
  // list_galaxies_admin precedent: `?seedState=enabled` is the seed-set read the
  // catalogue crawler makes with its agent token. A pure read; it publishes nothing.
  list_labels_admin: "admin",
  // The label-bio worklist (labels with findings but no bio yet) — admin tier
  // (agent-allowed read), the list_labels_admin precedent; the future bio cron drains it.
  list_labels_missing_bio: "admin",
  // The logbook sweep's self-healing window + material read — admin tier
  // (agent-allowed), the list_editions_admin precedent; the box's `fluncle-logbook`
  // cron reads it to pick the next sector-day to author and gather its findings.
  list_logbook_gaps: "admin",
  list_mixtapes_admin: "admin",
  // The auto-notes the echo gate held back — admin tier (agent-allowed), the
  // list_labels_admin precedent. A pure read that publishes nothing; the sweep may want to
  // see what it has already had rejected, and the `/admin` queue reads it every tick.
  list_note_rejections: "admin",
  // The observation echo gate's held scripts + the box author's neighbourhood read — admin tier
  // (agent-allowed): the box sweep reads the neighbourhood every tick, and both are pure reads.
  list_observation_neighbours: "admin",
  list_observation_rejections: "admin",
  // The signed-in user's frozen Frontier editions list ("past editions" dropdown) —
  // private-session (privateUserAuth), the list_private_saved_findings precedent.
  list_private_frontier_editions: "private-session",
  // The collection browser read (the /account Galaxy tab) — private-session
  // (privateUserAuth), the get_private_galaxy_progress precedent.
  list_private_galaxy_collection: "private-session",
  // The recommendation-seed list — private-session (privateUserAuth), the
  // list_private_saved_findings precedent.
  list_private_rec_seeds: "private-session",
  // THE ENGINE's read — private-session (privateUserAuth). The verified-email
  // gate (403 email_unverified) and the hourly rate limit live in the handler +
  // helper, on TOP of the session tier — the tier here is the session carrier.
  list_private_recommendations: "private-session",
  list_private_saved_findings: "private-session",
  list_private_saved_sets: "private-session",
  list_private_submissions: "private-session",
  // The prompt registry's operator read — OPERATOR tier. It returns every prompt's full
  // edit history, and it is the surface the operator edits Fluncle's voice from; editing
  // what Fluncle SAYS is publish-class, so an agent token 403s. Its agent-tier sibling
  // `get_prompt` is the lean per-tick read the box actually needs.
  list_prompts: "operator",
  list_recordings: "admin",
  list_submissions: "admin",
  list_subscriptions: "admin",
  // The embedded corpus read — admin tier (agent-allowed): the cluster engine's input,
  // driven by the cron's agent token (the list_tracks_admin cursor precedent).
  list_track_embeddings: "admin",
  list_track_social: "admin",
  // `list_track_work` — the audio pipeline's worklist (capture/analyze/embed). A READ of
  // machine state, drained by the box's agent-token sweeps, exactly like list_tracks_admin.
  list_track_work: "admin",
  list_tracks_admin: "admin",
  // The artist-sweep resolve worklist (artists awaiting social resolution) — agent
  // tier (adminAuth only): a read the box's `fluncle-artist-sweep` cron drives with
  // its agent-scoped token to pick the next batch, the list_*_admin precedent.
  list_unresolved_artists: "admin",
  // The capture-verification backfill's worklist (docs/the-ear.md § Wrong audio) — admin tier
  // (agent-allowed read), the list_track_work precedent; the box's `fluncle-verify-captures` cron
  // drains it. A pure read; it publishes nothing.
  list_unverified_captures: "admin",
  // The user-account roster (the operator's read-only rollout window) — admin tier
  // (agent-allowed read), the list_labels_admin precedent. A pure read of accounts +
  // their derived artifact counts; it publishes nothing and mutates nothing.
  list_users_admin: "admin",
  // The label merge (RFC musickit-second-authority U2b) — operator tier: it re-points public
  // /label/<slug> URLs, reconciles operator rulings, and deletes a row, the update_label class.
  merge_label: "operator",
  merge_private_galaxy_progress: "private-session",
  // The REF-05 public → private preview-bucket migration — operator tier: a one-off,
  // destructive-capable data move (it can delete public R2 objects), so an agent
  // token 403s. Dry-run by default; the CLI must opt into a real run.
  migrate_preview_archive: "operator",
  mint_mixcloud_token: "operator",
  // The Frontier mint/refresh (E2) — private-session (privateUserMutation), the
  // save_private_rec_seed precedent. CSRF + a 4/h rate limit; the verified-email gate
  // and the DEFAULT-DENY kill switch live in the handler + helper, on top of the tier.
  mint_private_frontier_playlist: "private-session",
  mint_youtube_token: "operator",
  // The auto-note authoring step — agent tier (adminAuth only, no operatorGuard), the
  // written-note sibling of observe_track/context_track; the box's agent token drives it.
  note_track: "admin",
  observe_track: "admin",
  // The box's clip-cut upload presign (Fluncle Studio Unit C) — agent tier (adminAuth
  // only, no operatorGuard), the presign_track_video_uploads precedent: the on-box cron
  // signs its OWN clip output (`<clipId>/footage.mp4`) with the agent token. Distinct
  // from presign_set_video_upload below, which is OPERATOR-driven at distribute time.
  presign_clip_upload: "admin",
  // The recording set-video staging presign — operator tier (adminAuth + operatorGuard):
  // the `presign_set_video_upload` clone targeting the recording's owned key. Operator-
  // driven, like the mixtape set-video presign.
  presign_recording_upload: "operator",
  // The set-video staging presign (Fluncle Studio Unit A) — operator tier (adminAuth
  // + operatorGuard): it opens an upload that flips a public mixtape surface, so the
  // agent token 403s (unlike the agent-tier track/clip presigns).
  presign_set_video_upload: "operator",
  // The autonomous render box signs its own R2 upload URLs — agent tier (adminAuth
  // only, no operatorGuard); the box's agent token publishes its renders.
  presign_track_video_uploads: "admin",
  // Promote a recording → a published mixtape — operator tier: it mints a scarce
  // coordinate, so the agent token 403s.
  promote_recording: "operator",
  publish_mixtape_youtube: "operator",
  publish_track: "operator",
  // Purges a LIVE published video's stale edge renditions (the re-render cache twin
  // of requeue_video) — operator-only (adminAuth + operatorGuard); the box agent
  // never acts on live videos, so an agent token 403s.
  purge_video: "operator",
  // One tick of The Ear's precompute sweep — agent tier (adminAuth only, no
  // operatorGuard), the update_galaxy_map precedent: it writes only DERIVED ranking
  // columns, and only on CATALOGUE rows (a `tracks` row with no `findings` row). It
  // cannot mint a coordinate, write a note, or certify anything — those columns do not
  // exist on the rows it can reach — so the box's agent token drives it.
  rank_catalogue: "admin",
  // The append-only cost ledger's write (COST-01) — agent tier (adminAuth only, no
  // operatorGuard), the record_health precedent; the box's sweeps POST their cost
  // rows with the agent token, and it writes only the internal cost_events ledger
  // (no publish), so the agent token drives it.
  // The daily catalogue-funnel snapshot write (docs/rfcs/catalogue-funnel-rfc.md) — agent
  // tier (adminAuth only, no operatorGuard), the record_platform_stats precedent; the box's
  // funnel-snapshot cron POSTs a bare trigger and it writes only the internal
  // catalogue_snapshots ledger (no publish), so the agent token drives it.
  record_catalogue_snapshot: "admin",
  record_cost: "admin",
  // The box's status cron POSTs a health snapshot — agent tier (adminAuth only, no
  // operatorGuard), the context_track/note_track precedent; it writes only the
  // internal service_status/status_events tables (no publish), so the agent token drives it.
  record_health: "admin",
  // The live-set poller's write — admin tier (adminAuth, no operatorGuard), the
  // record_health precedent; it writes only the internal single-row live_state table
  // (no publish), so the box agent token drives it each minute.
  record_live_state: "admin",
  // The box's reach cron collects + POSTs a daily platform snapshot — agent tier
  // (adminAuth only, no operatorGuard), the record_health precedent; the Worker owns
  // every platform credential and the op writes only the internal platform_stats
  // table (no publish), so the box's agent token drives the bare trigger.
  record_platform_stats: "admin",
  // The weekly Frontier refresh (E2) — ADMIN tier (adminAuth only, no operatorGuard):
  // the box's `fluncle-frontier-refresh` cron drives it with the agent token, the
  // `advance_publish_queue` / `rank_catalogue` precedent. It re-mirrors playlists that
  // already exist (each minted by its own owner), so it creates no new public authority.
  refresh_frontier_playlists: "admin",
  // Discard a label-alias candidate — operator tier: ruling two spellings are NOT one label
  // is an editorial act (the remove_artist_social / confirm_label_alias precedent).
  reject_label_alias: "operator",
  reject_submission: "operator",
  // The review queue's inline remove of a social — operator tier.
  remove_artist_social: "operator",
  // Replace a recording's whole cue set — operator tier (the Rekordbox derivation write
  // target): a write that reshapes what a clip/promote resolves to, so the agent 403s.
  replace_recording_cues: "operator",
  // The terminal-unmatched rescue — operator tier: it re-arms metered capture spend across
  // hundreds of rows in one act, the `set_capture_budget` money-judgement class. It fires
  // after a MATCHER improvement (a human deploy decision), never on a sweep's own schedule.
  requeue_unmatched_captures: "operator",
  // Clears a LIVE published video (video_url + video_squared_at) to re-queue a
  // re-render — operator-only (adminAuth + operatorGuard); the box agent never
  // clears videos, so an agent token 403s.
  requeue_video: "operator",
  // The Apple failure-regime breaker reset (RFC musickit U1) — OPERATOR tier: it re-arms a
  // spend-adjacent external integration a machine should not silently un-brake (the
  // `set_capture_budget` neighbour's rule).
  reset_apple_breaker: "operator",
  // resolve_artist — the box's agent-token artist-socials resolution (MB + Firecrawl); internal
  // enrichment only, so agent-tier (adminAuth, no operatorGuard) like backfill_artists.
  resolve_artist: "admin",
  // The operator's ruling on an auto-note the echo gate held back — operator tier:
  // `accepted` OVERRULES the gate and writes the line onto the finding's public /log page,
  // which is publish-class (the update_galaxy / update_label precedent), so an agent token
  // 403s. The agent authors the note; only the operator may overrule its rejection.
  resolve_note_rejection: "operator",
  // Rendering a held observation overrules the gate and spends a Cartesia render — publish-class.
  resolve_observation_rejection: "operator",
  // The Mixcloud metadata re-sync — operator tier: it EDITS a LIVE published cloudcast's
  // sections[] (the Mixcloud edit endpoint, server-side with the mixcloud_auth token),
  // so the agent token 403s (the parity twin of resync_mixtape_youtube).
  resync_mixtape_mixcloud: "operator",
  // The YouTube metadata re-sync — operator tier: it EDITS a LIVE published video's
  // description (videos.update), so the agent token 403s (like publish_mixtape_youtube).
  resync_mixtape_youtube: "operator",
  // The "Looks good" acknowledgment — operator tier: it stamps the artist reviewed and promotes
  // surviving candidates onto the public artist page (the trust gate).
  review_artist: "operator",
  // The per-link approve in the fresh-links section — operator tier: marks a link reviewed and
  // promotes a candidate onto the public artist page (the trust gate, at the link grain).
  review_artist_social: "operator",
  save_private_finding: "private-session",
  // The recommendation-seed add — private-session (privateUserMutation), the
  // save_private_finding precedent; the 12-seed cap 409s in the helper.
  save_private_rec_seed: "private-session",
  save_private_set: "private-session",
  send_edition: "operator",
  // The catalogue capture budget + its kill switch — operator tier, like `set_clip_drip`
  // and `set_publish_advance`. It is the ONE operator-tier op in the `admin-catalogue`
  // domain, and deliberately so: every other op there is free (the crawler moves metadata,
  // the Ear moves vectors), while this one decides how much of the operator's money a
  // metered residential proxy may spend. An agent does not get to raise its own budget.
  set_capture_budget: "operator",
  // The clip drip-feed kill switch — operator tier: pausing/resuming the whole drip is
  // the operator's control, not the box's (the box only ticks the drip).
  set_clip_drip: "operator",
  // The operator's clip-drip schedule control (set/override a clip's slot) — operator tier.
  set_clip_schedule: "operator",
  // The batch clip-schedule sibling (schedule a selection at once) — operator tier, like
  // its single sibling; the box agent token 403s.
  set_clip_schedules: "operator",
  // The Frontier kill switch — operator only: opening minting grants the machine
  // authority over the operator's own Spotify account (the set_capture_budget class).
  set_frontier_minting: "operator",
  // The hardened post-publish cue backfill — operator tier: it rewrites a published
  // set's surface, so the agent token 403s.
  set_mixtape_cues: "operator",
  // The auto-advance kill switch — operator tier, like `set_clip_drip`: pausing/resuming
  // the whole auto-publish is the operator's control, never the box's.
  set_publish_advance: "operator",
  // The catalogue "not for me" / restore toggle (docs/the-ear.md § The operator's actions) —
  // operator tier: steering what the telescope keeps pointing at is a taste ruling, the
  // `update_label` class, so an agent may never dismiss.
  set_track_dismissed: "operator",
  start_lastfm_auth: "operator",
  sweep_push_receipts: "admin",
  // The pre-chew triage verdict write — agent tier (adminAuth only, no operatorGuard),
  // the note_track precedent: the on-box `fluncle-triage` sweep annotates a pending
  // submission with its agent-scoped token. Advisory only; approve/reject stay operator.
  triage_submission: "admin",
  unsave_private_finding: "private-session",
  // The fresh-links INLINE EDIT — operator tier: it corrects a social's URL AND approves it
  // (operator-owned, confirmed, public) in one act, the add_artist_social/#544 write path, so
  // an agent token 403s.
  update_artist_social: "operator",
  update_clip: "operator",
  update_edition: "admin",
  // The operator's galaxy naming write (browse-by-feel RFC) — operator tier: naming mints
  // a public URL (publish-class), so an agent token 403s at operatorGuard.
  update_galaxy: "operator",
  // The cluster cron's transactional map write — admin tier (agent-allowed): the Worker
  // mints new ids + handles; the box's `fluncle-cluster` cron drives it with its agent token.
  update_galaxy_map: "admin",
  // The operator's ruling on a label's crawl-seed state — operator tier: it steers what
  // Fluncle crawls NEXT (an editorial act, like naming a galaxy), so an agent token 403s
  // at operatorGuard. It changes no stored data — crawl scope, never storage.
  update_label: "operator",
  // The operator's logbook overwrite/edit — operator tier: it CAN replace a
  // cron-authored entry (an operator entry always wins) and stamps it sacred, so a
  // valid agent token 403s.
  update_logbook_entry: "operator",
  update_mixtape: "operator",
  // The interactive single-cue write (Studio cue rail) — operator tier: it re-times a
  // published set's surface, so the agent token 403s (like set_mixtape_cues).
  update_mixtape_cue: "operator",
  // Retuning the auto-note echo gate's thresholds — operator tier: the dials decide what
  // Fluncle will and will not say about his own archive, so an agent token 403s at
  // operatorGuard (the update_galaxy precedent). They live in the `settings` KV, so the
  // retune is a flip rather than a deploy.
  update_note_gate: "operator",
  update_observation_gate: "operator",
  // The `/me/preferences` cross-device store's partial-merge write — private-session
  // (privateUserMutation), the update_private_profile precedent.
  update_private_preferences: "private-session",
  update_private_profile: "private-session",
  update_private_saved_set: "private-session",
  // Appending a prompt version (an edit, a rollback, or a reset) — OPERATOR tier. A
  // prompt IS code: a bad edit silently degrades every artifact it touches. An agent
  // token 403s, so no automation can rewrite the words Fluncle speaks in.
  update_prompt: "operator",
  update_recording: "operator",
  update_subscription: "operator",
  update_track: "admin",
  update_track_social: "operator",
  // The mint-cover retry drain (E2) — admin tier (agent-allowed), the refresh_frontier_playlists
  // precedent: the box's cron (and the operator) render + upload every owing Frontier cover IN
  // THE WORKER with the agent token. It touches only playlists their owners already minted.
  upload_frontier_covers: "admin",
  // The capture-verification write (docs/the-ear.md § Wrong audio) — agent tier (adminAuth only),
  // the rank_catalogue precedent. It writes only derived/measurement columns and never certifies: a
  // catalogue mismatch quarantines (a machine may rewind an uncertified row), a FINDING mismatch is
  // only STAMPED for the operator's attention queue (the machine never rewinds a public finding).
  // So the box's `fluncle-verify-captures` agent token drives it.
  verify_capture: "admin",
};

describe("oRPC auth-tier coverage", () => {
  const ops = Object.keys(router as Record<string, unknown>);

  it("derives a tier for every contract op (no unclassifiable auth shape)", () => {
    for (const name of ops) {
      const tier = deriveTier((router as Record<string, unknown>)[name]);

      expect(
        tier,
        `op "${name}" has an auth-middleware shape this guard cannot classify — its tier must be exactly one of public-unauth / admin / operator / private-session`,
      ).not.toBeNull();
    }
  });

  it("assigns every contract op exactly one EXPLICIT tier (no untiered op slips in)", () => {
    for (const name of ops) {
      const derived = deriveTier((router as Record<string, unknown>)[name]);
      const declared: AuthTier | undefined = PUBLIC_UNAUTH_OPS.has(name)
        ? "public-unauth"
        : EXPECTED_TIERS[name];

      // Neither list claims the op ⇒ an op shipped with no deliberate tier. If it
      // derived "public-unauth", an agent added an endpoint and forgot the auth
      // wiring; if it derived an authenticated tier, the explicit map was not
      // updated. Either way: fail, with the derived tier named so the fix is obvious.
      expect(
        declared,
        `op "${name}" is not assigned an explicit auth tier — it derives "${derived}". Add it to EXPECTED_TIERS with its deliberate tier, or to PUBLIC_UNAUTH_OPS if it is intentionally unauthenticated.`,
      ).toBeDefined();

      // The declared tier must match what the router actually wired. A drift here
      // means the middleware chain and the documented tier disagree.
      expect(
        derived,
        `op "${name}" is declared "${declared}" but its middleware chain derives "${derived}" — reconcile the handler's .use(...) chain with its declared tier.`,
      ).toBe(declared);
    }
  });

  it("has no stale tier entries (every declared op maps to a real contract op)", () => {
    const known = new Set(ops);

    for (const name of PUBLIC_UNAUTH_OPS) {
      expect(known.has(name), `PUBLIC_UNAUTH_OPS entry "${name}" is not a real contract op`).toBe(
        true,
      );
    }

    for (const name of Object.keys(EXPECTED_TIERS)) {
      expect(known.has(name), `EXPECTED_TIERS entry "${name}" is not a real contract op`).toBe(
        true,
      );
    }
  });

  it("never lists an op as both public-unauth and authenticated", () => {
    for (const name of PUBLIC_UNAUTH_OPS) {
      expect(
        name in EXPECTED_TIERS,
        `op "${name}" is in BOTH PUBLIC_UNAUTH_OPS and EXPECTED_TIERS — it can have only one tier`,
      ).toBe(false);
    }
  });
});
