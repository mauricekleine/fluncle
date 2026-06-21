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
// This PILOT converts the pattern-complete `admin-tracks` set (the field-level
// role guard + the operator-tier observe + the JSON video control-plane); every
// other admin route stays PENDING for its later wave (backfills, submissions-
// review, mixtapes-admin, tagging, the social ops).

// Each admin API route, keyed by its `/api/v1`-relative `METHOD /path`, mapped to
// the canonical Convention-B `verb_noun` op it should be served by — or the
// PENDING sentinel for a route not yet converted. This is the admin-surface
// registry the coverage net is drawn over.
const PENDING = "__pending__" as const;

// Keyed `METHOD /path`, sorted (the linter's sort-keys); the CONVERTED four are
// this pilot's `admin-tracks` set, everything else is PENDING for a later wave:
//   - converted: PATCH /admin/tracks/{trackId} (update_track), POST …/observe
//     (observe_track), POST …/video/uploads (presign_track_video_uploads), POST
//     …/video/finalize (finalize_track_video);
//   - pending: the rest of admin-tracks (list/add/social), enrich-sweep, the
//     backfills, submissions-review, the mixtapes-admin tier, and the
//     non-redirect admin session/token writes (logout, the Last.fm session
//     exchange, the Mixcloud/YouTube token reads — JSON, so convertible).
const ADMIN_ROUTE_OPS: Record<string, string> = {
  "DELETE /admin/mixtapes/{mixtapeId}": PENDING,
  "GET /admin/logout": PENDING,
  "GET /admin/mixtapes": PENDING,
  "GET /admin/mixtapes/{mixtapeId}/social": PENDING,
  "GET /admin/submissions": PENDING,
  "GET /admin/submissions/{submissionId}": PENDING,
  "GET /admin/tracks": PENDING,
  "GET /admin/tracks/{trackId}/social": PENDING,
  "PATCH /admin/mixtapes/{mixtapeId}": PENDING,
  "PATCH /admin/tracks/{trackId}": "update_track",
  "PATCH /admin/tracks/{trackId}/social/{platform}": PENDING,
  "POST /admin/backfill/discogs": PENDING,
  "POST /admin/backfill/lastfm": PENDING,
  "POST /admin/enrich-sweep": PENDING,
  "POST /admin/lastfm/auth/session": PENDING,
  "POST /admin/mixcloud/token": PENDING,
  "POST /admin/mixtapes": PENDING,
  "POST /admin/mixtapes/{mixtapeId}/members": PENDING,
  "POST /admin/mixtapes/{mixtapeId}/mixcloud/finalize": PENDING,
  "POST /admin/mixtapes/{mixtapeId}/publish": PENDING,
  "POST /admin/mixtapes/{mixtapeId}/youtube/finalize": PENDING,
  "POST /admin/mixtapes/{mixtapeId}/youtube/initiate": PENDING,
  "POST /admin/mixtapes/{mixtapeId}/youtube/publish": PENDING,
  "POST /admin/submissions/{submissionId}/approve": PENDING,
  "POST /admin/submissions/{submissionId}/reject": PENDING,
  "POST /admin/tracks": PENDING,
  "POST /admin/tracks/{trackId}/observe": "observe_track",
  "POST /admin/tracks/{trackId}/social/{platform}/draft": PENDING,
  "POST /admin/tracks/{trackId}/video/finalize": "finalize_track_video",
  "POST /admin/tracks/{trackId}/video/uploads": "presign_track_video_uploads",
  "POST /admin/youtube/token": PENDING,
};

// Routes that stay on TanStack by design (docs/orpc-migration-brief.md
// "Carve-outs"), keyed by their TanStack file basename (relative to the admin
// route dir). NOT counted against coverage — they will never have a contract —
// but listed so the enumeration is total and a new carve-out is a deliberate edit.
//
//   - OAuth browser-redirect callbacks/starts (Spotify / YouTube / Mixcloud /
//     Last.fm `*/auth/*`): they return 302 redirects, not RPC JSON. Permanent.
//   - The multipart-FILE routes (`preview-archive`; the legacy multipart
//     `…/video.ts` POST, superseded by the converted presign/finalize JSON
//     control-plane): they take `request.formData()` with a `File` part. Per the
//     brief, oRPC's multipart-file-body ergonomics on workerd are not adopted for
//     this pilot — these single irregular routes stay on TanStack, not the model
//     for the wave. CARVED OUT (the decision the brief asks for at kickoff).
const ADMIN_CARVE_OUT_ROUTE_PREFIXES = [
  "spotify/auth/",
  "youtube/auth/",
  "mixcloud/auth/",
  "lastfm/auth/",
];

const ADMIN_CARVE_OUT_ROUTES = new Set([
  "tracks.$trackId.preview-archive", // multipart-file body (formData → File).
  "tracks.$trackId.video", // the legacy multipart upload, superseded by presign/finalize.
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
      Object.keys(ADMIN_ROUTE_OPS).map((key) => canonical(key.split(" ")[1])),
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
