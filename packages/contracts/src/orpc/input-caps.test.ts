// Self-running check for INPUT caps on bounded admin operations — no framework, the
// `devices.test.ts` style. Most writes here are AGENT tier (the box's token drives them, so the
// threat is a buggy or compromised sweep posting an unbounded payload, not a stranger);
// `read_run_ledger` and two of the three R2 presigns are operator tier. Each cap is asserted at
// the cap (accepted — the real sizes are far below it) and one past it (REJECTED at the edge,
// never trimmed: a dropped cost row is a wrong ledger, a dropped cluster is a broken map).
// The presign block at the bottom bounds a VALUE rather than a size, for the same reason: what
// it refuses would otherwise be served to the world under a Fluncle origin.
// Run: `bun src/orpc/input-caps.test.ts`.

import assert from "node:assert/strict";

import {
  ANCHOR_CANDIDATE_LIMIT,
  DEEZER_CANDIDATE_LIMIT,
  anchorTrack,
  resolveAnchor,
} from "./admin-catalogue";
import {
  backfillDiscogs,
  backfillDiscogsFacts,
  backfillLabelImages,
  DISCOGS_FACTS_WORK_LIMIT,
  DISCOGS_LABEL_WORK_LIMIT,
  DISCOGS_RELEASES_PER_TRACK_LIMIT,
  DISCOGS_RELEASE_WORK_LIMIT,
} from "./admin-backfills";
import { recordCost } from "./admin-costs";
import { updateArtistRule } from "./admin-artist-rules";
import { replaceLabelArtistRules } from "./admin-labels";
import {
  MAX_RUN_DATABASE_COUNT,
  MAX_RUN_LEDGER_PAGE_SIZE,
  MAX_SUMMARY_RAW_CHARS,
  readRunLedger,
  recordRun,
} from "./admin-telemetry";
import { updateGalaxyMap } from "./admin-galaxies";
import { presignClipUpload, presignSetVideoUpload } from "./admin-mixtapes";
import { presignRecordingUpload } from "./admin-recordings";

/**
 * The Standard Schema surface we need, spelled out locally rather than imported from
 * `@standard-schema/spec` (a transitive dep of oRPC, not one this package declares).
 */
type Validator = {
  "~standard": {
    validate: (input: unknown) => { issues?: readonly unknown[] } | Promise<unknown>;
  };
};

/** Does the op's declared INPUT schema accept this body? */
function accepts(op: unknown, input: unknown): boolean {
  const schema = (op as { "~orpc": { inputSchema?: Validator } })["~orpc"].inputSchema;

  assert.ok(schema, "the op declares an input schema");

  const result = schema["~standard"].validate(input);

  assert.ok(!(result instanceof Promise), "validation is synchronous");

  return result.issues === undefined;
}

// ── Discogs box evidence: explicit, bounded, and identity-keyed at the edge ───────────────
{
  const release = (id: number) => ({
    artists: [{ name: "Calibre" }],
    formats: [{ name: "Vinyl" }],
    id,
    labels: [{ catno: "SIG001", name: "Signature" }],
    styles: ["Drum n Bass"],
    title: "Release",
    tracklist: [{ title: "Track" }],
    year: 2026,
  });
  const grouped = (trackId: string, releaseCount = 0) => ({
    releases: Array.from({ length: releaseCount }, (_, index) => release(index + 1)),
    trackId,
  });
  const discogsInput = (discogsCandidates: unknown[]) => ({
    body: { discogsCandidates },
    query: { boxFetch: "true" },
  });

  assert.equal(
    accepts(backfillDiscogs, discogsInput([grouped("trk_empty")])),
    true,
    "an explicit empty release group is the box's clean no-hit verdict",
  );
  assert.equal(
    accepts(
      backfillDiscogs,
      discogsInput(
        Array.from({ length: DISCOGS_RELEASE_WORK_LIMIT }, (_, index) =>
          grouped(`trk_${index}`, DISCOGS_RELEASES_PER_TRACK_LIMIT),
        ),
      ),
    ),
    true,
    "release groups at both work and per-track caps are accepted",
  );
  assert.equal(
    accepts(
      backfillDiscogs,
      discogsInput(
        Array.from({ length: DISCOGS_RELEASE_WORK_LIMIT + 1 }, (_, index) =>
          grouped(`trk_${index}`),
        ),
      ),
    ),
    false,
    "one release work group past the cap is rejected",
  );
  assert.equal(
    accepts(
      backfillDiscogs,
      discogsInput([grouped("trk_over", DISCOGS_RELEASES_PER_TRACK_LIMIT + 1)]),
    ),
    false,
    "one release past a track's candidate cap is rejected",
  );
  assert.equal(
    accepts(backfillDiscogs, discogsInput([grouped("trk_duplicate"), grouped("trk_duplicate")])),
    false,
    "duplicate track groups cannot make an empty result ambiguous",
  );
  assert.equal(
    accepts(backfillDiscogs, discogsInput([{ releases: [release(0)], trackId: "trk_bad" }])),
    false,
    "a non-positive Discogs id is rejected before the scorer",
  );

  const factsCandidate = (index: number) => ({
    release: release(index + 1),
    slug: `album-${index}`,
  });
  assert.equal(
    accepts(backfillDiscogsFacts, {
      body: {
        discogsCandidates: Array.from({ length: DISCOGS_FACTS_WORK_LIMIT }, (_, index) =>
          factsCandidate(index),
        ),
      },
      query: { boxFetch: "true" },
    }),
    true,
    "facts evidence at the worklist cap is accepted",
  );
  assert.equal(
    accepts(backfillDiscogsFacts, {
      body: {
        discogsCandidates: Array.from({ length: DISCOGS_FACTS_WORK_LIMIT + 1 }, (_, index) =>
          factsCandidate(index),
        ),
      },
      query: { boxFetch: "true" },
    }),
    false,
    "one facts candidate past the cap is rejected",
  );

  const labelCandidate = (index: number) => ({
    detail: { id: index + 1, images: [] },
    discogsLabelId: index + 1,
    slug: `label-${index}`,
  });
  assert.equal(
    accepts(backfillLabelImages, {
      body: {
        discogsCandidates: Array.from({ length: DISCOGS_LABEL_WORK_LIMIT }, (_, index) =>
          labelCandidate(index),
        ),
      },
      query: { boxFetch: "true" },
    }),
    true,
    "label evidence at the batch cap is accepted",
  );
  assert.equal(
    accepts(backfillLabelImages, {
      body: {
        discogsCandidates: [{ ...labelCandidate(0), detail: { id: 2, images: [] } }],
      },
      query: { boxFetch: "true" },
    }),
    false,
    "cross-wired label detail is rejected before the Worker ladder",
  );
  assert.equal(
    accepts(backfillLabelImages, {
      body: {
        discogsCandidates: [
          {
            ...labelCandidate(0),
            image: { bytesBase64: "AQID", mime: "text/html", uri: "https://example.test/a" },
          },
        ],
      },
      query: { boxFetch: "true" },
    }),
    false,
    "a non-image MIME type is rejected at the contract boundary",
  );
}

// ── update_artist_rule: at least one drift-audit stamp, including explicit nulls ─────────
{
  assert.equal(
    accepts(updateArtistRule, { id: "arl_test" }),
    false,
    "an empty drift-audit PATCH is rejected",
  );
  assert.equal(
    accepts(updateArtistRule, { id: "arl_test", resolvedMbid: null }),
    true,
    "an explicit null clears a drift-audit value and satisfies the at-least-one rule",
  );
  assert.equal(
    accepts(updateArtistRule, { checkedAt: "2026-08-02T12:34:56.000Z", id: "arl_test" }),
    true,
    "a checkedAt-only sweep stamp is accepted",
  );
}

// ── replace_label_artist_rules: a bounded, duplicate-free whole-set swap ────────────────
{
  const rule = (index: number) => ({
    artistMbid: `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
    artistName: `Artist ${index}`,
    verdict: "allow" as const,
  });

  assert.equal(
    accepts(replaceLabelArtistRules, {
      id: "lbl_test",
      rules: Array.from({ length: 100 }, (_, index) => rule(index)),
    }),
    true,
    "a label rule set AT the cap is accepted",
  );
  assert.equal(
    accepts(replaceLabelArtistRules, {
      id: "lbl_test",
      rules: Array.from({ length: 101 }, (_, index) => rule(index)),
    }),
    false,
    "one artist rule past the cap is rejected",
  );
  assert.equal(
    accepts(replaceLabelArtistRules, { id: "lbl_test", rules: [rule(1), rule(1)] }),
    false,
    "a duplicate artist MBID is rejected before the transaction",
  );
  assert.equal(
    accepts(replaceLabelArtistRules, {
      id: "lbl_test",
      rules: [{ ...rule(1), artistName: " " }],
    }),
    false,
    "a bare MBID without a display name is rejected",
  );
}

// ── record_cost: at most 500 rows per batch (the widest sweep queue is 50) ────────────────
{
  const event = (index: number) => ({
    costBasis: "cash" as const,
    id: `evt-${index}`,
    occurredAt: "2026-07-26T00:00:00.000Z",
    quantity: 1,
    source: "measured" as const,
    step: "embed" as const,
    unitType: "seconds" as const,
    vendor: "self" as const,
  });

  assert.equal(accepts(recordCost, [event(0)]), true, "a one-row batch is the common case");
  assert.equal(
    accepts(
      recordCost,
      Array.from({ length: 500 }, (_, i) => event(i)),
    ),
    true,
    "a batch AT the cap is accepted",
  );
  assert.equal(
    accepts(
      recordCost,
      Array.from({ length: 501 }, (_, i) => event(i)),
    ),
    false,
    "one row past the cap is rejected",
  );
}

// ── update_galaxy_map: at most 64 clusters, each centroid at most 2048 floats ─────────────
{
  const cluster = (dimensions = 1024) => ({
    centroid: Array.from({ length: dimensions }, () => 0.1),
    id: null,
  });

  // k = 9 today; the live shape must stay comfortably inside both caps.
  assert.equal(
    accepts(updateGalaxyMap, { clusters: Array.from({ length: 9 }, () => cluster()) }),
    true,
    "the live k=9 map with 1024-dim centroids is accepted",
  );
  assert.equal(
    accepts(updateGalaxyMap, { clusters: Array.from({ length: 64 }, () => cluster(8)) }),
    true,
    "a map AT the cluster cap is accepted",
  );
  assert.equal(
    accepts(updateGalaxyMap, { clusters: Array.from({ length: 65 }, () => cluster(8)) }),
    false,
    "one cluster past the cap is rejected",
  );
  assert.equal(
    accepts(updateGalaxyMap, { clusters: [cluster(2048)] }),
    true,
    "a centroid AT the dimension cap is accepted",
  );
  assert.equal(
    accepts(updateGalaxyMap, { clusters: [cluster(2049)] }),
    false,
    "one dimension past the cap is rejected",
  );
}

// ── resolve_anchor: the box-fetched Deezer hits, bounded on every axis ─────────────────────
//
// This one is not merely a batch cap. The whole point of moving the Deezer FETCH to the box is that
// the box is a source we deliberately do NOT trust — the Worker re-verifies every hit before an ISRC
// is written. An untrusted source's payload is exactly the thing to bound at the edge, so a malformed
// one fails as a clean 400 instead of reaching the handler at all.
{
  const hit = (over: Record<string, unknown> = {}) => ({
    artistName: "Muffler",
    durationMs: 201_000,
    isrc: "GBTESTDZ0001",
    title: "Dribble",
    ...over,
  });

  assert.equal(
    accepts(resolveAnchor, { trackId: "mb_1" }),
    true,
    "no hits at all is the pre-box shape: the Worker searches Deezer itself",
  );
  assert.equal(
    accepts(resolveAnchor, { deezerCandidates: [], trackId: "mb_1" }),
    true,
    "an EMPTY list is a first-class answer — the box searched and found nothing",
  );

  // The array cap IS Deezer's page size: more hits than Deezer itself pages is already wrong.
  assert.equal(
    accepts(resolveAnchor, {
      deezerCandidates: Array.from({ length: DEEZER_CANDIDATE_LIMIT }, () => hit()),
      trackId: "mb_1",
    }),
    true,
    "a payload AT the cap is accepted",
  );
  assert.equal(
    accepts(resolveAnchor, {
      deezerCandidates: Array.from({ length: DEEZER_CANDIDATE_LIMIT + 1 }, () => hit()),
      trackId: "mb_1",
    }),
    false,
    "one hit past the cap is rejected",
  );

  // The three strings are bounded, generously — a cap that bit a real billing or title would turn a
  // recoverable row into a rejected call, which is the worse failure.
  assert.equal(
    accepts(resolveAnchor, {
      deezerCandidates: [hit({ artistName: "a".repeat(300), title: "b".repeat(300) })],
      trackId: "mb_1",
    }),
    true,
    "strings AT the length cap are accepted",
  );
  assert.equal(
    accepts(resolveAnchor, {
      deezerCandidates: [hit({ artistName: "a".repeat(301) })],
      trackId: "mb_1",
    }),
    false,
    "an oversized artistName is rejected",
  );
  assert.equal(
    accepts(resolveAnchor, {
      deezerCandidates: [hit({ title: "b".repeat(301) })],
      trackId: "mb_1",
    }),
    false,
    "an oversized title is rejected",
  );
  assert.equal(
    accepts(resolveAnchor, { deezerCandidates: [hit({ isrc: "c".repeat(65) })], trackId: "mb_1" }),
    false,
    "an oversized isrc is rejected",
  );

  // A duration that is not a recording length. The gate would read each of these as a plain miss —
  // indistinguishable from an honest one — so the boundary names it instead.
  for (const durationMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(
      accepts(resolveAnchor, { deezerCandidates: [hit({ durationMs })], trackId: "mb_1" }),
      false,
      `a durationMs of ${String(durationMs)} is rejected`,
    );
  }

  // …and the fields are still REQUIRED: a hit missing one cannot be verified against the row.
  assert.equal(
    accepts(resolveAnchor, { deezerCandidates: [{ isrc: "GBTESTDZ0001" }], trackId: "mb_1" }),
    false,
    "a hit missing the gate's signals is rejected",
  );
}

// ── anchor_track: the box's Apify hits, bounded on every axis ─────────────────────────────
//
// The Spotify twin of `resolve_anchor` above, and its stated precedent — same untrusted-box posture,
// so the same bounds. The sweep sends 3 candidates per row (`SEARCH_KEYWORD_LIMIT`, anchor-sweep.ts)
// and at most 45 in the pathological same-query chunk, so the caps sit far above every real tick.
// `artists` is the one that is not merely a size: a verified candidate's artist list is WRITTEN into
// the artist graph by stable id, so an unbounded one is a write amplifier.
{
  const hit = (over: Record<string, unknown> = {}) => ({
    artists: [{ id: "0TnOYISbd1XYRBk9myaseg", name: "Muffler" }],
    durationMs: 201_000,
    isrc: "GBTESTDZ0001",
    spotifyTrackId: "0TnOYISbd1XYRBk9myasez",
    title: "Dribble",
    ...over,
  });

  assert.equal(
    accepts(anchorTrack, { trackId: "trk_1" }),
    true,
    "no candidates at all is the clean-miss shape the sweep POSTs on a blackout",
  );
  assert.equal(
    accepts(anchorTrack, { candidates: [], trackId: "trk_1" }),
    true,
    "an EMPTY list is a first-class answer — the actor ran and found nothing",
  );
  assert.equal(
    accepts(anchorTrack, {
      candidates: Array.from({ length: ANCHOR_CANDIDATE_LIMIT }, () => hit()),
      trackId: "trk_1",
    }),
    true,
    "a payload AT the candidate cap is accepted",
  );
  assert.equal(
    accepts(anchorTrack, {
      candidates: Array.from({ length: ANCHOR_CANDIDATE_LIMIT + 1 }, () => hit()),
      trackId: "trk_1",
    }),
    false,
    "one candidate past the cap is rejected",
  );

  // The artist list — the axis that reaches the graph.
  assert.equal(
    accepts(anchorTrack, {
      candidates: [hit({ artists: Array.from({ length: 20 }, () => ({ name: "Artist" })) })],
      trackId: "trk_1",
    }),
    true,
    "an artist list AT the cap is accepted",
  );
  assert.equal(
    accepts(anchorTrack, {
      candidates: [hit({ artists: Array.from({ length: 21 }, () => ({ name: "Artist" })) })],
      trackId: "trk_1",
    }),
    false,
    "one artist past the cap is rejected",
  );

  // The strings, generous enough that a real remix title or billing can never trip them.
  assert.equal(
    accepts(anchorTrack, {
      candidates: [hit({ artists: [{ name: "a".repeat(300) }], title: "b".repeat(300) })],
      trackId: "trk_1",
    }),
    true,
    "strings AT the text cap are accepted",
  );
  assert.equal(
    accepts(anchorTrack, { candidates: [hit({ title: "b".repeat(301) })], trackId: "trk_1" }),
    false,
    "an oversized title is rejected",
  );
  assert.equal(
    accepts(anchorTrack, {
      candidates: [hit({ artists: [{ name: "a".repeat(301) }] })],
      trackId: "trk_1",
    }),
    false,
    "an oversized artist name is rejected",
  );
  assert.equal(
    accepts(anchorTrack, { candidates: [hit({ isrc: "c".repeat(65) })], trackId: "trk_1" }),
    false,
    "an oversized isrc is rejected",
  );
  assert.equal(
    accepts(anchorTrack, {
      candidates: [hit({ spotifyTrackId: "d".repeat(65) })],
      trackId: "trk_1",
    }),
    false,
    "an oversized spotifyTrackId is rejected",
  );
  assert.equal(
    accepts(anchorTrack, {
      candidates: [
        hit({
          spotifyTrackId: undefined,
          url: `https://open.spotify.com/track/${"e".repeat(2048)}`,
        }),
      ],
      trackId: "trk_1",
    }),
    false,
    "an oversized url is rejected",
  );

  // …and the id-carrier rule still stands: a candidate the server cannot anchor to is refused.
  assert.equal(
    accepts(anchorTrack, {
      candidates: [{ artists: [], durationMs: 201_000, isrc: "GBTESTDZ0001", title: "Dribble" }],
      trackId: "trk_1",
    }),
    false,
    "a candidate carrying no id, uri, or url is rejected",
  );
}

// ── record_run: the run ledger's envelope, bounded and CLOSED ─────────────────────────────
//
// This one is not a batch cap. The envelope is assembled by a POSIX shell function on a box, so
// the realistic threat is a buggy or skewed emitter, not a stranger — and the load-bearing property
// is that the object is STRICT. A version skew between the wrapper and the Worker must degrade
// LOUDLY (a 400, which leaves the row missing, which the absence alarm catches) rather than quietly
// widening into a field nobody validated. Two keys can never appear: `ok`, because the ledger
// derives it and a sweep asserting its own health is the defect that motivated the whole design,
// and `id`, because it is derived from `unit` + `started_at`.
//
// MIND THE LAYER. That prohibition is on the ENVELOPE only. An `ok` INSIDE `summary_raw` is a
// string this schema does not read, and it must stay accepted: 25 sweep scripts print one, so
// rejecting it here would have left exactly those sweeps rowless — a missing row reads as a dead
// sweep, and the founding case would have been the one case the ledger could not see. The Worker
// records that claim in `self_asserted_ok` and overrules it (lib/server/run-events.ts, rule 1).
{
  const run = (over: Record<string, unknown> = {}) => ({
    ended_at: "2026-07-29T03:00:12.500Z",
    exit_code: 0,
    started_at: "2026-07-29T03:00:00.000Z",
    summary_raw: '{"produced":4}',
    unit: "fluncle-enrich",
    ...over,
  });

  assert.equal(accepts(recordRun, run()), true, "the live envelope shape is accepted");
  assert.equal(
    accepts(recordRun, run({ summary_raw: undefined })),
    true,
    "a sweep that printed no summary is still recordable",
  );
  assert.equal(
    accepts(recordRun, run({ summary_raw: null })),
    true,
    "an explicitly null summary is still recordable",
  );
  assert.equal(
    accepts(recordRun, run({ attempt_count: null, batch_count: null })),
    true,
    "unknown database counts stay explicitly nullable",
  );
  assert.equal(
    accepts(recordRun, run({ release: "emitter-build_abc.123" })),
    true,
    "a bounded public emitter release is accepted",
  );
  assert.equal(
    accepts(recordRun, run({ release: null })),
    true,
    "an unknown emitter release stays nullable on input",
  );
  for (const release of ["contains/slash", "space separated", "a".repeat(65)]) {
    assert.equal(
      accepts(recordRun, run({ release })),
      false,
      "an unsafe or oversized emitter release is rejected",
    );
  }
  assert.equal(
    accepts(
      recordRun,
      run({ attempt_count: MAX_RUN_DATABASE_COUNT, batch_count: MAX_RUN_DATABASE_COUNT }),
    ),
    true,
    "database counts at the defensive cap are accepted",
  );
  for (const field of ["attempt_count", "batch_count"]) {
    assert.equal(
      accepts(recordRun, run({ [field]: MAX_RUN_DATABASE_COUNT + 1 })),
      false,
      `${field} above the cap is rejected`,
    );
    assert.equal(accepts(recordRun, run({ [field]: -1 })), false, `${field} cannot be negative`);
    assert.equal(accepts(recordRun, run({ [field]: 1.5 })), false, `${field} must be integral`);
  }

  // The real nightly Sentry sweep line (sentry-triage-sweep.ts:489) — a summary carrying its
  // own `ok`. It MUST reach the Worker, which records the claim rather than obeying it.
  assert.equal(
    accepts(recordRun, run({ summary_raw: '{"candidates":3,"ok":true,"resolved":3}' })),
    true,
    "a summary carrying its own `ok` is accepted — the claim is recorded, not rejected",
  );

  // STRICT: an unknown envelope key is rejected, never ignored.
  assert.equal(
    accepts(recordRun, run({ ok: true })),
    false,
    "a caller-supplied `ok` is rejected at the envelope",
  );
  assert.equal(
    accepts(recordRun, run({ id: "fluncle-enrich:2026-07-29T03:00:00.000Z" })),
    false,
    "a caller-supplied id is rejected — the Worker derives it",
  );
  assert.equal(
    accepts(recordRun, run({ hostname: "some-box" })),
    false,
    "an unrecognised envelope key is rejected rather than silently widening the contract",
  );
  for (const derived of ["access_class", "operation_id", "outcome"]) {
    assert.equal(
      accepts(recordRun, run({ [derived]: "caller-value" })),
      false,
      `${derived} is server-derived and rejected from the envelope`,
    );
  }

  // Every field is REQUIRED: a run with no unit, no start, or no exit code is not a run.
  for (const key of ["ended_at", "exit_code", "started_at", "unit"]) {
    const partial: Record<string, unknown> = run();

    delete partial[key];

    assert.equal(accepts(recordRun, partial), false, `an envelope missing ${key} is rejected`);
  }

  // The bounds. `exit_code` is bash `$?`, definitionally 0–255.
  assert.equal(accepts(recordRun, run({ exit_code: 255 })), true, "exit code AT the cap");
  assert.equal(accepts(recordRun, run({ exit_code: 256 })), false, "an out-of-range exit code");
  assert.equal(accepts(recordRun, run({ exit_code: -1 })), false, "a negative exit code");
  assert.equal(accepts(recordRun, run({ exit_code: 1.5 })), false, "a fractional exit code");
  assert.equal(accepts(recordRun, run({ unit: "" })), false, "an empty unit name");
  assert.equal(accepts(recordRun, run({ unit: "u".repeat(128) })), true, "a unit name AT the cap");
  assert.equal(
    accepts(recordRun, run({ unit: "u".repeat(129) })),
    false,
    "one character past the unit cap",
  );
  assert.equal(accepts(recordRun, run({ started_at: "" })), false, "an empty start time");
  assert.equal(
    accepts(recordRun, run({ started_at: "t".repeat(65) })),
    false,
    "an oversized timestamp",
  );

  // The summary is REJECTED past the cap, never truncated: a silently-trimmed summary is a
  // summary you cannot trust, and an untrustworthy diagnostic is what this ledger exists to end.
  assert.equal(
    accepts(recordRun, run({ summary_raw: "s".repeat(MAX_SUMMARY_RAW_CHARS) })),
    true,
    "a summary AT the cap is accepted",
  );
  assert.equal(
    accepts(recordRun, run({ summary_raw: "s".repeat(MAX_SUMMARY_RAW_CHARS + 1) })),
    false,
    "one character past the summary cap is rejected",
  );
}

// ── read_run_ledger: one bounded page, with closed boolean/time filters ──────────────────
{
  assert.equal(
    accepts(readRunLedger, { limit: MAX_RUN_LEDGER_PAGE_SIZE }),
    true,
    "a run-ledger page AT the cap is accepted",
  );
  assert.equal(
    accepts(readRunLedger, { limit: MAX_RUN_LEDGER_PAGE_SIZE + 1 }),
    false,
    "one row past the run-ledger page cap is rejected",
  );
  assert.equal(
    accepts(readRunLedger, { ok: "false", since: "2026-07-30T19:00:00.000Z" }),
    true,
    "the derived-ok and ISO time filters are accepted",
  );
  assert.equal(
    accepts(readRunLedger, {
      blind: "true",
      liar: "false",
      missingField: "queue_depth",
      since: "90m",
    }),
    true,
    "stored evidence filters and a relative lookback are accepted",
  );
  assert.equal(
    accepts(readRunLedger, { missing: "true", since: "24h", unit: "fluncle-enrich" }),
    true,
    "the roster-absence view accepts relative time and unit scope",
  );
  assert.equal(
    accepts(readRunLedger, { missing: "true", ok: "false" }),
    false,
    "the roster-absence view rejects stored-row evidence filters",
  );
  assert.equal(
    accepts(readRunLedger, { ok: "yes" }),
    false,
    "the derived-ok filter is a closed true/false string",
  );
  for (const since of ["0h", "1.5h", "24H", "60s", "-1h", "3651d"]) {
    assert.equal(
      accepts(readRunLedger, { since }),
      false,
      `the invalid relative lookback ${since} is rejected`,
    );
  }
  assert.equal(
    accepts(readRunLedger, {
      since: "2026-07-30T20:00:00.000Z",
      until: "2026-07-30T19:00:00.000Z",
    }),
    false,
    "an inverted time window is rejected",
  );
}

// ── the R2 presign ops: a world-served object's Content-Type is bounded to video/* ────────
//
// These three sign an upload into `fluncle-videos`, which is served world-readable at
// found.fluncle.com, and the requested type becomes the stored object's Content-Type — so it
// is what the CDN serves those bytes as. The bound is a value restriction rather than a batch
// cap: `text/html` on a Fluncle origin is the thing it exists to refuse. Every real caller is
// asserted accepted below, so the gate cannot bite a legitimate upload.
{
  const presigns = [
    { input: (contentType: unknown) => ({ clipId: "clp_1", contentType }), op: presignClipUpload },
    {
      input: (contentType: unknown) => ({ contentType, mixtapeId: "mx_1", partCount: 1 }),
      op: presignSetVideoUpload,
    },
    {
      input: (contentType: unknown) => ({ contentType, partCount: 1, recordingId: "rec_1" }),
      op: presignRecordingUpload,
    },
  ];

  for (const { input, op } of presigns) {
    const id = (op as { "~orpc": { route: { operationId: string } } })["~orpc"].route.operationId;

    // Omitted entirely is the set-video CLI's shape — the handler then defaults to video/mp4.
    assert.equal(accepts(op, input(undefined)), true, `${id}: an absent contentType is accepted`);

    // The values the real callers send: the CLI legs' literal, and the `accept="video/*"`
    // recording dialog passing `file.type` through for a .mov / .webm / .mkv pick.
    for (const contentType of ["video/mp4", "video/quicktime", "video/webm", "video/x-matroska"]) {
      assert.equal(accepts(op, input(contentType)), true, `${id}: ${contentType} is accepted`);
    }

    // A type that would make the CDN serve an uploaded object as something other than video.
    for (const contentType of ["text/html", "image/svg+xml", "application/javascript"]) {
      assert.equal(accepts(op, input(contentType)), false, `${id}: ${contentType} is rejected`);
    }

    // Neither a non-string nor an unbounded string can reach the signer any more.
    assert.equal(accepts(op, input(123)), false, `${id}: a non-string contentType is rejected`);
    assert.equal(
      accepts(op, input(`video/${"x".repeat(122)}`)),
      true,
      `${id}: a subtype AT the length cap is accepted`,
    );
    assert.equal(
      accepts(op, input(`video/${"x".repeat(123)}`)),
      false,
      `${id}: one character past the length cap is rejected`,
    );
  }
}

console.log("input-caps: ok");
