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
import {
  HEALTH_SNAPSHOT_CHECKS_MAX,
  HEALTH_SNAPSHOT_SERVICE_MAX,
  recordHealth,
} from "./admin-health";
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
import {
  getOperationReceipt,
  OPERATION_RECEIPT_KEY_MAX,
  OPERATION_RECEIPT_REPAIR_LIMIT_MAX,
  reconcileOperationReceipts,
  resolveOperationReceipt,
} from "./admin-operation-receipts";

type Validator = {
  "~standard": {
    validate: (input: unknown) => { issues?: readonly unknown[] } | Promise<unknown>;
  };
};

function accepts(op: unknown, input: unknown): boolean {
  const schema = (op as { "~orpc": { inputSchema?: Validator } })["~orpc"].inputSchema;

  assert.ok(schema, "the op declares an input schema");

  const result = schema["~standard"].validate(input);

  assert.ok(!(result instanceof Promise), "validation is synchronous");

  return result.issues === undefined;
}

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

{
  const cluster = (dimensions = 1024) => ({
    centroid: Array.from({ length: dimensions }, () => 0.1),
    id: null,
  });

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

  for (const durationMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(
      accepts(resolveAnchor, { deezerCandidates: [hit({ durationMs })], trackId: "mb_1" }),
      false,
      `a durationMs of ${String(durationMs)} is rejected`,
    );
  }

  assert.equal(
    accepts(resolveAnchor, { deezerCandidates: [{ isrc: "GBTESTDZ0001" }], trackId: "mb_1" }),
    false,
    "a hit missing the gate's signals is rejected",
  );
}

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

  assert.equal(
    accepts(anchorTrack, {
      candidates: [{ artists: [], durationMs: 201_000, isrc: "GBTESTDZ0001", title: "Dribble" }],
      trackId: "trk_1",
    }),
    false,
    "a candidate carrying no id, uri, or url is rejected",
  );
}

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

  assert.equal(
    accepts(recordRun, run({ summary_raw: '{"candidates":3,"ok":true,"resolved":3}' })),
    true,
    "a summary carrying its own `ok` is accepted — the claim is recorded, not rejected",
  );

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

  for (const key of ["ended_at", "exit_code", "started_at", "unit"]) {
    const partial: Record<string, unknown> = run();

    delete partial[key];

    assert.equal(accepts(recordRun, partial), false, `an envelope missing ${key} is rejected`);
  }

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

{
  assert.equal(
    accepts(getOperationReceipt, { operationKey: "k".repeat(OPERATION_RECEIPT_KEY_MAX) }),
    true,
    "an operation key at the storage cap is accepted",
  );
  assert.equal(
    accepts(getOperationReceipt, { operationKey: "k".repeat(OPERATION_RECEIPT_KEY_MAX + 1) }),
    false,
    "an operation key past the storage cap is rejected",
  );
  assert.equal(
    accepts(getOperationReceipt, {
      operationKey: "health.snapshot:one",
    }),
    true,
    "inspection accepts only the bounded operation key",
  );
  assert.equal(
    accepts(resolveOperationReceipt, {
      operationId: "health.snapshot",
      operationKey: "health.snapshot:one",
      requestDigest: "a".repeat(64),
    }),
    true,
    "a complete digest-bound POST reconciliation request is accepted",
  );
  assert.equal(
    accepts(getOperationReceipt, { operationKey: "é".repeat(128) }),
    false,
    "a non-ASCII operation key is rejected even when its character count is within the cap",
  );
  assert.equal(
    accepts(reconcileOperationReceipts, {
      limit: OPERATION_RECEIPT_REPAIR_LIMIT_MAX,
      staleBefore: "2026-08-26T10:00:00.000Z",
    }),
    true,
    "a stale receipt repair at the page cap is accepted",
  );
  assert.equal(
    accepts(reconcileOperationReceipts, {
      limit: OPERATION_RECEIPT_REPAIR_LIMIT_MAX + 1,
      staleBefore: "2026-08-26T10:00:00.000Z",
    }),
    false,
    "a stale receipt repair past the page cap is rejected",
  );
  assert.equal(
    accepts(reconcileOperationReceipts, { limit: 1, staleBefore: "2026-08-26T10:00:00" }),
    false,
    "a stale receipt repair requires an explicit timestamp offset",
  );
  const health = {
    at: "2026-08-26T10:00:00.000Z",
    checks: [],
    operationKey: "health.snapshot:test:2026-08-26T10:00:00.000Z",
    producer: "test",
    requestDigest: "a".repeat(64),
  };
  assert.equal(accepts(recordHealth, health), true, "complete health receipt metadata is accepted");
  assert.equal(
    accepts(recordHealth, {
      at: health.at,
      checks: health.checks,
      operationKey: health.operationKey,
    }),
    true,
    "the initialization-era operation key remains accepted until contraction",
  );
  assert.equal(
    accepts(recordHealth, {
      at: health.at,
      checks: health.checks,
      producer: health.producer,
    }),
    false,
    "partial receipt metadata without the compatibility key is rejected",
  );
  assert.equal(
    accepts(recordHealth, {
      at: health.at,
      checks: health.checks,
      operationKey: health.operationKey,
      producer: health.producer,
    }),
    false,
    "partial receipt metadata beyond the compatibility shape is rejected",
  );
  assert.equal(
    accepts(recordHealth, { ...health, operationKey: "é".repeat(100) }),
    false,
    "health rejects a non-ASCII operation key within the character cap",
  );
}

{
  const snapshot = (checks: unknown) => ({ at: "2026-08-26T10:00:00.000Z", checks });
  const check = (service: string) => ({
    latencyMs: null,
    message: null,
    service,
    status: "ok",
    transitioned: false,
  });

  assert.equal(
    accepts(
      recordHealth,
      snapshot(Array.from({ length: HEALTH_SNAPSHOT_CHECKS_MAX }, (_, i) => check(`cron.s${i}`))),
    ),
    true,
    "a snapshot at the checks cap is accepted",
  );
  assert.equal(
    accepts(
      recordHealth,
      snapshot(
        Array.from({ length: HEALTH_SNAPSHOT_CHECKS_MAX + 1 }, (_, i) => check(`cron.s${i}`)),
      ),
    ),
    false,
    "a snapshot past the checks cap is rejected",
  );

  assert.equal(
    accepts(recordHealth, snapshot(Array.from({ length: 55 }, (_, i) => check(`cron.s${i}`)))),
    true,
    "the real prober's snapshot size is accepted",
  );
  assert.equal(
    accepts(recordHealth, snapshot([check("cron.projection-maintenance")])),
    true,
    "the longest real service name is accepted",
  );
  assert.equal(
    accepts(recordHealth, snapshot([check("s".repeat(HEALTH_SNAPSHOT_SERVICE_MAX))])),
    true,
    "a service name at the identifier cap is accepted",
  );
  assert.equal(
    accepts(recordHealth, snapshot([check("s".repeat(HEALTH_SNAPSHOT_SERVICE_MAX + 1))])),
    false,
    "a service name past the identifier cap is rejected",
  );
  assert.equal(
    accepts(recordHealth, snapshot([check("")])),
    false,
    "an empty service name is rejected",
  );
}

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

    assert.equal(accepts(op, input(undefined)), true, `${id}: an absent contentType is accepted`);

    for (const contentType of ["video/mp4", "video/quicktime", "video/webm", "video/x-matroska"]) {
      assert.equal(accepts(op, input(contentType)), true, `${id}: ${contentType} is accepted`);
    }

    for (const contentType of ["text/html", "image/svg+xml", "application/javascript"]) {
      assert.equal(accepts(op, input(contentType)), false, `${id}: ${contentType} is rejected`);
    }

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
