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
  "get_health",
  "get_radio_now_playing",
  "get_random_radio_track",
  "get_random_track",
  "get_similar_findings",
  "get_track",
  "list_artists",
  "list_editions",
  "list_mixtapes",
  "list_stories",
  "list_tracks",
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
  // The crew announcement — operator tier: it posts a public Telegram crew callout
  // (and is one-shot, marker-guarded), so the agent token 403s.
  announce_mixtape: "operator",
  approve_submission: "operator",
  // The artist-entity backfill — agent tier (adminAuth only, no operatorGuard):
  // internal + reversible metadata enrichment (no publish), so the box's agent-token
  // `fluncle-artist-backfill` cron drives it without an operator token.
  backfill_artists: "admin",
  backfill_discogs: "admin",
  backfill_lastfm: "admin",
  // The capture sweep is agent-allowed (admin tier): it only fills the public URL
  // Postiz withheld on create + links the analytics release-id — it publishes nothing.
  capture_post_urls: "admin",
  collect_private_galaxy_log: "private-session",
  // The follow queue's one-tap confirm (candidate → confirmed) — operator tier: it lets
  // a Firecrawl-sourced link onto the public artist page.
  confirm_artist_social: "operator",
  context_track: "admin",
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
  delete_recording: "operator",
  delete_subscription: "operator",
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
  // The `/admin` attention-queue digest read — admin tier (adminAuth only, no
  // operatorGuard), the list_*_admin precedent: it composes the same admin-tier reads
  // the snapshot draws from and publishes nothing, so the operator's CLI + Raycast
  // menu bar (and the box) read it with the agent token.
  get_attention: "admin",
  // The built clip caption read — admin tier (agent-allowed), the list_clips precedent:
  // a read the clip-card UI + the box can both consume.
  get_clip_caption: "admin",
  get_mixtape_social: "admin",
  get_private_account_export: "private-session",
  get_private_galaxy_progress: "private-session",
  get_private_mutation_token: "private-session",
  // The recording reads — admin tier (agent-allowed): the box's clip-cut cron resolves a
  // clip's recording (r2Key + tracklist + promoted logId) via `get_recording`.
  get_recording: "admin",
  get_submission: "admin",
  // The single-finding admin lookup — admin tier (agent-allowed read), the
  // list_tracks_admin / get_recording precedent: an authoritative by-coordinate read
  // the board + CLI + box can all consume.
  get_track_admin: "admin",
  initiate_mixtape_youtube: "operator",
  // The `/admin/artists` review queue read — admin tier (agent-allowed), the list_*_admin
  // precedent; the operator's review-queue station consumes it.
  list_artist_socials: "admin",
  // Every clip's IG drip row — admin tier (agent-allowed read), the list_*_admin
  // precedent; the CLI / library merge it onto the clips.
  list_clip_posts: "admin",
  // The clip library/editor read — admin tier (agent-allowed), the list_*_admin
  // precedent. Filterable by mixtapeId/status; serves the editor + the library.
  list_clips: "admin",
  list_editions_admin: "admin",
  // The logbook sweep's self-healing window + material read — admin tier
  // (agent-allowed), the list_editions_admin precedent; the box's `fluncle-logbook`
  // cron reads it to pick the next sector-day to author and gather its findings.
  list_logbook_gaps: "admin",
  list_mixtapes_admin: "admin",
  list_private_saved_findings: "private-session",
  list_private_submissions: "private-session",
  list_recordings: "admin",
  list_submissions: "admin",
  list_subscriptions: "admin",
  list_track_social: "admin",
  list_tracks_admin: "admin",
  // The artist-sweep resolve worklist (artists awaiting social resolution) — agent
  // tier (adminAuth only): a read the box's `fluncle-artist-sweep` cron drives with
  // its agent-scoped token to pick the next batch, the list_*_admin precedent.
  list_unresolved_artists: "admin",
  merge_private_galaxy_progress: "private-session",
  // The REF-05 public → private preview-bucket migration — operator tier: a one-off,
  // destructive-capable data move (it can delete public R2 objects), so an agent
  // token 403s. Dry-run by default; the CLI must opt into a real run.
  migrate_preview_archive: "operator",
  mint_mixcloud_token: "operator",
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
  // The append-only cost ledger's write (COST-01) — agent tier (adminAuth only, no
  // operatorGuard), the record_health precedent; the box's sweeps POST their cost
  // rows with the agent token, and it writes only the internal cost_events ledger
  // (no publish), so the agent token drives it.
  record_cost: "admin",
  // The box's status cron POSTs a health snapshot — agent tier (adminAuth only, no
  // operatorGuard), the context_track/note_track precedent; it writes only the
  // internal service_status/status_events tables (no publish), so the agent token drives it.
  record_health: "admin",
  // The live-set poller's write — admin tier (adminAuth, no operatorGuard), the
  // record_health precedent; it writes only the internal single-row live_state table
  // (no publish), so the box agent token drives it each minute.
  record_live_state: "admin",
  reject_submission: "operator",
  // The review queue's inline remove of a social — operator tier.
  remove_artist_social: "operator",
  // Replace a recording's whole cue set — operator tier (the Rekordbox derivation write
  // target): a write that reshapes what a clip/promote resolves to, so the agent 403s.
  replace_recording_cues: "operator",
  // Clears a LIVE published video (video_url + video_squared_at) to re-queue a
  // re-render — operator-only (adminAuth + operatorGuard); the box agent never
  // clears videos, so an agent token 403s.
  requeue_video: "operator",
  // resolve_artist — the box's agent-token artist-socials resolution (MB + Firecrawl); internal
  // enrichment only, so agent-tier (adminAuth, no operatorGuard) like backfill_artists.
  resolve_artist: "admin",
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
  save_private_finding: "private-session",
  send_edition: "operator",
  // The clip drip-feed kill switch — operator tier: pausing/resuming the whole drip is
  // the operator's control, not the box's (the box only ticks the drip).
  set_clip_drip: "operator",
  // The operator's clip-drip schedule control (set/override a clip's slot) — operator tier.
  set_clip_schedule: "operator",
  // The batch clip-schedule sibling (schedule a selection at once) — operator tier, like
  // its single sibling; the box agent token 403s.
  set_clip_schedules: "operator",
  // The hardened post-publish cue backfill — operator tier: it rewrites a published
  // set's surface, so the agent token 403s.
  set_mixtape_cues: "operator",
  start_lastfm_auth: "operator",
  sweep_push_receipts: "admin",
  // The pre-chew triage verdict write — agent tier (adminAuth only, no operatorGuard),
  // the note_track precedent: the on-box `fluncle-triage` sweep annotates a pending
  // submission with its agent-scoped token. Advisory only; approve/reject stay operator.
  triage_submission: "admin",
  unsave_private_finding: "private-session",
  update_clip: "operator",
  update_edition: "admin",
  // The operator's logbook overwrite/edit — operator tier: it CAN replace a
  // cron-authored entry (an operator entry always wins) and stamps it sacred, so a
  // valid agent token 403s.
  update_logbook_entry: "operator",
  update_mixtape: "operator",
  // The interactive single-cue write (Studio cue rail) — operator tier: it re-times a
  // published set's surface, so the agent token 403s (like set_mixtape_cues).
  update_mixtape_cue: "operator",
  update_private_profile: "private-session",
  update_recording: "operator",
  update_subscription: "operator",
  update_track: "admin",
  update_track_social: "operator",
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
