import { type Client } from "@libsql/client/web";

import { DUPLICATE_SIMILARITY, LONG_FORM_MS } from "../../src/lib/catalogue-eligibility";
import {
  FINDINGS_SLOT_COUNT,
  MAX_REC_SEEDS,
  RECOMMENDATIONS_POOL,
} from "../../src/lib/server/recommendations";
import { SONIC_NEIGHBOUR_LIMIT } from "../../src/lib/server/track-page";
import {
  executeVectorFallback,
  VECTOR_FALLBACK_CANDIDATE_LIMIT,
  VECTOR_FALLBACK_DEADLINE_MS,
  vectorFallbackCandidateLimitSql,
} from "../../src/lib/server/vector-fallback";
import { distribution } from "./budgets";
import {
  applyFixtureSchema,
  auditFixtureCardinality,
  EMBEDDING_BLOB,
  writeFixture,
} from "./fixture";
import { startLocalLibsqlSidecar } from "./local-sidecar";
import { getScaleManifest, isScaleProfile, type ScaleProfile } from "./manifest";

const WARMUP_ITERATIONS = 2;
const SAMPLE_COUNT = 10;
const LOG_RESULT_LIMIT = 6;
const SEARCH_RESULT_LIMIT = 12;

type Consumer = {
  name: "log" | "recommendations" | "sonic-search" | "track-page";
  operationIds: string[];
  run: (client: Client) => Promise<number>;
};

const searchStatement = {
  args: [EMBEDDING_BLOB, SEARCH_RESULT_LIMIT],
  sql: `with candidates(track_id) as materialized (
          select perf_tracks.id
          from perf_tracks
          join perf_track_embeddings emb on emb.track_id = perf_tracks.id
          where perf_tracks.has_embedding = 1
          order by perf_tracks.id
          ${vectorFallbackCandidateLimitSql()}
        ), winners(track_id, dist) as materialized (
          select candidates.track_id, vector_distance_cos(emb.embedding_blob, ?) as dist
          from candidates
          join perf_track_embeddings emb on emb.track_id = candidates.track_id
          order by dist asc, candidates.track_id asc
          limit ?
        )
        select winners.track_id, perf_tracks.title, perf_tracks.artists_json, perf_tracks.album,
               perf_tracks.album_image_url, perf_tracks.bpm, perf_tracks.key, perf_tracks.label,
               perf_tracks.release_date, perf_tracks.spotify_url, perf_findings.log_id,
               (select name from perf_galaxies
                where perf_galaxies.id = perf_findings.galaxy_id) as galaxy_name
        from winners
        cross join perf_tracks on perf_tracks.id = winners.track_id
        left join perf_findings on perf_findings.track_id = perf_tracks.id
        order by winners.dist asc, winners.track_id asc`,
};

const trackPageStatement = {
  args: ["synthetic-track-000000000", 160, 188, EMBEDDING_BLOB, SONIC_NEIGHBOUR_LIMIT],
  sql: `with candidates(track_id) as materialized (
          select perf_tracks.id
          from perf_tracks indexed by perf_tracks_bpm_idx
          join perf_track_embeddings emb on emb.track_id = perf_tracks.id
          where perf_tracks.id != ?
            and trim(perf_tracks.title) <> ''
            and trim(perf_tracks.artists_json) not in ('', '[]')
            and perf_tracks.dismissed_at is null
            and perf_tracks.duplicate_of_track_id is null
            and perf_tracks.bpm between ? and ?
          order by perf_tracks.id
          ${vectorFallbackCandidateLimitSql()}
        ), winners(track_id, dist) as materialized (
          select candidates.track_id, vector_distance_cos(emb.embedding_blob, ?) as dist
          from candidates
          join perf_track_embeddings emb on emb.track_id = candidates.track_id
          order by dist asc, candidates.track_id asc
          limit ?
        )
        select winners.track_id, perf_tracks.title, perf_tracks.artists_json,
               perf_tracks.album_image_url,
               (select image_key from perf_albums
                where perf_albums.id = perf_tracks.album_id) as album_image_key,
               (select image_state from perf_albums
                where perf_albums.id = perf_tracks.album_id) as album_image_state,
               (select image_updated_at from perf_albums
                where perf_albums.id = perf_tracks.album_id) as album_image_updated_at,
               perf_findings.log_id
        from winners
        cross join perf_tracks on perf_tracks.id = winners.track_id
        left join perf_findings on perf_findings.track_id = perf_tracks.id
        order by winners.dist asc, winners.track_id asc`,
};

const logStatement = {
  args: ["synthetic-track-000000000", EMBEDDING_BLOB, LOG_RESULT_LIMIT],
  sql: `with candidates(track_id) as materialized (
          select perf_tracks.id
          from perf_findings
          cross join perf_tracks on perf_tracks.id = perf_findings.track_id
          cross join perf_track_embeddings emb on emb.track_id = perf_tracks.id
          where perf_findings.log_id is not null and perf_tracks.id != ?
          order by perf_tracks.id
          ${vectorFallbackCandidateLimitSql()}
        ), winners(track_id, dist) as materialized (
          select candidates.track_id, vector_distance_cos(emb.embedding_blob, ?) as dist
          from candidates
          join perf_track_embeddings emb on emb.track_id = candidates.track_id
          order by dist asc, candidates.track_id asc
          limit ?
        )
        select winners.track_id, perf_tracks.spotify_url, perf_tracks.apple_music_url,
               perf_tracks.title, perf_tracks.album, perf_tracks.album_image_url,
               perf_tracks.artists_json, perf_tracks.analyzed_from, perf_tracks.bpm,
               perf_tracks.duration_ms, perf_tracks.in_release_id, perf_tracks.isrc,
               perf_tracks.key, perf_tracks.label, perf_tracks.mb_recording_id,
               perf_tracks.release_date, perf_tracks.source_audio_failures,
               perf_tracks.source_audio_key, perf_findings.log_id, perf_findings.added_at,
               perf_findings.updated_at, perf_findings.video_squared_at,
               (select name from perf_galaxies
                where perf_galaxies.id = perf_findings.galaxy_id) as galaxy_name,
               (select slug from perf_albums
                where perf_albums.id = perf_tracks.album_id) as album_slug,
               (select image_key from perf_albums
                where perf_albums.id = perf_tracks.album_id) as album_image_key,
               (select image_state from perf_albums
                where perf_albums.id = perf_tracks.album_id) as album_image_state,
               (select image_updated_at from perf_albums
                where perf_albums.id = perf_tracks.album_id) as album_image_updated_at
        from winners
        cross join perf_tracks on perf_tracks.id = winners.track_id
        cross join perf_findings on perf_findings.track_id = perf_tracks.id
        order by winners.dist asc, winners.track_id asc`,
};

const recommendationDistance = `min(${Array.from(
  { length: MAX_REC_SEEDS },
  () => "vector_distance_cos(emb.embedding_blob, ?)",
).join(", ")})`;
const recommendationProbeArgs = Array.from<Uint8Array>({ length: MAX_REC_SEEDS }).fill(
  EMBEDDING_BLOB,
);
const recommendationCatalogueStatement = {
  args: [...recommendationProbeArgs, RECOMMENDATIONS_POOL],
  sql: `with candidates(track_id) as materialized (
          select t.id
          from perf_tracks t
          left join perf_findings f on f.track_id = t.id
          left join perf_track_embeddings emb on emb.track_id = t.id
          where f.track_id is null
            and emb.track_id is not null
            and t.spotify_uri is not null
            and t.dismissed_at is null
            and t.duplicate_of_track_id is null
            and (t.nearest_finding_score is null or t.nearest_finding_score < ${DUPLICATE_SIMILARITY})
            and t.duration_ms < ${LONG_FORM_MS}
          order by t.id
          ${vectorFallbackCandidateLimitSql()}
        ), ranked(track_id, dist) as materialized (
          select candidates.track_id, ${recommendationDistance} as dist
          from candidates
          join perf_track_embeddings emb on emb.track_id = candidates.track_id
        )
        select track_id, dist from ranked
        where dist is not null
        order by dist asc, track_id asc
        limit ?`,
};
const recommendationFindingsStatement = {
  args: [...recommendationProbeArgs, FINDINGS_SLOT_COUNT],
  sql: `with candidates(track_id) as materialized (
          select t.id
          from perf_findings f
          cross join perf_tracks t on t.id = f.track_id
          cross join perf_track_embeddings emb on emb.track_id = t.id
          where f.log_id is not null
          order by t.id
          ${vectorFallbackCandidateLimitSql()}
        ), ranked(track_id, dist) as materialized (
          select candidates.track_id, ${recommendationDistance} as dist
          from candidates
          join perf_track_embeddings emb on emb.track_id = candidates.track_id
        )
        select track_id, dist from ranked
        where dist is not null
        order by dist asc, track_id asc
        limit ?`,
};

const consumers: Consumer[] = [
  {
    name: "track-page",
    operationIds: ["sonar.fallback.track"],
    async run(client) {
      const result = await executeVectorFallback(
        client,
        "sonar.fallback.track",
        trackPageStatement,
      );
      return result.rows.length;
    },
  },
  {
    name: "log",
    operationIds: ["sonar.fallback.log"],
    async run(client) {
      const result = await executeVectorFallback(client, "sonar.fallback.log", logStatement);
      return result.rows.length;
    },
  },
  {
    name: "sonic-search",
    operationIds: ["sonar.fallback.search"],
    async run(client) {
      const result = await executeVectorFallback(client, "sonar.fallback.search", searchStatement);
      return result.rows.length;
    },
  },
  {
    name: "recommendations",
    operationIds: [
      "sonar.fallback.recommendations-catalogue",
      "sonar.fallback.recommendations-findings",
    ],
    async run(client) {
      const [catalogue, findings] = await Promise.all([
        executeVectorFallback(
          client,
          "sonar.fallback.recommendations-catalogue",
          recommendationCatalogueStatement,
        ),
        executeVectorFallback(
          client,
          "sonar.fallback.recommendations-findings",
          recommendationFindingsStatement,
        ),
      ]);

      return catalogue.rows.length + findings.rows.length;
    },
  },
];

function profileArgument(args: string[]): ScaleProfile {
  const index = args.indexOf("--profile");
  const value = index === -1 ? undefined : args[index + 1];

  if (!value || !isScaleProfile(value) || value === "4x") {
    throw new Error("--profile must be 1x or 2x");
  }

  return value;
}

async function measure(client: Client, consumer: Consumer) {
  for (let iteration = 0; iteration < WARMUP_ITERATIONS; iteration += 1) {
    await consumer.run(client);
  }

  const durationsMs: number[] = [];
  const resultRowCounts: number[] = [];

  for (let iteration = 0; iteration < SAMPLE_COUNT; iteration += 1) {
    const startedAt = performance.now();
    const resultRowCount = await consumer.run(client);
    durationsMs.push(performance.now() - startedAt);
    resultRowCounts.push(resultRowCount);
  }

  if (resultRowCounts.some((count) => count <= 0)) {
    throw new Error(`${consumer.name} produced an empty measured result`);
  }

  return {
    consumer: consumer.name,
    durationMs: { min: Math.min(...durationsMs), ...distribution(durationsMs) },
    operationIds: consumer.operationIds,
    resultRowCounts: [...new Set(resultRowCounts)],
    sampleCount: SAMPLE_COUNT,
  };
}

async function main(): Promise<void> {
  const profile = profileArgument(process.argv.slice(2));
  const manifest = getScaleManifest(profile);
  const sidecar = await startLocalLibsqlSidecar({ cwd: process.cwd() });

  try {
    await applyFixtureSchema(sidecar.client);
    await writeFixture(sidecar.client, profile, { counts: manifest.counts });
    const census = await auditFixtureCardinality(sidecar.client, manifest.counts);

    if (!census.passed) {
      throw new Error(`fixture census failed: ${census.mismatches.join("; ")}`);
    }

    const measurements = [];
    for (const consumer of consumers) {
      measurements.push(await measure(sidecar.client, consumer));
    }

    process.stdout.write(
      `${JSON.stringify(
        {
          candidateLimit: VECTOR_FALLBACK_CANDIDATE_LIMIT,
          deadlineMs: VECTOR_FALLBACK_DEADLINE_MS,
          exactProfileCardinality: true,
          fixtureCounts: manifest.counts,
          measurements,
          profile,
          sampleCount: SAMPLE_COUNT,
          warmupIterations: WARMUP_ITERATIONS,
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    await sidecar.close();
  }
}

if (import.meta.main) {
  await main();
}
