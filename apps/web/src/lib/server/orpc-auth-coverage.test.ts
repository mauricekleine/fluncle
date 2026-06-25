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
  "get_edition",
  "get_health",
  "get_radio_now_playing",
  "get_random_radio_track",
  "get_random_track",
  "get_track",
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
  add_mixtape_members: "operator",
  approve_submission: "operator",
  backfill_discogs: "admin",
  backfill_lastfm: "admin",
  // The capture sweep is agent-allowed (admin tier): it only fills the public URL
  // Postiz withheld on create + links the analytics release-id — it publishes nothing.
  capture_post_urls: "admin",
  collect_private_galaxy_log: "private-session",
  context_track: "admin",
  create_edition: "admin",
  create_mixtape: "operator",
  delete_edition: "operator",
  delete_mixtape: "operator",
  delete_private_account: "private-session",
  draft_track_social: "admin",
  exchange_lastfm_session: "operator",
  export_private_account_data: "private-session",
  finalize_mixtape_mixcloud: "operator",
  finalize_mixtape_youtube: "operator",
  // The autonomous render box links its own cut + sets video_url — agent tier
  // (adminAuth only, no operatorGuard); the box's agent token publishes its renders.
  finalize_track_video: "admin",
  get_mixtape_social: "admin",
  get_private_account_export: "private-session",
  get_private_galaxy_progress: "private-session",
  get_private_mutation_token: "private-session",
  get_submission: "admin",
  initiate_mixtape_youtube: "operator",
  list_editions_admin: "admin",
  list_mixtapes_admin: "admin",
  list_private_saved_findings: "private-session",
  list_private_submissions: "private-session",
  list_submissions: "admin",
  list_track_social: "admin",
  list_tracks_admin: "admin",
  merge_private_galaxy_progress: "private-session",
  mint_mixcloud_token: "operator",
  mint_youtube_token: "operator",
  // The auto-note authoring step — agent tier (adminAuth only, no operatorGuard), the
  // written-note sibling of observe_track/context_track; the box's agent token drives it.
  note_track: "admin",
  observe_track: "admin",
  // The autonomous render box signs its own R2 upload URLs — agent tier (adminAuth
  // only, no operatorGuard); the box's agent token publishes its renders.
  presign_track_video_uploads: "admin",
  publish_mixtape: "operator",
  publish_mixtape_youtube: "operator",
  publish_track: "operator",
  // Purges a LIVE published video's stale edge renditions (the re-render cache twin
  // of requeue_video) — operator-only (adminAuth + operatorGuard); the box agent
  // never acts on live videos, so an agent token 403s.
  purge_video: "operator",
  // The box's status cron POSTs a health snapshot — agent tier (adminAuth only, no
  // operatorGuard), the context_track/note_track precedent; it writes only the
  // internal service_status/status_events tables (no publish), so the agent token drives it.
  record_health: "admin",
  reject_submission: "operator",
  // Clears a LIVE published video (video_url + video_squared_at) to re-queue a
  // re-render — operator-only (adminAuth + operatorGuard); the box agent never
  // clears videos, so an agent token 403s.
  requeue_video: "operator",
  save_private_finding: "private-session",
  send_edition: "operator",
  set_mixtape_members: "operator",
  start_lastfm_auth: "operator",
  sweep_push_receipts: "admin",
  unsave_private_finding: "private-session",
  update_edition: "admin",
  update_mixtape: "operator",
  update_private_profile: "private-session",
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
