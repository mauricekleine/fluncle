import { describe, expect, it } from "vitest";
import { dueWorkMaintenancePendingMiddleware } from "./orpc-backpressure";
import { router } from "./orpc";
import { adminAuth, operatorGuard, privateUserAuth } from "./orpc-auth";

type AuthTier = "admin" | "operator" | "private-session" | "public-unauth";

const STATIC_MIDDLEWARE_TIERS = new Map<unknown, "admin" | "operator" | "private-session">([
  [adminAuth, "admin"],
  [operatorGuard, "operator"],
  [privateUserAuth, "private-session"],
]);

const NON_AUTH_MIDDLEWARES = new Set<unknown>([dueWorkMaintenancePendingMiddleware]);

function middlewaresOf(op: unknown): unknown[] {
  const orpc = (op as Record<string, unknown>)["~orpc"] as Record<string, unknown> | undefined;
  const middlewares = orpc?.middlewares;

  return Array.isArray(middlewares)
    ? middlewares.filter((middleware) => !NON_AUTH_MIDDLEWARES.has(middleware))
    : [];
}

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

  if (tags.length === 1 && tags[0] === "unknown") {
    return "private-session";
  }

  return null;
}

const PUBLIC_UNAUTH_OPS = new Set<string>([
  "get_album",
  "get_label",
  "list_albums",
  "list_labels",

  "get_artist",
  "get_edition",

  "get_galaxy",

  "get_graph_preview",
  "get_health",
  "get_radio_now_playing",
  "get_random_radio_track",
  "get_random_track",

  "get_replica_token",
  "get_track",
  "list_artists",

  "list_findings",
  "list_similar_tracks",

  "list_similar_artists",
  "list_editions",
  "list_galaxies",

  "list_fresh",
  "list_mix_openers",
  "list_mixable_artists",
  "list_mixable_tracks",

  "list_set_tracks",
  "list_mixtapes",
  "list_stories",

  "list_platform_stats",
  "list_tracks",

  "search_archive",
  "search_tracks",

  "deregister_device",
  "register_device",
  "submit_track",
  "subscribe_newsletter",

  "get_current_private_user",
]);

const EXPECTED_TIERS: Record<string, "admin" | "operator" | "private-session"> = {
  acknowledge_artifact_changes: "admin",
  activate_artifact_consumer: "admin",

  add_artist_rule: "operator",

  add_artist_social: "operator",

  advance_projection: "admin",

  advance_publish_queue: "admin",

  anchor_track: "admin",

  announce_mixtape: "operator",
  approve_submission: "operator",

  authorize_track_capture: "admin",

  backfill_apple_catalogue: "admin",

  backfill_apple_music: "admin",

  backfill_artist_credits: "admin",

  backfill_artist_edges: "admin",

  backfill_artist_images: "admin",

  backfill_artists: "admin",

  backfill_beatport: "admin",

  backfill_cover_masters: "admin",

  backfill_deezer: "admin",
  backfill_discogs: "admin",

  backfill_discogs_facts: "admin",

  backfill_label_images: "admin",

  backfill_label_lineage: "admin",

  backfill_label_releases: "admin",
  backfill_lastfm: "admin",

  backfill_recording_mbids: "admin",

  capture_post_urls: "admin",

  certify_track: "operator",
  checkpoint_artifact_rebuild: "admin",

  clear_capture_source: "operator",

  clear_wrong_audio: "operator",
  collect_private_galaxy_log: "private-session",

  commit_crawl_nodes: "admin",
  commit_track_capture: "admin",
  commit_track_captures: "admin",

  compact_artifact_changes: "operator",

  confirm_artist_social: "operator",

  confirm_label_alias: "operator",
  context_track: "admin",

  coordinate_database_admission: "admin",

  crawl_catalogue: "admin",

  create_clip: "operator",
  create_edition: "admin",

  create_logbook_entry: "admin",

  create_recording: "operator",

  create_subscription: "operator",
  delete_clip: "operator",

  delete_clip_schedule: "operator",
  delete_edition: "operator",
  delete_private_account: "private-session",

  delete_private_rec_seed: "private-session",
  delete_private_saved_set: "private-session",

  delete_private_watch: "private-session",
  delete_recording: "operator",
  delete_subscription: "operator",

  describe_album: "admin",

  describe_artist: "admin",

  describe_label: "admin",

  draft_album_bio: "admin",

  draft_artist_bio: "admin",

  draft_label_bio: "admin",
  draft_track_social: "admin",

  drip_clips: "admin",
  exchange_lastfm_session: "operator",
  export_private_account_data: "private-session",

  finalize_clip_cut: "admin",
  finalize_mixtape_mixcloud: "operator",
  finalize_mixtape_youtube: "operator",

  finalize_track_video: "admin",

  flag_wrong_audio: "operator",

  force_capture: "operator",

  get_anchor_apify_budget: "admin",
  get_artifact_consumer: "admin",
  get_attention: "admin",

  get_capture_budget: "admin",

  get_clip_caption: "admin",

  get_crawl_status: "admin",

  get_frontier_minting: "admin",

  get_funnel: "admin",

  get_mixable_order: "admin",
  get_mixtape_social: "admin",

  get_operation_receipt: "admin",
  get_private_account_export: "private-session",

  get_private_frontier_edition: "private-session",

  get_private_frontier_playlist: "private-session",
  get_private_galaxy_progress: "private-session",
  get_private_mutation_token: "private-session",

  get_private_preferences: "private-session",

  get_projection_status: "admin",

  get_prompt: "admin",
  get_recording: "admin",

  get_social_metrics: "admin",

  get_spotify_anchor_breaker: "admin",
  get_submission: "admin",

  get_track_admin: "admin",
  get_vector_serving: "operator",

  inactivate_artifact_consumer: "admin",
  initiate_mixtape_youtube: "operator",

  list_albums_missing_bio: "admin",
  list_artifact_changes: "admin",
  list_artifact_snapshot: "admin",

  list_artist_rules: "admin",

  list_artist_socials: "admin",

  list_artists_missing_bio: "admin",

  list_catalogue_tracks: "admin",

  list_clip_posts: "admin",

  list_clips: "admin",
  list_editions_admin: "admin",

  list_galaxies_admin: "admin",

  list_label_aliases: "admin",

  list_label_artist_rules: "admin",

  list_labels_admin: "admin",

  list_labels_missing_bio: "admin",

  list_logbook_gaps: "admin",
  list_mixtapes_admin: "admin",

  list_note_rejections: "admin",

  list_observation_neighbours: "admin",
  list_observation_rejections: "admin",

  list_private_frontier_editions: "private-session",

  list_private_galaxy_collection: "private-session",

  list_private_rec_seeds: "private-session",

  list_private_recommendations: "private-session",
  list_private_saved_findings: "private-session",
  list_private_saved_sets: "private-session",
  list_private_submissions: "private-session",

  list_private_watches: "private-session",

  list_prompts: "operator",
  list_recordings: "admin",
  list_submissions: "admin",
  list_subscriptions: "admin",

  list_track_embeddings: "admin",
  list_track_social: "admin",

  list_track_work: "admin",
  list_tracks_admin: "admin",

  list_unresolved_artists: "admin",

  list_unverified_captures: "admin",

  list_users_admin: "admin",

  merge_label: "operator",
  merge_private_galaxy_progress: "private-session",

  migrate_preview_archive: "operator",

  mint_label: "operator",
  mint_mixcloud_token: "operator",

  mint_private_frontier_playlist: "private-session",
  mint_youtube_token: "operator",

  note_track: "admin",
  observe_track: "admin",

  pin_capture_source: "operator",

  prepare_track_capture: "admin",
  prepare_track_captures: "admin",

  presign_clip_upload: "admin",

  presign_recording_upload: "operator",

  presign_set_video_upload: "operator",

  presign_track_video_uploads: "admin",

  promote_recording: "operator",
  publish_mixtape_youtube: "operator",
  publish_track: "operator",

  purge_video: "operator",

  rank_artists: "admin",
  rank_catalogue: "admin",

  read_run_ledger: "operator",

  reconcile_hub_counts: "admin",

  reconcile_operation_receipts: "operator",

  record_anchor_failure: "admin",

  record_catalogue_snapshot: "admin",
  record_cost: "admin",

  record_demand: "admin",

  record_health: "admin",

  record_live_state: "admin",

  record_platform_stats: "admin",

  record_run: "admin",

  record_social_metrics: "admin",

  refresh_frontier_playlists: "admin",

  register_artifact_consumer: "admin",

  reject_label_alias: "operator",
  reject_submission: "operator",

  rekey_due_work_queue: "operator",

  remove_artist_rule: "operator",

  remove_artist_social: "operator",

  replace_label_artist_rules: "operator",

  replace_recording_cues: "operator",

  requeue_anchor: "operator",
  requeue_isrc_recovery: "operator",
  requeue_unmatched_captures: "operator",

  requeue_video: "operator",

  reset_apple_breaker: "operator",

  reset_spotify_anchor_breaker: "operator",

  resolve_anchor: "admin",

  resolve_anchor_review: "operator",

  resolve_artist: "admin",

  resolve_bio_review: "operator",

  resolve_note_rejection: "operator",

  resolve_observation_rejection: "operator",

  resolve_operation_receipt: "admin",

  resync_mixtape_mixcloud: "operator",

  resync_mixtape_youtube: "operator",

  review_artist: "operator",

  review_artist_social: "operator",

  revoke_admin_grants: "operator",
  save_private_finding: "private-session",

  save_private_rec_seed: "private-session",
  save_private_set: "private-session",

  save_private_watch: "private-session",
  send_edition: "operator",

  set_anchor_apify: "operator",

  set_anchor_apify_budget: "operator",

  set_anchor_search: "operator",

  set_capture_budget: "operator",

  set_clip_drip: "operator",

  set_clip_schedule: "operator",

  set_clip_schedules: "operator",

  set_frontier_minting: "operator",

  set_mixtape_cues: "operator",

  set_projection_cutover: "operator",

  set_publish_advance: "operator",

  set_track_dismissed: "operator",
  set_vector_serving: "operator",
  start_lastfm_auth: "operator",
  sweep_push_receipts: "admin",

  triage_submission: "admin",
  unsave_private_finding: "private-session",

  update_artist_rule: "operator",

  update_artist_social: "operator",
  update_clip: "operator",
  update_edition: "admin",

  update_galaxy: "operator",

  update_galaxy_map: "admin",

  update_label: "operator",

  update_logbook_entry: "operator",
  update_mixtape: "operator",

  update_note_gate: "operator",
  update_observation_gate: "operator",

  update_private_preferences: "private-session",
  update_private_profile: "private-session",
  update_private_saved_set: "private-session",

  update_prompt: "operator",
  update_recording: "operator",
  update_subscription: "operator",
  update_track: "admin",
  update_track_embeddings: "admin",
  update_track_social: "operator",

  upload_frontier_covers: "admin",

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

      expect(
        declared,
        `op "${name}" is not assigned an explicit auth tier — it derives "${derived}". Add it to EXPECTED_TIERS with its deliberate tier, or to PUBLIC_UNAUTH_OPS if it is intentionally unauthenticated.`,
      ).toBeDefined();

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
