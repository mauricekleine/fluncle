import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CONTRACT_OPERATION_NAMES } from "@fluncle/contracts/orpc";

// The ADMIN coverage scaffold for the oRPC migration (docs/orpc-migration-brief.md,
// the admin section + "Definition of done"). The sibling orpc-coverage.test.ts
// draws the same net over the PUBLIC surface; this one extends it to ADMIN, which
// the public net deliberately skips (it `continue`s past the `admin/` directory).
//
// Every admin HTTP route is either:
//   - CONVERTED — owned by an oRPC contract (named in the registry), or
//   - PENDING   — on the explicit, shrinking allow-list below, awaiting the
//                 fan-out waves after this pilot, or
//   - a CARVE-OUT — staying on TanStack by design (OAuth browser redirects; the
//                 multipart-file routes — see the carve-out note below).
//
// A route that is none of these fails the build — the SAME enforcement the public
// net gives, now reaching admin so there is no admin-shaped gap in the "no
// contract ⇒ build failure" coverage. A route may not be both converted AND
// pending (the pending list must shrink as routes convert), and a pending entry
// must map to a real route (no stale names).
//
// The admin PILOT converted the pattern-complete `admin-tracks` set (the
// field-level role guard + the operator-tier observe + the JSON video
// control-plane). The admin WAVE then fanned out the rest onto that exact pattern:
// the backfills (`admin-backfills`), the submission-review queue
// (`admin-submissions`), the mixtape authoring + distribution control plane
// (`admin-mixtapes`), the per-finding social ops (`admin-social`), the
// just-in-time credential reads + Last.fm desktop-auth JSON exchange
// (`admin-tokens`), and the admin board list/add folded back into `admin-tracks`.
// After the wave the PENDING list is EMPTY — every admin route is converted except
// the carve-outs (the OAuth redirects, the admin `logout` redirect, and the two
// multipart-file routes), which stay on TanStack by design.

// Each admin API route, keyed by its `/api/v1`-relative `METHOD /path`, mapped to
// the canonical Convention-B `verb_noun` op it should be served by — or the
// PENDING sentinel for a route not yet converted. This is the admin-surface
// registry the coverage net is drawn over.
const PENDING = "__pending__" as const;

// Keyed `METHOD /path`, sorted (the linter's sort-keys). After the admin wave
// every route maps to its canonical converted op; the PENDING sentinel is retained
// for future admin routes (a new route lands here as PENDING until it converts).
const ADMIN_ROUTE_OPS: Record<string, string> = {
  "DELETE /admin/mixtapes/{mixtapeId}": "delete_mixtape",
  // The newsletter edition delete — contract-only oRPC (no TanStack route file).
  // Operator tier: a hard delete that reaches a SENT edition too (pulling a sent
  // test edition from the public archive); the agent token 403s.
  "DELETE /admin/newsletter/editions/{id}": "delete_edition",
  "GET /admin/lastfm/auth/start": "start_lastfm_auth",
  "GET /admin/mixtapes": "list_mixtapes_admin",
  "GET /admin/mixtapes/{mixtapeId}/social": "get_mixtape_social",
  // The newsletter edition list (drafts inclusive) — contract-only oRPC, no TanStack
  // route file (oRPC serves it off the registry). Admin tier (agent-allowed): the
  // Friday cron reads it from a fresh session to find an unsent draft + the window.
  "GET /admin/newsletter/editions": "list_editions_admin",
  "GET /admin/submissions": "list_submissions",
  "GET /admin/submissions/{submissionId}": "get_submission",
  "GET /admin/tracks": "list_tracks_admin",
  "GET /admin/tracks/{trackId}/social": "list_track_social",
  "PATCH /admin/mixtapes/{mixtapeId}": "update_mixtape",
  // The newsletter edition control plane. Contract-only oRPC — no TanStack route
  // files under /api/admin/newsletter
  // (oRPC serves them off the registry), so they have no file-enumeration entry;
  // they live here to satisfy the "registry holds EXACTLY this map's ops" check.
  // create/update are admin tier (agent-allowed drafting); send is operator-only.
  "PATCH /admin/newsletter/editions/{id}": "update_edition",
  "PATCH /admin/tracks/{trackId}": "update_track",
  "PATCH /admin/tracks/{trackId}/social/{platform}": "update_track_social",
  "POST /admin/backfill/discogs": "backfill_discogs",
  "POST /admin/backfill/lastfm": "backfill_lastfm",
  "POST /admin/lastfm/auth/session": "exchange_lastfm_session",
  "POST /admin/mixcloud/token": "mint_mixcloud_token",
  "POST /admin/mixtapes": "create_mixtape",
  "POST /admin/mixtapes/{mixtapeId}/members": "add_mixtape_members",
  "POST /admin/mixtapes/{mixtapeId}/mixcloud/finalize": "finalize_mixtape_mixcloud",
  "POST /admin/mixtapes/{mixtapeId}/publish": "publish_mixtape",
  "POST /admin/mixtapes/{mixtapeId}/youtube/finalize": "finalize_mixtape_youtube",
  "POST /admin/mixtapes/{mixtapeId}/youtube/initiate": "initiate_mixtape_youtube",
  "POST /admin/mixtapes/{mixtapeId}/youtube/publish": "publish_mixtape_youtube",
  "POST /admin/newsletter/editions": "create_edition",
  "POST /admin/newsletter/editions/{id}/send": "send_edition",
  // The push receipts sweep is a contract-only admin op (no TanStack route file —
  // the whole devices domain is contract-first oRPC), so it has no file-enumeration
  // entry; it lives here only to satisfy the "registry holds EXACTLY this map's
  // ops" check. An EXTERNAL cron calls it (TanStack has no `scheduled()`).
  "POST /admin/push/receipts/sweep": "sweep_push_receipts",
  "POST /admin/submissions/{submissionId}/approve": "approve_submission",
  "POST /admin/submissions/{submissionId}/reject": "reject_submission",
  "POST /admin/tracks": "publish_track",
  // context_track is served by oRPC at its own path; it has no TanStack route FILE
  // (oRPC owns the path directly), so it lives here as a path→op entry without a
  // `tracks.$trackId.context.ts` route file.
  "POST /admin/tracks/{trackId}/context": "context_track",
  // note_track (the auto-note authoring step) is contract-only oRPC like context_track
  // — no TanStack route file; oRPC owns the path directly.
  "POST /admin/tracks/{trackId}/note": "note_track",
  "POST /admin/tracks/{trackId}/observe": "observe_track",
  "POST /admin/tracks/{trackId}/social/{platform}/draft": "draft_track_social",
  "POST /admin/tracks/{trackId}/video/finalize": "finalize_track_video",
  // purge_video — contract-only oRPC (no TanStack route file; oRPC owns the path
  // directly, like requeue_video). Operator tier: it acts on a LIVE published video
  // (purges its edge renditions), so the agent token 403s.
  "POST /admin/tracks/{trackId}/video/purge": "purge_video",
  // requeue_video — contract-only oRPC (no TanStack route file; oRPC owns the path
  // directly, like context_track/note_track). Operator tier: it clears a LIVE
  // published video (video_url + video_squared_at), so the agent token 403s.
  "POST /admin/tracks/{trackId}/video/requeue": "requeue_video",
  "POST /admin/tracks/{trackId}/video/uploads": "presign_track_video_uploads",
  "POST /admin/youtube/token": "mint_youtube_token",
  // The PUT shares the `members` file/path with the POST above (append vs replace);
  // oRPC routes the two methods to distinct ops, so each gets its own entry.
  "PUT /admin/mixtapes/{mixtapeId}/members": "set_mixtape_members",
};

// Routes that stay on TanStack by design (docs/orpc-migration-brief.md
// "Carve-outs"), keyed by their TanStack file basename (relative to the admin
// route dir). NOT counted against coverage — they will never have a contract —
// but listed so the enumeration is total and a new carve-out is a deliberate edit.
//
//   - OAuth browser-redirect callbacks/starts (Spotify / YouTube / Mixcloud
//     `*/auth/*`): they return 302 redirects, not RPC JSON. Permanent. (Last.fm's
//     `auth/start` + `auth/session` are NOT redirects — they return RPC JSON — so
//     they are CONVERTED, not carved out, in the admin wave.)
//   - The admin `logout` (GET): a 302 that expires the grant cookie and bounces to
//     /admin/login. Not RPC JSON, so it stays on TanStack like the OAuth redirects.
//   - The multipart-FILE route (`preview`): it takes `request.formData()` with a
//     `File` part. Per the brief, oRPC's multipart-file-body ergonomics on workerd
//     are not adopted for this pilot — this single irregular route stays on
//     TanStack, not the model for the wave. CARVED OUT (the decision the brief asks
//     for at kickoff). (The legacy multipart `…/video.ts` POST that was carved out
//     alongside it has since been REMOVED — no first-party caller posted a small
//     multipart bundle; the CLI uses the presign/finalize JSON flow.)
const ADMIN_CARVE_OUT_ROUTE_PREFIXES = ["spotify/auth/", "youtube/auth/", "mixcloud/auth/"];

const ADMIN_CARVE_OUT_ROUTES = new Set([
  "logout", // a 302 redirect (expire the grant cookie, bounce to /admin/login), not RPC JSON.
  "tracks.$trackId.preview", // multipart-file body (formData → File).
]);

const ADMIN_DIR = fileURLToPath(new URL("../../routes/api/admin", import.meta.url));

// The admin file-route basenames actually present (one level + nested),
// excluding the `-`-prefixed non-route helpers and `.test.ts` files. Keeps
// ADMIN_ROUTE_OPS honest: an admin route file with no entry fails the test.
function listRouteBasenames(dir: string, prefix = ""): string[] {
  const out: string[] = [];

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      out.push(...listRouteBasenames(`${dir}/${entry.name}`, rel));
      continue;
    }

    if (
      !entry.name.endsWith(".ts") ||
      entry.name.startsWith("-") ||
      entry.name.endsWith(".test.ts")
    ) {
      continue;
    }

    out.push(rel.replace(/\.ts$/, ""));
  }

  return out;
}

function isCarvedOut(basename: string): boolean {
  return (
    ADMIN_CARVE_OUT_ROUTES.has(basename) ||
    ADMIN_CARVE_OUT_ROUTE_PREFIXES.some((p) => basename.startsWith(p))
  );
}

// Reduce a documented URL path and a TanStack file basename to the same canonical
// key — the path segments with all separators and param markers stripped — so
// `tracks.$trackId.observe` (file) and `/admin/tracks/{trackId}/observe` (path)
// compare equal. The `admin/` segment is on the file tree but not the path key, so
// prepend it to the path side.
function canonical(value: string): string {
  return value.replace(/[./]/g, " ").replace(/[${}]/g, "").trim().split(/\s+/).join("/");
}

describe("oRPC admin-route contract coverage", () => {
  const converted = new Set<string>(CONTRACT_OPERATION_NAMES);

  it("converts the pilot's `admin-tracks` set (update/observe/video presign+finalize)", () => {
    const expected = [
      "finalize_track_video",
      "note_track",
      "observe_track",
      "presign_track_video_uploads",
      "update_track",
    ];

    for (const op of expected) {
      expect(converted.has(op), `${op} must be in the contract registry`).toBe(true);
    }
  });

  it("accounts for every admin op: converted XOR pending", () => {
    for (const op of Object.values(ADMIN_ROUTE_OPS)) {
      if (op === PENDING) {
        continue;
      }

      const isConverted = converted.has(op);
      const isPending = false; // a non-PENDING value is a claim of conversion.

      expect(
        isConverted !== isPending,
        `${op}: a named admin op must be in the contract registry (converted)`,
      ).toBe(true);
    }
  });

  it("the admin registry holds EXACTLY this pilot's ops (no admin op outside the map)", () => {
    // Every admin op in the contract registry must be a NAMED (non-PENDING) entry
    // here. Catches an op converted in another file whose route the map didn't
    // record — the pending list must shrink, by name, as routes convert. The
    // public ops are excluded by matching only against the admin map's values.
    const namedAdminOps = new Set(Object.values(ADMIN_ROUTE_OPS).filter((op) => op !== PENDING));
    // The ops the public coverage net owns; admin coverage ignores them here.
    const PUBLIC_OP_PREFIXES = [
      "get_",
      "list_",
      "search_",
      "submit_",
      "subscribe_",
      "save_",
      "unsave_",
      "collect_",
      "merge_",
      "delete_private",
      "export_private",
      "update_private",
      "register_device",
      "deregister_device",
    ];
    const isPublicOp = (op: string) => PUBLIC_OP_PREFIXES.some((p) => op.startsWith(p));

    for (const op of converted) {
      if (isPublicOp(op) || namedAdminOps.has(op)) {
        continue;
      }

      // An op that is neither a known public op nor a documented admin op slipped
      // into the registry without a coverage entry.
      expect.fail(
        `contract op "${op}" is in the registry but absent from ADMIN_ROUTE_OPS — add its admin route entry (or document it on the public net)`,
      );
    }
  });

  it("enumerates every admin route file (no undocumented admin routes)", () => {
    // The path key already starts with `/admin/...`; the file basename is relative
    // to the admin dir, so prefix it with `admin/` to compare on the same footing.
    const documented = new Set(
      Object.keys(ADMIN_ROUTE_OPS).map((key) => canonical(key.split(" ")[1] ?? key)),
    );

    for (const basename of listRouteBasenames(ADMIN_DIR)) {
      if (isCarvedOut(basename)) {
        continue;
      }

      expect(
        documented.has(canonical(`admin/${basename}`)),
        `admin route file "${basename}" has no entry in ADMIN_ROUTE_OPS — document it (with its canonical verb_noun, or PENDING) or add it as a carve-out`,
      ).toBe(true);
    }
  });

  it("every carved-out admin file exists (no stale carve-out)", () => {
    const present = new Set(listRouteBasenames(ADMIN_DIR));

    for (const carved of ADMIN_CARVE_OUT_ROUTES) {
      expect(present.has(carved), `carve-out "${carved}" no longer maps to a real route`).toBe(
        true,
      );
    }
  });
});
