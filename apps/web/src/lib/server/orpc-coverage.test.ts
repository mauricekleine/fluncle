import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CONTRACT_OPERATION_NAMES, CONTRACT_OPERATION_ROUTES } from "@fluncle/contracts/orpc";

// Coverage scaffold for the oRPC migration. It enumerates the PUBLIC HTTP API
// routes and asserts
// each is either:
//   - CONVERTED — owned by an oRPC contract (named in the registry), or
//   - PENDING   — on the explicit, shrinking allow-list below, awaiting the
//                 fan-out phase, or
//   - a CARVE-OUT — intentionally staying on TanStack forever.
//
// A route that is none of these fails the build — that is the enforcement the
// migration exists for: a new public route with no contract can't slip in
// unnoticed. Going the other way is also a failure: a route may not be both
// converted AND pending (the pending list must shrink as routes convert), and a
// pending entry must correspond to a real route (no stale names).
//
// This net and the ADMIN net (orpc-admin-coverage.test.ts) PARTITION the registry, and
// the line between them is each op's DECLARED ROUTE PATH: an `/admin` path belongs to the
// sibling, everything else here. The path is a machine-readable fact the contract already
// carries, so every op lands on exactly one net — no gap, no overlap.
//
// Phase 1 converted one route (`get_track`); the fan-out pilot added the three
// public-unauth reads (`get_health`, `list_tracks`, `get_random_track`); fan-out
// Wave A converted the five remaining public-unauthenticated ops (`list_mixtapes`,
// `search_tracks`, `list_stories`, `submit_track`, `subscribe_newsletter`); fan-out
// Wave B converts the thirteen `/me` PRIVATE-SESSION ops (the user-auth tier in
// ../orpc-auth). With Wave B the PENDING list is EMPTY — the public surface is
// fully contract-first. The admin tier is its own later wave (carved out below).

// Each public API route, keyed by its `/api/v1`-relative path, mapped to the
// canonical Convention-B `verb_noun` op name it should be served by. This is the
// public-surface registry the coverage net is drawn over; admin + carve-outs are
// listed separately so the net's edges are explicit, not accidental.
const PUBLIC_ROUTE_OPS: Record<string, string> = {
  // The devices domain is contract-only oRPC (no TanStack route file under
  // /api/v1) — the mobile app's push-device registry, authored contract-first.
  // It has no file-enumeration entry; it lives here
  // so the "every public op is converted" check covers it.
  "DELETE /devices/{token}": "deregister_device",
  // The recommendation-seed domain (docs/the-ear.md § The per-user telescopes) —
  // contract-only oRPC (no TanStack route file under /api/v1/me); documented here
  // as part of the public surface net.
  "DELETE /me/rec-seeds/{trackId}": "delete_private_rec_seed",
  "DELETE /me/saved-findings/{trackId}": "unsave_private_finding",
  // The saved-`/mix`-sets slice of the private-user tier — contract-only oRPC (no TanStack
  // route file under /api/v1/me). The account never gates the tool: `/mix` stays fully usable
  // signed-out (the set lives in the URL), and these ops only let a signed-in user KEEP a chain.
  "DELETE /me/saved-sets/{id}": "delete_private_saved_set",
  // The watched-entities slice of the private-user tier — contract-only oRPC (no TanStack
  // route file under /api/v1/me). Signed-in storage only; every entity page stays fully
  // usable signed-out.
  "DELETE /me/watches/{id}": "delete_private_watch",
  // The albums domain — contract-only oRPC (the catalogue-browse API). No TanStack route
  // file under /api/v1/albums; oRPC serves these straight off the registry. Public reads,
  // catalogue-scoped + paginated, no auth.
  "GET /albums": "list_albums",
  "GET /albums/{slug}": "get_album",
  // The artists domain — contract-only oRPC (Unit 4 of the artist-relationship RFC).
  // No TanStack route file under /api/v1/artists; oRPC serves these straight off the
  // registry. Public reads (now catalogue-scoped + paginated), no auth required.
  "GET /artists": "list_artists",
  // The "sounds like these" multi-artist sonic read. A literal `/artists/similar` path — it takes
  // precedence over `/artists/{slug}` the same way `/tracks/random` does over `/tracks/{idOrLogId}`.
  "GET /artists/similar": "list_similar_artists",
  "GET /artists/{slug}": "get_artist",
  // The FEED — findings interleaved with published mixtapes, newest FOUND first. Contract-only oRPC
  // (no TanStack route file under /api/v1/findings; oRPC serves it straight off the registry). The
  // found-order twin of the release-ordered `list_tracks` enumerator.
  "GET /findings": "list_findings",
  // The galaxies domain — contract-only oRPC (browse-by-feel RFC). No TanStack route
  // file under /api/v1/galaxies; oRPC serves these straight off the registry. Public
  // reads, no auth. (The game's `/galaxy` route + galaxy.fluncle.com are unrelated.)
  "GET /galaxies": "list_galaxies",
  "GET /galaxies/{slug}": "get_galaxy",
  // The graph domain — the GraphLink hover card's one read. Contract-only oRPC, public,
  // no auth. Lazy per-entity (fetched on card open, cached by `(kind, slug)`), which is
  // why one op serves every graph link in the app without an N+1.
  "GET /graph/{kind}/{slug}": "get_graph_preview",
  "GET /health": "get_health",
  // The labels domain — contract-only oRPC (the catalogue-browse API). No TanStack route
  // file under /api/v1/labels; oRPC serves these straight off the registry. Public reads,
  // catalogue-scoped + paginated, blind to seed_state (crawl scope, never storage), no auth.
  "GET /labels": "list_labels",
  "GET /labels/{slug}": "get_label",
  "GET /me": "get_current_private_user",
  "GET /me/csrf": "get_private_mutation_token",
  "GET /me/export/{exportId}": "get_private_account_export",
  // The frozen Frontier editions history — contract-only oRPC (no TanStack route file
  // under /api/v1/me), documented here as part of the public surface net. Private-session
  // at the op (the session read scopes by user); zero editions is a clean empty array.
  "GET /me/frontier-editions": "list_private_frontier_editions",
  "GET /me/frontier-editions/{number}": "get_private_frontier_edition",
  // A signed-in user's ONE public Spotify playlist, "Fluncle's Frontier" — contract-only
  // oRPC (no TanStack route file under /api/v1/me). It lives on Fluncle's own Spotify
  // account (no per-user OAuth); the READ is a plain cookie-session read, the MINT is
  // CSRF-guarded and gated on a verified email.
  "GET /me/frontier-playlist": "get_private_frontier_playlist",
  // The signed-in traveller's collected findings, per galaxy — contract-only oRPC (no
  // TanStack route file under /api/v1/me), the read side of the Galaxy game's per-find write.
  "GET /me/galaxy-collection": "list_private_galaxy_collection",
  "GET /me/galaxy-progress": "get_private_galaxy_progress",
  // The cross-device preferences store — contract-only oRPC (no TanStack route file
  // under /api/v1/me), documented here as part of the public surface net.
  "GET /me/preferences": "get_private_preferences",
  "GET /me/rec-seeds": "list_private_rec_seeds",
  "GET /me/recommendations": "list_private_recommendations",
  "GET /me/saved-findings": "list_private_saved_findings",
  "GET /me/saved-sets": "list_private_saved_sets",
  "GET /me/submissions": "list_private_submissions",
  "GET /me/watches": "list_private_watches",
  // The `/mix` taste-seeding pair (+ the set-link resolver) — contract-only oRPC (no
  // TanStack route file under /api/v1/mix). Public-unauth: `/mix` is a stranger's first
  // contact with Fluncle, so no account stands between them and a set.
  "GET /mix/artists": "list_mixable_artists",
  "GET /mix/openers": "list_mix_openers",
  // The set link's own read — resolves the chain of coordinates in the URL back to tracks.
  // An unknown token thins the chain rather than faulting the read.
  "GET /mix/set-tracks": "list_set_tracks",
  "GET /mixtapes": "list_mixtapes",
  // The newsletter archive reads.
  // Contract-only oRPC — there is no TanStack route file under /api/v1/newsletter
  // (oRPC serves them off the registry), so they have no route-file basename to
  // enumerate; documented here as part of the public surface net.
  "GET /newsletter/editions": "list_editions",
  "GET /newsletter/editions/{number}": "get_edition",
  // The cycling station's reads. Contract-only — there is no TanStack alias file
  // under /api/v1/radio (oRPC serves them straight off the registry), so they have
  // no route-file basename to enumerate; documented here as part of the public
  // surface net. `now-playing` is the shared-broadcast clock (the radio-broadcast
  // RFC, Unit A); `random` is the kept fallback (RFC Unit B).
  "GET /radio/now-playing": "get_radio_now_playing",
  "GET /radio/random": "get_random_radio_track",
  // The /reach page's numbers — contract-only oRPC (no TanStack route file under
  // /api/v1/reach). Public tier: one bounded, grouped page read of the append-only
  // `platform_stats` ledger; the write half is `record_platform_stats` on the admin net.
  "GET /reach/stats": "list_platform_stats",
  "GET /search": "search_tracks",
  // Fluncle's OWN search — the archive, not Spotify (lib/server/search.ts). Contract-only
  // oRPC (no TanStack route file under /api/v1/search), so it has no route-file basename to
  // enumerate; documented here as part of the public surface net.
  "GET /search/archive": "search_archive",
  "GET /stories": "list_stories",
  "GET /tracks": "list_tracks",
  "GET /tracks/fresh": "list_fresh",
  "GET /tracks/random": "get_random_track",
  "GET /tracks/{idOrLogId}": "get_track",
  // The `/mix` set-builder rail (RFC mixability-engine). Contract-only oRPC — no
  // TanStack route file under /api/v1/tracks (oRPC serves it straight off the
  // registry), so it has no route-file basename to enumerate; documented here as part
  // of the public surface net. Public-unauth at the op; the `/mix` PAGE is admin-gated
  // at launch (Decision 1), a pure route-level flip to lift.
  "GET /tracks/{idOrLogId}/mixable": "list_mixable_tracks",
  // The "more like this" sonic-neighbour read (docs/track-lifecycle.md). Contract-only
  // oRPC — no TanStack route file under /api/v1/tracks (oRPC serves it straight off the
  // registry), so it has no route-file basename to enumerate; documented here as part of
  // the public surface net.
  "GET /tracks/{idOrLogId}/similar": "list_similar_tracks",
  "PATCH /me/preferences": "update_private_preferences",
  "PATCH /me/profile": "update_private_profile",
  "PATCH /me/saved-sets/{id}": "update_private_saved_set",
  "POST /devices": "register_device",
  "POST /me/delete": "delete_private_account",
  "POST /me/export": "export_private_account_data",
  "POST /me/frontier-playlist": "mint_private_frontier_playlist",
  // The only `/me/galaxy-progress/logs` op is this POST collect-one (the game's
  // per-find write → `collectLogId`); there is no list-logs op, so it is named for
  // what it does (see ../orpc/me-galaxy.ts — oRPC owns the path directly now).
  "POST /me/galaxy-progress/logs": "collect_private_galaxy_log",
  "POST /me/rec-seeds": "save_private_rec_seed",
  "POST /me/saved-findings": "save_private_finding",
  "POST /me/saved-sets": "save_private_set",
  "POST /me/watches": "save_private_watch",
  "POST /newsletter": "subscribe_newsletter",
  "POST /submissions": "submit_track",
  "PUT /me/galaxy-progress": "merge_private_galaxy_progress",
};

// Routes that stay on TanStack by design (carve-outs): OAuth browser-redirect
// callbacks, and binary/image render
// endpoints that emit non-JSON bytes. These are NOT counted against coverage —
// they will never have a contract — but they ARE listed so the enumeration is
// total and a new carve-out is a deliberate edit here, not an omission.
const CARVE_OUT_ROUTE_PREFIXES = [
  "auth/", // Spotify/YouTube/Mixcloud/Last.fm OAuth callbacks → browser redirects.
];

// Binary/render routes: emit images/audio, not RPC JSON. Carved out like OAuth.
const CARVE_OUT_ROUTES = new Set([
  // ChatDnB's crew door (POST /api/chat) — a STREAMING carve-out (AGENTS.md): the
  // response is an open AI SDK UIMessage stream, not a single RPC JSON body, exactly
  // like the admin sibling /api/admin/chat. Never an oRPC op; the safety rails
  // (session, emailVerified, origin/CSRF, the two rate dials) live in the route.
  "chat",
  // The account portrait upload — a large-body/direct-upload carve-out (AGENTS.md):
  // it RECEIVES image bytes (a downscaled ≤512² avatar), not an RPC JSON body, and
  // PUTs them to R2. Never an oRPC op; the safety rails (session, CSRF, rate-limit,
  // type/size/dimension validation) live in the route + lib/server/avatar.ts.
  "me/avatar",
  "mixtape-cover.$logId",
  "og.$logId",
  "preview.$idOrLogId",
  // The generated-spec + tooling surfaces are documents, not API operations.
  "openapi[.]json",
  "postman[.]json",
  // The set-level Open Graph card for a shared `/mix` link — a binary/render carve-out
  // exactly like `og.$logId`: it emits a 1200×630 PNG through workers-og, never RPC JSON.
  // Listed on its own because it is the one BARE-ONLY public route (mounted at
  // /api/og/set with no /api/v1 twin), so only the bare walk below reaches it.
  "og.set",
  // The machine-readable status read — the JSON sibling of the /status HTML
  // dashboard (../../routes/api/v1/status.ts). A public resource read like /api/health,
  // deliberately NOT an oRPC operation: it just echoes the already-public
  // `service_status` snapshot for a poller (the rave-01 watchdog reads its
  // `secondsSinceFreshestReport`), so it carries no contract and stays carved out.
  "status",
]);

// The public routes still awaiting conversion. Phase 1 left everything but
// `get_track` here; the fan-out phase removed entries as it converted them. With
// Wave B this list is EMPTY — the public surface is fully contract-first (the
// admin tier is its own later wave, carved out above, not counted here).
const PENDING_PUBLIC_OPS = new Set<string>([]);

const API_DIR = fileURLToPath(new URL("../../routes/api", import.meta.url));
const V1_DIR = `${API_DIR}/v1`;

// The two roots the public net walks. `/api/v1` is the canonical mount, but a route
// may be mounted at the BARE `/api/*` path with NO /api/v1 twin (`og.set.ts`, at
// /api/og/set, is the live instance) — and a bare-only route was checked by NEITHER
// net: this file only ever walked v1, and orpc-admin-coverage.test.ts only ever walks
// /api/admin. So the bare top level is walked too, and a new bare-only public route
// now has to be documented or carved out like any other.
const PUBLIC_ROUTE_DIRS = [V1_DIR, API_DIR];

// Directories the public walk does NOT descend: `admin` has its own coverage net
// (orpc-admin-coverage.test.ts), and `v1` is walked as a root in its own right — so
// the bare walk must not re-enumerate it under a `v1/`-prefixed basename.
const SKIPPED_DIRS = new Set(["admin", "v1"]);

// The file-route basenames actually present under a root (one level + nested),
// excluding the skipped dirs above, the `-`-prefixed non-route helpers, and the
// colocated `*.test.ts` suites (a test beside a route is not a route). Used to keep
// PUBLIC_ROUTE_OPS honest: if a public route file exists with no entry, the
// enumeration is stale and the test flags it.
function listRouteBasenames(dir: string, prefix = ""): string[] {
  const out: string[] = [];

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      if (SKIPPED_DIRS.has(entry.name)) {
        continue;
      }

      out.push(...listRouteBasenames(`${dir}/${entry.name}`, rel));
      continue;
    }

    if (
      !entry.name.endsWith(".ts") ||
      entry.name.startsWith("-") ||
      entry.name.includes(".test.")
    ) {
      continue;
    }

    out.push(rel.replace(/\.ts$/, ""));
  }

  return out;
}

function isCarvedOut(basename: string): boolean {
  return (
    CARVE_OUT_ROUTES.has(basename) || CARVE_OUT_ROUTE_PREFIXES.some((p) => basename.startsWith(p))
  );
}

// The line between the two coverage nets — the same predicate the admin sibling draws it
// with. Matched on the segment boundary, not as a bare prefix, so a future `/administration`
// path stays on this net instead of falling through to neither.
function isAdminPath(path: string): boolean {
  return path === "/admin" || path.startsWith("/admin/");
}

describe("oRPC public-route contract coverage", () => {
  const converted = new Set<string>(CONTRACT_OPERATION_NAMES);

  it("converts the entire public surface (proof + pilot + Wave A + Wave B /me)", () => {
    // With Wave B the registry serves every public op — the unauth surface plus the
    // thirteen `/me` private-session ops. Every public op must be converted (a
    // SUBSET check, not equality: the registry also holds admin ops now — the admin
    // wave's pilot — which the sibling orpc-admin-coverage.test.ts is the net for).
    const publicOps = new Set(Object.values(PUBLIC_ROUTE_OPS));

    for (const op of publicOps) {
      expect(converted.has(op), `public op "${op}" is missing from the contract registry`).toBe(
        true,
      );
    }
  });

  it("holds EXACTLY the public ops (no non-admin op outside the map)", () => {
    // The other half of the partition. The sibling admin net claims every op served off an
    // `/admin` PATH; everything else is this file's, and must be named here. Together the two
    // nets cover the registry with no gap — before this, an op could be exempted from the admin
    // net by its NAME and never appear on the public one, so it was in neither.
    const publicOps = new Set(Object.values(PUBLIC_ROUTE_OPS));

    for (const op of CONTRACT_OPERATION_NAMES) {
      const route = CONTRACT_OPERATION_ROUTES[op];

      if (!route) {
        expect.fail(`contract op "${op}" declares no route — it is outside both coverage nets`);
      }

      if (isAdminPath(route.path) || publicOps.has(op)) {
        continue;
      }

      expect.fail(
        `contract op "${op}" (${route.method} ${route.path}) is in the registry but absent from PUBLIC_ROUTE_OPS — document it here (or move it to an /admin path)`,
      );
    }
  });

  it("accounts for every public op: converted XOR pending", () => {
    for (const op of Object.values(PUBLIC_ROUTE_OPS)) {
      const isConverted = converted.has(op);
      const isPending = PENDING_PUBLIC_OPS.has(op);

      // Exactly one must hold. Neither ⇒ a route slipped in with no contract and
      // no deliberate deferral. Both ⇒ the pending list didn't shrink on convert.
      expect(
        isConverted !== isPending,
        `${op}: must be either converted (in the contract registry) or pending, not ${
          isConverted && isPending ? "both" : "neither"
        }`,
      ).toBe(true);
    }
  });

  it("has no stale pending entries (every pending op maps to a real route)", () => {
    const knownOps = new Set(Object.values(PUBLIC_ROUTE_OPS));

    for (const op of PENDING_PUBLIC_OPS) {
      expect(knownOps.has(op), `pending op "${op}" is not a known public route`).toBe(true);
    }
  });

  it("enumerates every public route file (no undocumented routes)", () => {
    // Reduce both a documented URL path and a TanStack file basename to the same
    // canonical key — the path segments with all separators and param markers
    // stripped — so `tracks.$idOrLogId` (file) and `/tracks/{idOrLogId}` (path)
    // and `me/csrf` (nested dir) all compare equal regardless of spelling.
    const canonical = (value: string): string =>
      value.replace(/[./]/g, " ").replace(/[${}]/g, "").trim().split(/\s+/).join("/");

    const documented = new Set(
      Object.keys(PUBLIC_ROUTE_OPS).map((path) => canonical(path.split(" ")[1] ?? path)),
    );

    // Both roots: the canonical /api/v1 tree AND the bare /api top level, so a
    // BARE-ONLY route (no /api/v1 twin) is inside the net instead of in the gap
    // between this file and orpc-admin-coverage.test.ts.
    for (const basename of PUBLIC_ROUTE_DIRS.flatMap((dir) => listRouteBasenames(dir))) {
      if (isCarvedOut(basename)) {
        continue;
      }

      expect(
        documented.has(canonical(basename)),
        `route file "${basename}" has no entry in PUBLIC_ROUTE_OPS — document it (with its canonical verb_noun) or add it as a carve-out`,
      ).toBe(true);
    }
  });

  // The net is only worth having if it would actually catch the thing it was blind to.
  // Prove the bare walk reaches a bare-only route (og.set today), so a future public
  // route mounted at /api/<x> with no /api/v1/<x> twin cannot slip in unexamined.
  it("walks the BARE /api top level, not just /api/v1", () => {
    const bare = listRouteBasenames(API_DIR);

    expect(bare).toContain("og.set");
    // …and does not double-count the canonical tree under a `v1/` prefix.
    expect(bare.some((basename) => basename.startsWith("v1/"))).toBe(false);
    // …nor the admin tree, which has its own coverage net.
    expect(bare.some((basename) => basename.startsWith("admin/"))).toBe(false);
  });
});
