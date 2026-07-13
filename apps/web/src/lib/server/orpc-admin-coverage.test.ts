import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CONTRACT_OPERATION_NAMES } from "@fluncle/contracts/orpc";

// The ADMIN coverage scaffold for the oRPC migration. The sibling orpc-coverage.test.ts
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
  // The `/admin/artists` review queue's inline remove (Unit 5) — contract-only oRPC
  // (no TanStack route file; oRPC owns the path directly). Operator tier.
  "DELETE /admin/artists/socials/{socialId}": "remove_artist_social",
  // The Fluncle Studio clip ops: clip CRUD +
  // the hardened post-publish cue backfill. `list_clips` is admin tier
  // (agent-allowed read); the writes are operator tier.
  "DELETE /admin/clips/{clipId}": "delete_clip",
  // The operator's "unschedule" — contract-only oRPC. Operator tier: take a clip off the
  // Instagram drip queue (delete its un-posted schedule row).
  "DELETE /admin/clips/{clipId}/schedule": "delete_clip_schedule",
  // The label-alias reject (RFC musickit-second-authority, U2a) — contract-only oRPC. Operator
  // tier: discard a proposed spelling; the agent token 403s.
  "DELETE /admin/labels/aliases/{id}": "reject_label_alias",
  // The newsletter edition delete — contract-only oRPC (no TanStack route file).
  // Operator tier: a hard delete that reaches a SENT edition too (pulling a sent
  // test edition from the public archive); the agent token 403s.
  "DELETE /admin/newsletter/editions/{id}": "delete_edition",
  // The RFC recording-primitive ops (Design B) — contract-only oRPC (no TanStack route
  // files; oRPC owns the paths directly). Reads are admin tier (agent-allowed — the box's
  // clip-cut cron resolves a recording); the writes + `promote` (mints a coordinate) are
  // operator tier.
  "DELETE /admin/recordings/{recordingId}": "delete_recording",
  // The operator's private cost ledger (COST-02) — contract-only oRPC (no TanStack
  // route file; oRPC owns the paths directly). `list` is admin tier; create/update/
  // delete are operator tier (the operator's private spend data — a valid agent token 403s).
  "DELETE /admin/subscriptions/{id}": "delete_subscription",
  // The artist-relationship RFC ops (Unit 2.1). `list_unresolved_artists` (the resolve
  // worklist) + `resolve_artist` are agent tier (the box's `fluncle-artist-sweep` cron
  // drives both with its agent-scoped token); `backfill_artists` (Unit 1) is agent tier too.
  "GET /admin/artists": "list_unresolved_artists",
  // The artist review queue read (Unit 5) — contract-only oRPC (no TanStack route file).
  // Admin tier (agent-allowed); the operator's review-queue station reads it.
  // `list_artist_socials` matches the public `list_` prefix so the "holds exactly" check
  // skips it; it lives here for completeness.
  "GET /admin/artists/socials": "list_artist_socials",
  // The `/admin` attention-queue digest read — contract-only oRPC (no TanStack route
  // file; oRPC owns the path directly). Admin tier (agent-allowed): the operator's
  // `fluncle admin queue` CLI + its Raycast menu bar read it. `get_attention` matches
  // the public `get_` prefix so the "holds exactly" check skips it; it lives here for
  // completeness (like `get_track_admin`).
  "GET /admin/attention": "get_attention",
  // THE EAR (docs/the-ear.md) — the ranked catalogue. Contract-only oRPC (no TanStack route
  // file; oRPC owns the path directly). Admin tier (agent-allowed); `list_catalogue_tracks`
  // matches the public `list_` prefix so the "holds exactly" check skips it, and it lives here
  // for completeness (like `list_labels_admin`).
  "GET /admin/catalogue": "list_catalogue_tracks",
  // THE CAPTURE BUDGET (docs/the-ear.md § The capture budget) — the spend readout behind the
  // brake on metered per-GB audio capture. Contract-only oRPC (no TanStack route file). Admin
  // tier (agent-allowed READ): seeing what a budget has left spends nothing.
  "GET /admin/catalogue/capture-budget": "get_capture_budget",
  // THE CRAWLER (docs/catalogue-crawler.md) — the frontier's state. Contract-only oRPC (no
  // TanStack route file). Admin tier (agent-allowed): the on-box `fluncle-crawl` sweep reads
  // it with its agent token, and so does the operator.
  "GET /admin/catalogue/captures/unverified": "list_unverified_captures",
  "GET /admin/catalogue/crawl": "get_crawl_status",
  "GET /admin/clips": "list_clips",
  // Every clip's Instagram drip-feed row (schedule + status) — contract-only oRPC (no
  // TanStack route file). Admin tier (agent-allowed read); the clip library / CLI merge
  // it onto the clips.
  "GET /admin/clips/social": "list_clip_posts",
  // The built clip caption (clean copy + the fluncle:// coordinate line(s)) —
  // contract-only oRPC (no TanStack route file). Admin tier (agent-allowed read); the
  // clip-card UI (Wave 3-B) shows + copies it. `get_clip_caption` matches the public
  // `get_` prefix so the "holds exactly" check skips it; it lives here for completeness.
  "GET /admin/clips/{clipId}/caption": "get_clip_caption",
  // The sonic galaxy map's admin read (browse-by-feel RFC) — contract-only oRPC (no
  // TanStack route file; oRPC owns the path directly). `list_galaxies_admin` matches
  // the public `list_` prefix so the "holds exactly" check skips it; it lives here for
  // completeness. Admin tier (agent-allowed — the `fluncle-cluster` cron reads it).
  "GET /admin/galaxies": "list_galaxies_admin",
  // The label entity + the operator's crawl-seed control — contract-only oRPC (no TanStack
  // route file; oRPC owns the path directly). Admin tier (agent-allowed read): the
  // catalogue crawler reads its seed set here (`?seedState=enabled`). `list_labels_admin`
  // matches the public `list_` prefix so the "holds exactly" check skips it; it lives here
  // for completeness (like `list_galaxies_admin`).
  "GET /admin/labels": "list_labels_admin",
  // The label-alias review reads (RFC musickit-second-authority, U2a) — contract-only oRPC.
  // Admin tier (agent-allowed read); `list_label_aliases` matches the public `list_` prefix so
  // the "holds exactly" check skips it, but the entry keeps this map honest.
  "GET /admin/labels/aliases": "list_label_aliases",
  "GET /admin/lastfm/auth/start": "start_lastfm_auth",
  // The logbook sweep's gap+material read — contract-only oRPC (no TanStack route
  // file; oRPC owns the path directly). Admin tier (agent-allowed). `list_logbook_gaps`
  // matches the public `list_` prefix so the "holds exactly" check skips it; it lives
  // here for completeness (like `list_editions_admin`).
  "GET /admin/logbook/gaps": "list_logbook_gaps",
  "GET /admin/mixtapes": "list_mixtapes_admin",
  "GET /admin/mixtapes/{mixtapeId}/social": "get_mixtape_social",
  // The newsletter edition list (drafts inclusive) — contract-only oRPC, no TanStack
  // route file (oRPC serves it off the registry). Admin tier (agent-allowed): the
  // Friday cron reads it from a fresh session to find an unsent draft + the window.
  "GET /admin/newsletter/editions": "list_editions_admin",
  // The echo gate's ledger — the auto-notes it refused to store, kept with the reason so
  // the operator can read them and rule. Contract-only oRPC (no TanStack route file).
  // Admin tier (agent-allowed read). `list_note_rejections` matches the public `list_`
  // prefix so the "holds exactly" check skips it; it lives here for completeness.
  "GET /admin/note-rejections": "list_note_rejections",
  // The prompt registry (docs/agents/prompt-registry.md) — contract-only oRPC (no
  // TanStack route file; oRPC owns the paths directly). `GET /admin/prompts/{slug}` is
  // the AGENT-tier per-tick resolve the on-box sweeps live on — the box runs a pinned CLI
  // and a baked image, so the API is the ONLY way a prompt reaches it without a rebake.
  // `list_prompts` (OPERATOR) matches the public `list_` prefix so the "holds exactly"
  // check skips it; it lives here for completeness.
  "GET /admin/prompts": "list_prompts",
  "GET /admin/prompts/{slug}": "get_prompt",
  "GET /admin/recordings": "list_recordings",
  "GET /admin/recordings/{recordingId}": "get_recording",
  "GET /admin/submissions": "list_submissions",
  "GET /admin/submissions/{submissionId}": "get_submission",
  // The cost-ledger read (COST-02) — contract-only oRPC (no TanStack route file).
  // Admin tier. `list_subscriptions` matches the public `list_` prefix so the "holds
  // exactly" check skips it; it lives here for completeness (like `list_artist_socials`).
  "GET /admin/subscriptions": "list_subscriptions",
  "GET /admin/tracks": "list_tracks_admin",
  // The embedded corpus (browse-by-feel RFC) — contract-only oRPC (no TanStack route
  // file; oRPC owns the path directly). Admin tier (agent-allowed): the `fluncle-cluster`
  // cron's input. `list_track_embeddings` matches the public `list_` prefix so the
  // "holds exactly" check skips it; it lives here for completeness. Static `/embeddings`
  // beats the `/{trackId}` param in oRPC's matcher (the `/tracks/random` precedent).
  "GET /admin/tracks/embeddings": "list_track_embeddings",
  // The dream-weaver order proposal (RFC mixability-engine) — contract-only oRPC (no
  // TanStack route file; oRPC owns the path directly). Admin tier (agent-allowed read).
  // `get_mixable_order` matches the public `get_` prefix so the "holds exactly" check
  // skips it; it lives here for completeness (like `get_track_admin`).
  "GET /admin/tracks/mixable-order": "get_mixable_order",
  // The single-finding admin lookup — contract-only oRPC (no TanStack route file; oRPC
  // owns the path directly, like context_track). Admin tier (agent-allowed read).
  // `get_track_admin` matches the public `get_` prefix so the "holds exactly" check
  // skips it; it lives here for completeness (like `get_clip_caption`).
  "GET /admin/tracks/{trackId}": "get_track_admin",
  "GET /admin/tracks/{trackId}/social": "list_track_social",
  // The fresh-links INLINE EDIT (correct + approve a social's URL in one act) — contract-only
  // oRPC (no TanStack route file; oRPC owns the path directly, sharing it with the DELETE remove
  // above). Operator tier: it writes an operator-owned, confirmed, public link.
  "PATCH /admin/artists/socials/{socialId}": "update_artist_social",
  "PATCH /admin/clips/{clipId}": "update_clip",
  // The operator's clip-drip schedule control — contract-only oRPC. Operator tier:
  // set/override a clip's Instagram drip slot.
  "PATCH /admin/clips/{clipId}/schedule": "set_clip_schedule",
  // The operator's galaxy naming write (browse-by-feel RFC) — contract-only oRPC (no
  // TanStack route file). OPERATOR tier: naming mints a public URL, so the agent token
  // 403s (the `note`/OPERATOR_ONLY precedent).
  "PATCH /admin/galaxies/{id}": "update_galaxy",
  // The operator's ruling on a label's crawl-seed state — contract-only oRPC (no TanStack
  // route file). OPERATOR tier: it steers what Fluncle crawls next (an editorial act), so
  // the agent token 403s. It changes no stored data — crawl scope, never storage.
  "PATCH /admin/labels/{id}": "update_label",
  // The operator's logbook overwrite/edit — contract-only oRPC (no TanStack route
  // file). Operator tier: it can replace a cron-authored entry, so the agent 403s.
  "PATCH /admin/logbook/{sector}": "update_logbook_entry",
  "PATCH /admin/mixtapes/{mixtapeId}": "update_mixtape",
  // The newsletter edition control plane. Contract-only oRPC — no TanStack route
  // files under /api/admin/newsletter
  // (oRPC serves them off the registry), so they have no file-enumeration entry;
  // they live here to satisfy the "registry holds EXACTLY this map's ops" check.
  // create/update are admin tier (agent-allowed drafting); send is operator-only.
  "PATCH /admin/newsletter/editions/{id}": "update_edition",
  // Retuning the auto-note echo gate — contract-only oRPC (no TanStack route file).
  // OPERATOR tier: the dials decide what Fluncle will and won't say about his archive, so
  // the agent token 403s. They live in the `settings` KV — a flip, not a deploy.
  "PATCH /admin/note-gate": "update_note_gate",
  "PATCH /admin/recordings/{recordingId}": "update_recording",
  // The cost-ledger edit (COST-02) — contract-only oRPC (no TanStack route file). Operator tier.
  "PATCH /admin/subscriptions/{id}": "update_subscription",
  "PATCH /admin/tracks/{trackId}": "update_track",
  "PATCH /admin/tracks/{trackId}/social/{platform}": "update_track_social",
  // The identity-graph per-social write (Unit 5) — contract-only oRPC (no TanStack route
  // file; oRPC owns the path directly). Operator tier (the queue's manual confirm).
  "POST /admin/artists/socials/{socialId}/confirm": "confirm_artist_social",
  // The per-link review — approve ONE fresh link in the board's fresh-links section. Operator tier.
  "POST /admin/artists/socials/{socialId}/review": "review_artist_social",
  // The artist social-identity resolution (Unit 2.1 of the artist-relationship RFC) —
  // contract-only oRPC (no TanStack route file; oRPC owns the path directly).
  // Agent tier: the box's `fluncle-artist-sweep` cron drives it with its agent token.
  "POST /admin/artists/{artistId}/resolve": "resolve_artist",
  "POST /admin/artists/{artistId}/review": "review_artist",
  "POST /admin/artists/{artistId}/socials": "add_artist_social",
  // The artist-entity backfill (Unit 1 of the artist-relationship RFC) —
  // contract-only oRPC (no TanStack route file; oRPC owns the path directly).
  // Agent tier: the box's `fluncle-artist-backfill` cron drives it with its agent token.
  // The Apple catalogue drain (RFC musickit U1) — contract-only oRPC (no TanStack route file).
  // Agent tier: the box's `fluncle-backfill` cron drives it with its agent token. It writes
  // catalogue identity only (a URL on `tracks`, facts on `albums`), never a certification.
  "POST /admin/backfill/apple-catalogue": "backfill_apple_catalogue",
  "POST /admin/backfill/apple-music": "backfill_apple_music",
  "POST /admin/backfill/artist-images": "backfill_artist_images",
  "POST /admin/backfill/artists": "backfill_artists",
  // Agent tier: the box's `fluncle-cover-masters` cron drives it. It owns an album's/artist's
  // ≤1200² cover master in R2 (RFC U3b), never a certification, never a publish.
  "POST /admin/backfill/cover-masters": "backfill_cover_masters",
  "POST /admin/backfill/discogs": "backfill_discogs",
  "POST /admin/backfill/label-images": "backfill_label_images",
  "POST /admin/backfill/lastfm": "backfill_lastfm",
  // The catalogue crawler's bounded pass — contract-only oRPC (no TanStack route file).
  // ADMIN tier (agent-allowed): the on-box `fluncle-crawl` sweep drives it with the agent
  // token. It certifies nothing (no `findings` row) and captures no audio, so it needs no
  // operator gate; RULING on a seed label — what may be crawled at all — is `update_label`,
  // and that stays operator tier.
  // The operator's reset for the cross-cutting Apple failure-regime breaker (RFC musickit U1) —
  // contract-only oRPC (no TanStack route file). OPERATOR tier: it re-arms a spend-adjacent
  // external integration a machine should not silently un-brake (the `set_capture_budget` rule).
  "POST /admin/catalogue/apple-breaker/reset": "reset_apple_breaker",
  // The capture-verification write — contract-only oRPC. Agent tier (the rank_catalogue
  // precedent): the box's `fluncle-verify-captures` sweep fingerprints a capture against its
  // official preview and reports the verdict; the SERVER routes it (docs/the-ear.md § Wrong
  // audio) — a catalogue mismatch quarantines, a FINDING mismatch only raises the operator
  // attention item (a machine never rewinds a public finding). Its worklist read
  // (`list_unverified_captures`, above) matches the public `list_` prefix and lives here for
  // completeness.
  "POST /admin/catalogue/captures/verify": "verify_capture",
  // Certify an existing catalogue row in place — contract-only oRPC. OPERATOR tier: certifying is
  // the one act the catalogue domain forbids a machine (docs/the-ear.md § The operator's actions).
  "POST /admin/catalogue/certify": "certify_track",
  "POST /admin/catalogue/crawl": "crawl_catalogue",
  // The dupe-veto escape hatch — contract-only oRPC. OPERATOR tier: overruling the sweep's own
  // duplicate verdict so a WRONG-vetoed row can be captured (docs/the-ear.md § Duplicates).
  "POST /admin/catalogue/force-capture": "force_capture",
  // The clip drip-feed tick — contract-only oRPC (no TanStack route file). ADMIN tier
  // (agent-allowed): the on-box `fluncle-clip-drip` cron triggers it with the agent token
  // (the box holds no Postiz key; the Worker owns it). Kill-switch aware, bounded, idempotent.
  // One tick of The Ear's precompute sweep — contract-only oRPC. Agent tier: it writes only
  // DERIVED ranking columns on CATALOGUE rows (a `tracks` row with no `findings` row), so it
  // cannot mint a coordinate or certify anything.
  "POST /admin/catalogue/rank": "rank_catalogue",
  // The wrong-audio quarantine override — contract-only oRPC. OPERATOR tier: overruling The Ear's
  // wrong-audio verdict on its own output is not an agent's call (docs/the-ear.md § Wrong audio).
  "POST /admin/catalogue/wrong-audio/clear": "clear_wrong_audio",
  // The clear's counterpart — flag a FINDING's capture as the wrong recording, the side the sweep
  // can never accuse. OPERATOR tier: it rewinds a public finding's enrichment on a human listen.
  "POST /admin/catalogue/wrong-audio/flag": "flag_wrong_audio",
  "POST /admin/clips/drip": "drip_clips",
  // The batch-schedule op (the set_clip_schedule sibling) — contract-only oRPC (no TanStack
  // route file). Operator tier: chain a whole selection onto the jittered drip queue in one
  // move; the web clip library's batch bar drives it.
  "POST /admin/clips/schedule": "set_clip_schedules",
  // The box's clip-cut finalize (Fluncle Studio Unit C) — contract-only oRPC (no
  // TanStack route file; oRPC owns the path directly, like finalize_track_video). Agent
  // tier: the box marks its own cut done + the handler purges the stale edge renditions.
  "POST /admin/clips/{clipId}/cut/finalize": "finalize_clip_cut",
  // The box's clip-cut upload presign (Fluncle Studio Unit C) — contract-only oRPC.
  // Agent tier: a single-PUT presign for the clip's `<clipId>/footage.mp4`. Path-symmetric
  // with the finalize above (both nest under `/cut/`).
  "POST /admin/clips/{clipId}/cut/presign": "presign_clip_upload",
  // The append-only cost ledger's write (COST-01) — contract-only oRPC (no TanStack
  // route file; oRPC owns the path directly, like record_health). Admin tier
  // (agent-allowed): the box's sweeps POST a tick's cost rows with the agent token.
  "POST /admin/costs/events": "record_cost",
  // record_health (the public /status dashboard's write) is contract-only oRPC —
  // no TanStack route file; oRPC owns the path directly, like context_track. Admin
  // tier (agent-allowed): the box's status cron POSTs a snapshot with its agent token.
  "POST /admin/health": "record_health",
  // The label-alias confirm (RFC musickit-second-authority, U2a) — contract-only oRPC. Operator
  // tier: fold a candidate spelling into the label; the agent token 403s.
  "POST /admin/labels/aliases/{id}/confirm": "confirm_label_alias",
  "POST /admin/lastfm/auth/session": "exchange_lastfm_session",
  // The logbook nightly author — contract-only oRPC (no TanStack route file; oRPC owns
  // the path directly, like note_track). Admin tier (agent-allowed): the on-box
  // `fluncle-logbook` cron drives the fill-empty-only create with its agent token.
  "POST /admin/logbook/{sector}": "create_logbook_entry",
  // The REF-05 preview-bucket migration — contract-only oRPC (no TanStack route file;
  // oRPC owns the path directly). Operator tier: a one-off, destructive-capable data
  // move (it can delete public R2 objects), dry-run by default.
  "POST /admin/migrations/preview-archive": "migrate_preview_archive",
  "POST /admin/mixcloud/token": "mint_mixcloud_token",
  // The crew announcement — contract-only oRPC (no TanStack route file; oRPC owns the
  // path directly). Operator tier: it posts a public Telegram crew callout, so the
  // agent token 403s.
  "POST /admin/mixtapes/{mixtapeId}/announce": "announce_mixtape",
  "POST /admin/mixtapes/{mixtapeId}/mixcloud/finalize": "finalize_mixtape_mixcloud",
  // The Mixcloud metadata re-sync — contract-only oRPC (no TanStack route file; oRPC
  // owns the path directly, like resync_mixtape_youtube). Operator tier: re-derives the
  // live cloudcast's sections[] from the current cues via the Mixcloud edit endpoint.
  "POST /admin/mixtapes/{mixtapeId}/mixcloud/resync": "resync_mixtape_mixcloud",
  // The set-video staging presign (Fluncle Studio Unit A) — contract-only oRPC (no
  // TanStack route file; oRPC owns the path directly). Operator tier: it opens a
  // multipart direct-to-R2 upload for the mixtape's `<logId>/set.mp4` rendition.
  "POST /admin/mixtapes/{mixtapeId}/set-video/presign": "presign_set_video_upload",
  "POST /admin/mixtapes/{mixtapeId}/youtube/finalize": "finalize_mixtape_youtube",
  "POST /admin/mixtapes/{mixtapeId}/youtube/initiate": "initiate_mixtape_youtube",
  "POST /admin/mixtapes/{mixtapeId}/youtube/publish": "publish_mixtape_youtube",
  // The YouTube metadata re-sync — contract-only oRPC (no TanStack route file; oRPC
  // owns the path directly, like publish_mixtape_youtube). Operator tier: re-derives
  // the live video's description + chapters from the current cues via videos.update.
  "POST /admin/mixtapes/{mixtapeId}/youtube/resync": "resync_mixtape_youtube",
  "POST /admin/newsletter/editions": "create_edition",
  "POST /admin/newsletter/editions/{id}/send": "send_edition",
  // The operator's ruling on a held auto-note — contract-only oRPC (no TanStack route
  // file). OPERATOR tier: `accepted` overrules the echo gate and writes the line onto the
  // finding's public /log page (publish-class), so the agent token 403s. The write takes
  // the same atomic fill-empty-only predicate as the agent's — it can never clobber an
  // operator note.
  "POST /admin/note-rejections/{id}/resolve": "resolve_note_rejection",
  // The push receipts sweep is a contract-only admin op (no TanStack route file —
  // the whole devices domain is contract-first oRPC), so it has no file-enumeration
  // entry; it lives here only to satisfy the "registry holds EXACTLY this map's
  // ops" check. An EXTERNAL cron calls it (TanStack has no `scheduled()`).
  // Appending a prompt version — an edit, a rollback, or a reset (they are one op, because
  // the history is append-only). OPERATOR tier: a prompt IS code, so an agent token 403s.
  "POST /admin/prompts/{slug}": "update_prompt",
  "POST /admin/push/receipts/sweep": "sweep_push_receipts",
  // record_platform_stats (the public /reach page's write) is contract-only oRPC —
  // no TanStack route file; oRPC owns the path directly, like record_health. Admin
  // tier (agent-allowed): the box's reach cron POSTs a bare trigger with its agent
  // token, and the Worker fetches every platform + writes the platform_stats snapshot.
  "POST /admin/reach/collect": "record_platform_stats",
  "POST /admin/recordings": "create_recording",
  // create_clip is now recording-scoped (RFC recording-primitive, Design B): the legacy
  // `POST /admin/mixtapes/{mixtapeId}/clips` path is retired.
  "POST /admin/recordings/{recordingId}/clips": "create_clip",
  "POST /admin/recordings/{recordingId}/promote": "promote_recording",
  "POST /admin/recordings/{recordingId}/set-video/presign": "presign_recording_upload",
  // capture_post_urls — contract-only oRPC (no TanStack route file; oRPC owns the
  // path directly). A collection-level sweep that recovers the public YouTube/TikTok
  // post URLs Postiz withholds on create. Admin tier — the on-box capture cron drives
  // it; it only fills the public url and links the analytics release-id.
  "POST /admin/social/posts/capture": "capture_post_urls",
  // The render → publish auto-advance tick — contract-only oRPC (no TanStack route file).
  // Admin tier (agent-allowed): the on-box `fluncle-publish-advance` cron triggers it and
  // the Worker (which holds the Postiz key) does the push.
  "POST /admin/social/publish/advance": "advance_publish_queue",
  "POST /admin/submissions/{submissionId}/approve": "approve_submission",
  "POST /admin/submissions/{submissionId}/reject": "reject_submission",
  // triage_submission (the pre-chew verdict write) is contract-only oRPC — no TanStack
  // route file; oRPC owns the path directly, like note_track. Admin tier (agent-allowed).
  "POST /admin/submissions/{submissionId}/triage": "triage_submission",
  // The cost-ledger create (COST-02) — contract-only oRPC (no TanStack route file). Operator tier.
  "POST /admin/subscriptions": "create_subscription",
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
  // record_live_state (the cross-surface live-set callout's write) is contract-only
  // oRPC — no TanStack route file; oRPC owns the path directly, like record_health.
  // Admin tier (agent-allowed): the box's `fluncle-live` poller POSTs the raw Twitch
  // state with its agent token each minute.
  "POST /admin/twitch/live": "record_live_state",
  "POST /admin/youtube/token": "mint_youtube_token",
  // The catalogue capture budget + its kill switch — contract-only oRPC (no TanStack route
  // file). OPERATOR tier: it decides how much of the operator's money a metered residential
  // proxy may spend, so the box's agent token 403s on it (an agent may not raise its own
  // budget). The read half is `get_capture_budget`, above.
  "PUT /admin/catalogue/capture-budget": "set_capture_budget",
  // The catalogue "not for me" / restore toggle — contract-only oRPC. OPERATOR tier: steering
  // what the telescope keeps pointing at is a taste ruling (docs/the-ear.md § The operator's
  // actions), so the box's agent token 403s.
  "PUT /admin/catalogue/dismissed": "set_track_dismissed",
  // The clip drip-feed kill switch — contract-only oRPC (no TanStack route file).
  // Operator tier: pause/resume every future scheduled Instagram post.
  "PUT /admin/clips/drip/state": "set_clip_drip",
  // The cluster cron's transactional map write (browse-by-feel RFC) — contract-only oRPC
  // (no TanStack route file). Admin tier (agent-allowed): the Worker mints new galaxy
  // ids + handles server-side; the box's `fluncle-cluster` cron drives it.
  "PUT /admin/galaxies/map": "update_galaxy_map",
  // The hardened post-publish cue backfill (Fluncle Studio Unit D, panel M1):
  // re-times an existing minted tracklist's start_ms; operator tier.
  "PUT /admin/mixtapes/{mixtapeId}/cues": "set_mixtape_cues",
  // The interactive single-cue write behind the Studio cue rail — contract-only oRPC
  // (no TanStack route file; oRPC owns the path directly). Operator tier: upsert/clear
  // ONE minted member's start_ms; distinct from the batch cues PUT above (nested under
  // the `{ref}` member segment, no coverage/order constraint).
  "PUT /admin/mixtapes/{mixtapeId}/cues/{ref}": "update_mixtape_cue",
  // The PUT shares the `members` file/path with the POST above (append vs replace);
  // oRPC routes the two methods to distinct ops, so each gets its own entry.
  // Replace a recording's whole cue set (RFC plan→recording→mixtape §4) — contract-only
  // oRPC (no TanStack route file; oRPC owns the path directly). Operator tier: the
  // Wave-3 Rekordbox derivation script PUTs the ordered, finding-resolved cues here.
  "PUT /admin/recordings/{recordingId}/cues": "replace_recording_cues",
  // The render → publish auto-advance KILL SWITCH — contract-only oRPC (no TanStack route
  // file). Operator tier: pause/resume every future auto-publish, no deploy.
  "PUT /admin/social/publish/advance/state": "set_publish_advance",
};

// Routes that stay on TanStack by design (carve-outs), keyed by their TanStack
// file basename (relative to the admin
// route dir). NOT counted against coverage — they will never have a contract —
// but listed so the enumeration is total and a new carve-out is a deliberate edit.
//
//   - OAuth browser-redirect callbacks/starts (Spotify / YouTube / Mixcloud, plus the
//     /reach Tier-2 Twitch / TikTok / Instagram `*/auth/*`): they return 302 redirects,
//     not RPC JSON. Permanent. (Last.fm's
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
const ADMIN_CARVE_OUT_ROUTE_PREFIXES = [
  "spotify/auth/",
  "youtube/auth/",
  "mixcloud/auth/",
  // The /reach Tier-2 OAuth starts + callbacks (docs/reach-tier2-activation.md): 302
  // browser redirects like the others, not RPC JSON — permanent carve-outs.
  "twitch/auth/",
  "tiktok/auth/",
  "instagram/auth/",
];

const ADMIN_CARVE_OUT_ROUTES = new Set([
  "chat", // ChatDnB (spike): streams an NDJSON transcript (one event per line) from streamText, not a single RPC JSON body — a streaming carve-out like the media proxies.
  "logout", // a 302 redirect (expire the grant cookie, bounce to /admin/login), not RPC JSON.
  "tracks.$trackId.preview", // multipart-file body (formData → File).
  "tracks.$trackId.preview-audio", // a streaming media proxy: streams the archived 30s preview bytes from R2 (private, or the legacy public bucket), not RPC JSON.
  "tracks.$trackId.silent-clip", // a same-origin download proxy: streams the audio-stripped social cut as an attachment, not RPC JSON.
  "tracks.$trackId.source-audio", // a streaming media proxy: streams the captured full song from the private R2 bucket, not RPC JSON.
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
      // The `/me/preferences` cross-device store (private-session, not admin). The
      // read matches `get_` above; this covers its partial-merge write.
      "update_my",
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
