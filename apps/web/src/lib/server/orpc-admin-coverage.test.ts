import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CONTRACT_OPERATION_NAMES, CONTRACT_OPERATION_ROUTES } from "@fluncle/contracts/orpc";

const PENDING = "__pending__" as const;

const ADMIN_ROUTE_OPS: Record<string, string> = {
  "DELETE /admin/artist-rules/{id}": "remove_artist_rule",

  "DELETE /admin/artists/socials/{socialId}": "remove_artist_social",

  "DELETE /admin/clips/{clipId}": "delete_clip",

  "DELETE /admin/clips/{clipId}/schedule": "delete_clip_schedule",

  "DELETE /admin/labels/aliases/{id}": "reject_label_alias",

  "DELETE /admin/newsletter/editions/{id}": "delete_edition",

  "DELETE /admin/recordings/{recordingId}": "delete_recording",

  "DELETE /admin/subscriptions/{id}": "delete_subscription",

  "DELETE /admin/tracks/{trackId}/capture-source": "clear_capture_source",

  "GET /admin/albums/bio-queue": "list_albums_missing_bio",

  "GET /admin/albums/{slug}/bio-draft": "draft_album_bio",

  "GET /admin/artifacts/changes": "list_artifact_changes",
  "GET /admin/artifacts/consumers/{consumerId}": "get_artifact_consumer",
  "GET /admin/artifacts/snapshots": "list_artifact_snapshot",

  "GET /admin/artist-rules": "list_artist_rules",

  "GET /admin/artists": "list_unresolved_artists",
  "GET /admin/artists/bio-queue": "list_artists_missing_bio",

  "GET /admin/artists/socials": "list_artist_socials",

  "GET /admin/artists/{slug}/bio-draft": "draft_artist_bio",

  "GET /admin/attention": "get_attention",

  "GET /admin/catalogue": "list_catalogue_tracks",

  "GET /admin/catalogue/anchor/apify-budget": "get_anchor_apify_budget",
  "GET /admin/catalogue/anchor/breaker": "get_spotify_anchor_breaker",

  "GET /admin/catalogue/capture-budget": "get_capture_budget",

  "GET /admin/catalogue/captures/unverified": "list_unverified_captures",
  "GET /admin/catalogue/crawl": "get_crawl_status",
  "GET /admin/catalogue/pipeline": "get_pipeline",
  "GET /admin/clips": "list_clips",

  "GET /admin/clips/social": "list_clip_posts",

  "GET /admin/clips/{clipId}/caption": "get_clip_caption",

  "GET /admin/frontier/minting": "get_frontier_minting",

  "GET /admin/funnel": "get_funnel",

  "GET /admin/galaxies": "list_galaxies_admin",

  "GET /admin/labels": "list_labels_admin",

  "GET /admin/labels/aliases": "list_label_aliases",
  "GET /admin/labels/bio-queue": "list_labels_missing_bio",

  "GET /admin/labels/{id}/artists": "list_label_artist_rules",

  "GET /admin/labels/{slug}/bio-draft": "draft_label_bio",
  "GET /admin/lastfm/auth/start": "start_lastfm_auth",

  "GET /admin/logbook/gaps": "list_logbook_gaps",
  "GET /admin/mixtapes": "list_mixtapes_admin",
  "GET /admin/mixtapes/{mixtapeId}/social": "get_mixtape_social",

  "GET /admin/newsletter/editions": "list_editions_admin",

  "GET /admin/note-rejections": "list_note_rejections",

  "GET /admin/observation-rejections": "list_observation_rejections",

  "GET /admin/projections/status": "get_projection_status",

  "GET /admin/prompts": "list_prompts",
  "GET /admin/prompts/{slug}": "get_prompt",
  "GET /admin/recordings": "list_recordings",
  "GET /admin/recordings/{recordingId}": "get_recording",

  "GET /admin/social/metrics": "get_social_metrics",
  "GET /admin/submissions": "list_submissions",
  "GET /admin/submissions/{submissionId}": "get_submission",

  "GET /admin/subscriptions": "list_subscriptions",

  "GET /admin/telemetry/runs": "read_run_ledger",
  "GET /admin/tracks": "list_tracks_admin",

  "GET /admin/tracks/embeddings": "list_track_embeddings",

  "GET /admin/tracks/mixable-order": "get_mixable_order",

  "GET /admin/tracks/work": "list_track_work",

  "GET /admin/tracks/{trackId}": "get_track_admin",

  "GET /admin/tracks/{trackId}/observation-neighbours": "list_observation_neighbours",
  "GET /admin/tracks/{trackId}/social": "list_track_social",

  "GET /admin/users": "list_users_admin",

  "GET /admin/vectors/tracks/serving": "get_vector_serving",

  "PATCH /admin/artist-rules/{id}": "update_artist_rule",

  "PATCH /admin/artists/socials/{socialId}": "update_artist_social",
  "PATCH /admin/clips/{clipId}": "update_clip",

  "PATCH /admin/clips/{clipId}/schedule": "set_clip_schedule",

  "PATCH /admin/galaxies/{id}": "update_galaxy",

  "PATCH /admin/labels/{id}": "update_label",

  "PATCH /admin/logbook/{sector}": "update_logbook_entry",
  "PATCH /admin/mixtapes/{mixtapeId}": "update_mixtape",

  "PATCH /admin/newsletter/editions/{id}": "update_edition",

  "PATCH /admin/note-gate": "update_note_gate",

  "PATCH /admin/observation-gate": "update_observation_gate",
  "PATCH /admin/recordings/{recordingId}": "update_recording",

  "PATCH /admin/subscriptions/{id}": "update_subscription",
  "PATCH /admin/tracks/{trackId}": "update_track",
  "PATCH /admin/tracks/{trackId}/social/{platform}": "update_track_social",

  "POST /admin/albums/{slug}/bio": "describe_album",
  "POST /admin/artifacts/changes/compact": "compact_artifact_changes",
  "POST /admin/artifacts/consumers": "register_artifact_consumer",
  "POST /admin/artifacts/consumers/{consumerId}/activate": "activate_artifact_consumer",
  "POST /admin/artifacts/consumers/{consumerId}/checkpoint": "acknowledge_artifact_changes",
  "POST /admin/artifacts/consumers/{consumerId}/inactivate": "inactivate_artifact_consumer",
  "POST /admin/artifacts/consumers/{consumerId}/rebuilds/{stream}/checkpoint":
    "checkpoint_artifact_rebuild",

  "POST /admin/artist-rules": "add_artist_rule",

  "POST /admin/artists/rank": "rank_artists",

  "POST /admin/artists/socials/{socialId}/confirm": "confirm_artist_social",

  "POST /admin/artists/socials/{socialId}/review": "review_artist_social",

  "POST /admin/artists/{artistId}/resolve": "resolve_artist",
  "POST /admin/artists/{artistId}/review": "review_artist",
  "POST /admin/artists/{artistId}/socials": "add_artist_social",

  "POST /admin/artists/{slug}/bio": "describe_artist",

  "POST /admin/auth/revoke-grants": "revoke_admin_grants",

  "POST /admin/backfill/apple-catalogue": "backfill_apple_catalogue",
  "POST /admin/backfill/apple-music": "backfill_apple_music",

  "POST /admin/backfill/artist-credits": "backfill_artist_credits",

  "POST /admin/backfill/artist-edges": "backfill_artist_edges",
  "POST /admin/backfill/artist-images": "backfill_artist_images",
  "POST /admin/backfill/artists": "backfill_artists",

  "POST /admin/backfill/beatport": "backfill_beatport",

  "POST /admin/backfill/cover-masters": "backfill_cover_masters",

  "POST /admin/backfill/deezer": "backfill_deezer",
  "POST /admin/backfill/discogs": "backfill_discogs",

  "POST /admin/backfill/discogs-facts": "backfill_discogs_facts",
  "POST /admin/backfill/label-images": "backfill_label_images",

  "POST /admin/backfill/label-lineage": "backfill_label_lineage",

  "POST /admin/backfill/label-releases": "backfill_label_releases",
  "POST /admin/backfill/lastfm": "backfill_lastfm",

  "POST /admin/backfill/recording-mbids": "backfill_recording_mbids",

  "POST /admin/bio-reviews/{kind}/{slug}/resolve": "resolve_bio_review",

  "POST /admin/catalogue/anchor": "anchor_track",

  "POST /admin/catalogue/anchor/breaker/reset": "reset_spotify_anchor_breaker",

  "POST /admin/catalogue/anchor/failure": "record_anchor_failure",

  "POST /admin/catalogue/anchor/requeue": "requeue_anchor",

  "POST /admin/catalogue/anchor/resolve": "resolve_anchor",

  "POST /admin/catalogue/anchor/reviews/{trackId}/resolve": "resolve_anchor_review",

  "POST /admin/catalogue/apple-breaker/reset": "reset_apple_breaker",

  "POST /admin/catalogue/captures/requeue-unmatched": "requeue_unmatched_captures",

  "POST /admin/catalogue/captures/verify": "verify_capture",

  "POST /admin/catalogue/certify": "certify_track",
  "POST /admin/catalogue/crawl": "crawl_catalogue",
  "POST /admin/catalogue/crawl/commits": "commit_crawl_nodes",

  "POST /admin/catalogue/demand": "record_demand",

  "POST /admin/catalogue/force-capture": "force_capture",

  "POST /admin/catalogue/isrc-recovery/requeue": "requeue_isrc_recovery",

  "POST /admin/catalogue/rank": "rank_catalogue",

  "POST /admin/catalogue/wrong-audio/clear": "clear_wrong_audio",

  "POST /admin/catalogue/wrong-audio/flag": "flag_wrong_audio",
  "POST /admin/clips/drip": "drip_clips",

  "POST /admin/clips/schedule": "set_clip_schedules",

  "POST /admin/clips/{clipId}/cut/finalize": "finalize_clip_cut",

  "POST /admin/clips/{clipId}/cut/presign": "presign_clip_upload",

  "POST /admin/costs/events": "record_cost",

  "POST /admin/database-admission": "coordinate_database_admission",

  "POST /admin/frontier-playlists/refresh": "refresh_frontier_playlists",

  "POST /admin/frontier/covers": "upload_frontier_covers",

  "POST /admin/funnel/snapshot": "record_catalogue_snapshot",

  "POST /admin/health": "record_health",

  "POST /admin/hub-counts/reconcile": "reconcile_hub_counts",

  "POST /admin/labels": "mint_label",

  "POST /admin/labels/aliases/{id}/confirm": "confirm_label_alias",

  "POST /admin/labels/{slug}/bio": "describe_label",

  "POST /admin/labels/{slug}/merge": "merge_label",
  "POST /admin/labels/{slug}/triage": "record_label_triage",
  "POST /admin/lastfm/auth/session": "exchange_lastfm_session",

  "POST /admin/logbook/{sector}": "create_logbook_entry",

  "POST /admin/migrations/preview-archive": "migrate_preview_archive",
  "POST /admin/mixcloud/token": "mint_mixcloud_token",

  "POST /admin/mixtapes/{mixtapeId}/announce": "announce_mixtape",
  "POST /admin/mixtapes/{mixtapeId}/mixcloud/finalize": "finalize_mixtape_mixcloud",

  "POST /admin/mixtapes/{mixtapeId}/mixcloud/resync": "resync_mixtape_mixcloud",

  "POST /admin/mixtapes/{mixtapeId}/set-video/presign": "presign_set_video_upload",
  "POST /admin/mixtapes/{mixtapeId}/youtube/finalize": "finalize_mixtape_youtube",
  "POST /admin/mixtapes/{mixtapeId}/youtube/initiate": "initiate_mixtape_youtube",
  "POST /admin/mixtapes/{mixtapeId}/youtube/publish": "publish_mixtape_youtube",

  "POST /admin/mixtapes/{mixtapeId}/youtube/resync": "resync_mixtape_youtube",
  "POST /admin/newsletter/editions": "create_edition",
  "POST /admin/newsletter/editions/{id}/send": "send_edition",

  "POST /admin/note-rejections/{id}/resolve": "resolve_note_rejection",

  "POST /admin/observation-rejections/{id}/resolve": "resolve_observation_rejection",
  "POST /admin/operation-receipts/inspect": "get_operation_receipt",
  "POST /admin/operation-receipts/reconcile": "reconcile_operation_receipts",
  "POST /admin/operation-receipts/resolve": "resolve_operation_receipt",

  "POST /admin/projections/due-work/{workKind}/rekey": "rekey_due_work_queue",
  "POST /admin/projections/{target}/advance": "advance_projection",

  "POST /admin/prompts/{slug}": "update_prompt",
  "POST /admin/push/receipts/sweep": "sweep_push_receipts",

  "POST /admin/reach/collect": "record_platform_stats",
  "POST /admin/recordings": "create_recording",

  "POST /admin/recordings/{recordingId}/clips": "create_clip",
  "POST /admin/recordings/{recordingId}/promote": "promote_recording",
  "POST /admin/recordings/{recordingId}/set-video/presign": "presign_recording_upload",

  "POST /admin/social/metrics/record": "record_social_metrics",
  "POST /admin/social/posts/capture": "capture_post_urls",

  "POST /admin/social/publish/advance": "advance_publish_queue",
  "POST /admin/submissions/{submissionId}/approve": "approve_submission",
  "POST /admin/submissions/{submissionId}/reject": "reject_submission",

  "POST /admin/submissions/{submissionId}/triage": "triage_submission",

  "POST /admin/subscriptions": "create_subscription",

  "POST /admin/telemetry/runs": "record_run",
  "POST /admin/tracks": "publish_track",

  "POST /admin/tracks/captures/commit": "commit_track_captures",
  "POST /admin/tracks/captures/prepare": "prepare_track_captures",
  "POST /admin/tracks/embeddings": "update_track_embeddings",
  "POST /admin/tracks/{trackId}/capture/authorize": "authorize_track_capture",
  "POST /admin/tracks/{trackId}/capture/commit": "commit_track_capture",
  "POST /admin/tracks/{trackId}/capture/prepare": "prepare_track_capture",

  "POST /admin/tracks/{trackId}/context": "context_track",

  "POST /admin/tracks/{trackId}/note": "note_track",
  "POST /admin/tracks/{trackId}/observe": "observe_track",
  "POST /admin/tracks/{trackId}/social/{platform}/draft": "draft_track_social",
  "POST /admin/tracks/{trackId}/video/finalize": "finalize_track_video",

  "POST /admin/tracks/{trackId}/video/purge": "purge_video",

  "POST /admin/tracks/{trackId}/video/requeue": "requeue_video",
  "POST /admin/tracks/{trackId}/video/uploads": "presign_track_video_uploads",

  "POST /admin/twitch/live": "record_live_state",
  "POST /admin/youtube/token": "mint_youtube_token",

  "PUT /admin/catalogue/anchor/apify": "set_anchor_apify",
  "PUT /admin/catalogue/anchor/apify-budget": "set_anchor_apify_budget",

  "PUT /admin/catalogue/anchor/search": "set_anchor_search",

  "PUT /admin/catalogue/capture-budget": "set_capture_budget",

  "PUT /admin/catalogue/dismissed": "set_track_dismissed",

  "PUT /admin/clips/drip/state": "set_clip_drip",

  "PUT /admin/frontier/minting": "set_frontier_minting",

  "PUT /admin/galaxies/map": "update_galaxy_map",

  "PUT /admin/labels/{id}/artists": "replace_label_artist_rules",

  "PUT /admin/mixtapes/{mixtapeId}/cues": "set_mixtape_cues",

  "PUT /admin/projections/{target}/cutover": "set_projection_cutover",

  "PUT /admin/recordings/{recordingId}/cues": "replace_recording_cues",

  "PUT /admin/social/publish/advance/state": "set_publish_advance",

  "PUT /admin/tracks/{trackId}/capture-source": "pin_capture_source",

  "PUT /admin/vectors/tracks/serving": "set_vector_serving",
};

const ADMIN_CARVE_OUT_ROUTE_PREFIXES = [
  "spotify/auth/",
  "youtube/auth/",
  "mixcloud/auth/",

  "twitch/auth/",
  "instagram/auth/",

  "tiktok/auth/",

  "oauth/",
];

const ADMIN_CARVE_OUT_ROUTES = new Set([
  "chat",
  "logout",
  "tracks.$trackId.preview",
  "tracks.$trackId.preview-audio",
  "tracks.$trackId.silent-clip",
  "tracks.$trackId.source-audio",
]);

const ADMIN_DIR = fileURLToPath(new URL("../../routes/api/admin", import.meta.url));

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

function canonical(value: string): string {
  return value.replace(/[./]/g, " ").replace(/[${}]/g, "").trim().split(/\s+/).join("/");
}

function isAdminPath(path: string): boolean {
  return path === "/admin" || path.startsWith("/admin/");
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
      const isPending = false;

      expect(
        isConverted !== isPending,
        `${op}: a named admin op must be in the contract registry (converted)`,
      ).toBe(true);
    }
  });

  it("the admin registry holds EXACTLY the admin-path ops (no admin op outside the map)", () => {
    const namedAdminOps = new Set(Object.values(ADMIN_ROUTE_OPS).filter((op) => op !== PENDING));

    for (const op of converted) {
      const route = CONTRACT_OPERATION_ROUTES[op];

      if (!route) {
        expect.fail(`contract op "${op}" declares no route — it is outside both coverage nets`);
      }

      if (!isAdminPath(route.path) || namedAdminOps.has(op)) {
        continue;
      }

      expect.fail(
        `contract op "${op}" (${route.method} ${route.path}) is in the registry but absent from ADMIN_ROUTE_OPS — add its admin route entry`,
      );
    }
  });

  it("every admin map key matches the op's declared route", () => {
    for (const [key, op] of Object.entries(ADMIN_ROUTE_OPS)) {
      if (op === PENDING) {
        continue;
      }

      const route = CONTRACT_OPERATION_ROUTES[op];

      expect(route, `admin op "${op}" (${key}) is not in the contract registry`).toBeDefined();

      if (!route) {
        continue;
      }

      expect(
        `${route.method} ${route.path}`,
        `admin map key for "${op}" does not match its declared route`,
      ).toBe(key);
    }
  });

  it("enumerates every admin route file (no undocumented admin routes)", () => {
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

    for (const prefix of ADMIN_CARVE_OUT_ROUTE_PREFIXES) {
      expect(
        [...present].some((basename) => basename.startsWith(prefix)),
        `carve-out prefix "${prefix}" no longer matches any route`,
      ).toBe(true);
    }
  });
});
