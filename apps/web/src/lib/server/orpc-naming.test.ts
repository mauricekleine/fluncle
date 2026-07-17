import { describe, expect, it } from "vitest";
import { CONTRACT_OPERATION_NAMES } from "@fluncle/contracts/orpc";

// Turns the ratified `verb_noun` cross-surface naming convention from a
// review-only rule into a BUILD-FAIL check. The contract registry
// (`@fluncle/contracts/orpc`) is the
// source of truth for every machine-facing op name, and every key in it is
// the canonical op the rest of the surfaces (CLI/API/MCP/SSH) derive from. So
// asserting the registry keys all obey the convention enforces it everywhere a
// name is derived from.
//
// The sibling coverage tests (orpc-coverage.test.ts / orpc-admin-coverage.test.ts)
// pin the exact SET of ops a route maps to. This test is the complement: it does
// NOT pin the full list (that would duplicate them and rot), it pins the SHAPE +
// the verb each op name must take. An op added in camelCase, as a single word, or
// with an unapproved verb fails the build here, before it can leak a fifth
// spelling of an operation onto a public surface.

// The canonical op-name shape: `verb_noun`, lowercase `snake_case`, at least two
// segments, each segment a run of [a-z0-9] (digits allowed only after the first
// letter of a segment). Catches camelCase (`getTrack`), a bare single word
// (`enrich`), SCREAMING_CASE, and leading/trailing/double underscores.
const VERB_NOUN_SHAPE = /^[a-z]+(?:_[a-z0-9]+)+$/;

// The approved leading verbs. The convention names a small closed set
// (`list`, `get`, `search`, `submit`, `subscribe`, `create`, `update`, `delete`,
// `publish`) plus a named non-CRUD action set (`enrich`, `observe`, `render`,
// `draft`, `distribute`, `backfill`, `authorize`, `finalize`). The live registry
// also already uses a handful of additional concrete actions the doc's prose set
// doesn't enumerate verbatim (e.g. `add`, `approve`, `mint`). To enforce the
// VERB without pinning the full op list (the coverage tests already pin that),
// this set is the doc's closed set UNIONED with the verbs the registry uses
// today. The point it guards: a NEW op must reuse one of these verbs — an
// off-convention coinage (`fetch_track`, `grab_track`) fails here, forcing it
// back to the registry vocabulary or a deliberate edit of this set with a reason.
const APPROVED_VERBS = new Set<string>([
  // The convention's closed CRUD-ish verb set.
  "create",
  "delete",
  "get",
  "list",
  "publish",
  "search",
  "submit",
  "subscribe",
  "update",
  // The convention's named non-CRUD action set.
  // `advance` (move a finding one step further along the pipeline it is already in —
  // render → publish) — added deliberately with the `advance_publish_queue` auto-advance
  // tick. Not `publish` (that names the one-shot act, and the tick may push nothing) and
  // not `drip` (that is the clip-feed's paced, jittered cadence). This names the CHAINING:
  // the step that stops a finished stage from waiting on a human tap.
  "advance",
  "authorize",
  "backfill",
  // `resolve` — resolve an artist's social profiles from MB + Firecrawl (the artist-relationship epic).
  "resolve",
  // `capture` (recover the public YouTube/TikTok post URLs Postiz withholds on
  // create, building each from the platform's native content id) — added
  // deliberately with the `capture_post_urls` sweep.
  "capture",
  "distribute",
  "draft",
  // `drip` (post one bounded tick of due clips to Instagram) — added deliberately with
  // the clip-drip-feed `drip_clips` op. The drip-feed's own verb: neither `publish` (a
  // one-shot direct post) nor `distribute` (the multi-GB mixtape byte-move) fits the
  // paced, kill-switch-aware, capped queue-drain this names.
  "drip",
  "enrich",
  "finalize",
  // `migrate` (move data between stores as a one-off operator-run migration) — added
  // deliberately with the REF-05 `migrate_preview_archive` op, which relocates the
  // archived 30s previews from the public bucket to the private one. Distinct from
  // `backfill` (fill missing data) — this MOVES existing data + rewrites pointers.
  "migrate",
  // `note` (auto-author a finding's editorial note) — the written-note sibling of
  // `observe`/`context`, same verb-as-action shape ("note this finding").
  "note",
  "observe",
  // `purge` (evict a finding's stale Cloudflare video renditions from the edge) —
  // ratified into the action set with the `purge_video` re-render cache command.
  // The sibling of `requeue` on the video lifecycle:
  // `requeue_video` clears the render gates, `purge_video` clears the edge cache.
  "purge",
  // `rank` (precompute each catalogue track's nearest finding + its capture priority) —
  // added deliberately with The Ear's `rank_catalogue` sweep. Distinct from every verb
  // already here: it neither fills missing data (`backfill`) nor moves it (`migrate`) nor
  // measures it (`enrich`) — it ORDERS an existing corpus against Fluncle's taste, and the
  // ordering IS the product.
  "rank",
  "render",
  // `requeue` (put a finding's video back on the render queue) — ratified into the
  // action set with the `requeue_video` re-render command.
  "requeue",
  // `resync` (re-derive a published mixtape's distribution metadata from its current
  // cues and push it to the live platform — no re-upload) — added deliberately with the
  // `resync_mixtape_youtube` + `resync_mixtape_mixcloud` ops (both server-side).
  "resync",
  // `verify` (check a stored artifact against a REFERENCE and record the verdict) — added
  // deliberately with the capture-verification `verify_capture` op (docs/the-ear.md § Wrong
  // audio): the captured full song is fingerprinted against the track's ISRC-resolved official
  // preview to catch wrong-audio captures. Genuinely new: not `enrich` (derive an entity's own
  // attributes from its own audio/facts), not `rank` (order a corpus against taste), not `resolve`
  // (fix an external identity) — it ADJUDICATES a captured artifact against ground truth.
  "verify",
  // Concrete actions already in the live registry the prose set doesn't spell out
  // verbatim. Adding a genuinely new verb is a deliberate edit here (with a reason),
  // which is exactly the gate this test exists to enforce.
  "add",
  // `announce` (post a published mixtape's crew callout to the Telegram crew channel) —
  // added deliberately with the `announce_mixtape` op. The last lifecycle step; neither
  // `publish` (mint/flip) nor `distribute` (the byte-move) names the act of telling the crew.
  "announce",
  "approve",
  // `certify` (turn an existing catalogue row into a finding in place — mint its certification
  // half, without creating a new track) — added deliberately with The Ear's `certify_track` op.
  // It names the exact act the catalogue domain otherwise forbids: `publish` is the Spotify add
  // (it inserts a new track), while this certifies a row the archive ALREADY holds. It is the one
  // catalogue act reserved for the operator.
  "certify",
  "collect",
  // `confirm` (promote a candidate artist social to `confirmed`, letting it onto the
  // public artist page) — added deliberately with the artist-relationship `confirm_artist_social`
  // op. The operator's one-tap trust gate; distinct from `update` (edit a field).
  "confirm",
  "context",
  // `describe` (auto-author an artist's/label's voiced public bio — the entity sibling of
  // `note`) — added deliberately with the `describe_artist` / `describe_label` bio-engine
  // ops. Distinct from `note` (that names ONE finding's editorial line): this describes a
  // whole ENTITY (an artist, a label) in a short grounded paragraph.
  "describe",
  // `crawl` (walk the MusicBrainz release graph outward from the operator's enabled seed
  // labels and write catalogue rows into `tracks`) — added deliberately with the
  // `crawl_catalogue` op. A genuinely new action: neither `backfill` (fill missing data on
  // rows we already hold) nor `resolve` (fix a known entity's external identity) names the
  // act of DISCOVERING tracks the archive has never heard of. It certifies nothing.
  "crawl",
  "deregister",
  "exchange",
  "export",
  "initiate",
  "merge",
  "mint",
  "presign",
  // `promote` (turn a captured recording into a full published mixtape — mint-or-reuse a
  // coordinate) — added deliberately with the RFC recording-primitive `promote_recording` op.
  "promote",
  // `record` (persist a service-health snapshot for the public /status dashboard) —
  // the agent-tier write the box's status cron drives. "Record this snapshot": a
  // genuinely new action verb, added deliberately with the `record_health` op.
  "record",
  // `refresh` (re-mirror every crew member's Frontier playlist from their current
  // recommendations — E2, the public recommendation machine) — added deliberately with
  // the `refresh_frontier_playlists` weekly sweep. The word the roadmap + the mint's own
  // "refreshed" status use for the act: distinct from `resync` (re-derive a published
  // mixtape's metadata and push it, no re-upload) and `rank` (order a corpus) — this
  // RE-COMPUTES a per-user recommendation set and full-replaces the playlist that mirrors it.
  "refresh",
  "register",
  "reject",
  // `remove` (drop one of an artist's social links inline in the review queue) — added
  // deliberately with the artist-relationship `remove_artist_social` op. The delete-a-
  // sub-row sibling of `add_artist_social`; distinct from `delete` (drop a whole entity).
  "remove",
  // `replace` (transactionally swap a recording's WHOLE cue set for a new ordered one)
  // — added deliberately with the `replace_recording_cues` op (the Wave-3 Rekordbox
  // derivation write target). Distinct from `set_*` (re-time an existing set) and
  // `update_*` (edit fields): this REPLACES all the rows.
  "replace",
  "reset",
  // `clear` (lift the wrong-audio quarantine on one catalogue row — the operator's override on
  // The Ear's wrong-audio verdict) — added deliberately with `clear_wrong_audio` (docs/the-ear.md
  // § Wrong audio). Distinct from `reset` (restore an initial state) and `delete` (drop a row): it
  // CLEARS a flag/verdict, keeping the row and its captured audio.
  "clear",
  // `flag` (mark a finding's captured audio as the wrong recording — the operator's counterpart
  // to `clear`) — added deliberately with `flag_wrong_audio` (docs/the-ear.md § Wrong audio). It
  // RAISES the verdict the sweep can only raise against the catalogue side; `clear` lifts one.
  "flag",
  // `force` (overrule a WRONG duplicate veto so a catalogue row can be captured — the dupe-veto
  // escape hatch) — added deliberately with `force_capture` (docs/the-ear.md § Duplicates). It
  // names OVERRIDING a self-sealing machine gate to make an acquisition happen: distinct from
  // `clear` (lift a wrong-audio flag on an already-captured row) and `rank`/`crawl`/`capture` —
  // it is the operator forcing an action past a verdict the sweep would otherwise re-apply forever.
  "force",
  // `review` (mark an artist's link list as reviewed — the "Looks good" acknowledgment that
  // stamps reviewed_at and promotes surviving candidates) — added deliberately with
  // `review_artist`. A single per-artist ack, distinct from `confirm` (one link) and `approve`
  // (a submission).
  "review",
  "save",
  "send",
  "set",
  "start",
  "sweep",
  // `triage` (write the pre-chew advisory verdict onto a pending submission) — added
  // deliberately with the `triage_submission` op. The written-verdict sibling of
  // `note` (author the finding's note): the on-box `fluncle-triage` sweep pre-chews a
  // crew submission so it lands in the operator's queue already assessed. Advisory
  // only; distinct from `approve`/`reject` (the operator's publishing decision).
  "triage",
  "unsave",
  // `upload` (render + push a Frontier playlist cover onto Spotify) — added deliberately with the
  // `upload_frontier_covers` mint-cover retry drain (E2). The act of putting a rendered artifact
  // onto an external platform: distinct from `distribute` (the multi-GB mixtape byte-move),
  // `publish` (a one-shot social post), and `render` (make the artifact) — this UPLOADS it.
  "upload",
]);

describe("oRPC op-name naming convention (verb_noun, Convention B)", () => {
  const opNames = [...CONTRACT_OPERATION_NAMES] as string[];

  it("has ops to check (registry is not empty)", () => {
    // A guard so a broken import can't make the assertions below pass vacuously.
    expect(opNames.length).toBeGreaterThan(0);
  });

  it("every contract op name is lowercase snake_case `verb_noun`", () => {
    for (const op of opNames) {
      expect(
        VERB_NOUN_SHAPE.test(op),
        `op "${op}" is not a lowercase snake_case verb_noun (e.g. "get_track")`,
      ).toBe(true);
    }
  });

  it("every contract op name starts with an approved verb", () => {
    for (const op of opNames) {
      const verb = op.split("_")[0] ?? op;

      expect(
        APPROVED_VERBS.has(verb),
        `op "${op}" leads with the unapproved verb "${verb}" — reuse a verb from the convention's closed set or add it to APPROVED_VERBS deliberately`,
      ).toBe(true);
    }
  });
});
