import { type Client, type InStatement, type InValue } from "@libsql/client";

import {
  ARTIFACT_VECTOR_BYTES,
  artifactBytesToBase64,
  buildArtifactSnapshotStatement,
  encodeSnapshotCursor,
  snapshotMaterial,
  SONAR_TRACK_SOURCE_COLUMNS,
  type ArtifactSnapshotItem,
} from "./artifact-changes";
import { getDb, typedRows } from "./db";

const MAX_PAGE_LIMIT = 2_000;
const MAX_ITEMS_LIMIT = 200;

function assertLimit(limit: number, max: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > max) {
    throw new RangeError(`Source read limit must be between 1 and ${max}`);
  }
}

function assertIds(ids: readonly string[]): void {
  if (
    ids.length < 1 ||
    ids.length > MAX_ITEMS_LIMIT ||
    new Set(ids).size !== ids.length ||
    ids.some((id) => id.length < 1 || id.length > 1_024)
  ) {
    throw new RangeError("Source read ids must contain 1 to 200 distinct nonempty ids");
  }
}

function bytesOf(value: unknown): Uint8Array | null {
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }

  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }

  return null;
}

function validCentroid(value: unknown): Uint8Array | null {
  const bytes = bytesOf(value);

  if (bytes === null || bytes.byteLength !== ARTIFACT_VECTOR_BYTES) {
    return null;
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  for (let offset = 0; offset < bytes.byteLength; offset += 4) {
    if (!Number.isFinite(view.getFloat32(offset, true))) {
      return null;
    }
  }

  return bytes;
}

export async function sonarCentroidDigest(artistId: string, blob: Uint8Array): Promise<string> {
  const id = new TextEncoder().encode(artistId);
  const material = new Uint8Array(16 + id.byteLength + blob.byteLength);
  const view = new DataView(material.buffer);
  view.setBigUint64(0, BigInt(id.byteLength), false);
  material.set(id, 8);
  view.setBigUint64(8 + id.byteLength, BigInt(blob.byteLength), false);
  material.set(blob, 16 + id.byteLength);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", material));

  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function revisionSelect(subjectId: string): string {
  return `coalesce((select r.revision from artifact_change_revisions r
    where r.stream = 'sonar.track' and r.stream_version = 1
      and r.subject_type = 'track' and r.subject_id = ${subjectId}
    order by r.revision desc limit 1), 0)`;
}

export function buildSonarTrackDigestStatement(
  after: string | undefined,
  limit: number,
): { args: InValue[]; sql: string } {
  assertLimit(limit, 200);
  const source = buildArtifactSnapshotStatement(
    "sonar.track",
    after === undefined ? null : encodeSnapshotCursor([after]),
    limit,
  );

  return {
    args: source.args,
    sql: `select source.*, ${revisionSelect("source.track_id")} as revision from (${source.sql}) source`,
  };
}

export function buildSonarCentroidDigestStatement(
  after: string | undefined,
  limit: number,
): { args: InValue[]; sql: string } {
  assertLimit(limit, MAX_PAGE_LIMIT);

  return {
    args: after === undefined ? [limit] : [after, limit],
    sql: `select artist_id, centroid_blob from artist_centroids
      ${after === undefined ? "" : "where artist_id > ?"}
      order by artist_id limit ?`,
  };
}

async function snapshotItem(row: Record<string, unknown>): Promise<ArtifactSnapshotItem> {
  const {
    cursorValues: _cursorValues,
    payloadBlob,
    ...item
  } = await snapshotMaterial("sonar.track", row);

  return {
    ...item,
    payloadBlobBase64: payloadBlob === null ? null : artifactBytesToBase64(payloadBlob),
  };
}

export async function listSonarTrackDigests(
  client: Pick<Client, "execute">,
  input: { after?: string; limit?: number },
) {
  const limit = input.limit ?? 1_000;
  assertLimit(limit, MAX_PAGE_LIMIT);
  const items: { payloadDigest: string; revision: number; subjectId: string }[] = [];
  let after = input.after;

  while (items.length < limit) {
    const requested = Math.min(200, limit - items.length);
    const rows = typedRows<Record<string, unknown>>(
      (await client.execute(buildSonarTrackDigestStatement(after, requested))).rows,
    );
    const page = await Promise.all(
      rows.slice(0, requested).map(async (row) => ({
        payloadDigest: (await snapshotMaterial("sonar.track", row)).payloadDigest,
        revision: Number(row.revision),
        subjectId: String(row.track_id),
      })),
    );
    items.push(...page);
    after = page.at(-1)?.subjectId;

    if (rows.length <= requested) {
      break;
    }
  }

  return { items, nextAfter: items.length === limit ? (items.at(-1)?.subjectId ?? null) : null };
}

export async function listSonarTracks(
  client: Pick<Client, "execute">,
  input: { subjectIds: string[] },
) {
  assertIds(input.subjectIds);
  const placeholders = input.subjectIds.map(() => "?").join(", ");
  const statement: InStatement = {
    args: input.subjectIds as InValue[],
    sql: `select ${SONAR_TRACK_SOURCE_COLUMNS}, ${revisionSelect("t.track_id")} as revision
      from tracks t
      join track_embeddings e on e.track_id = t.track_id
      left join findings f on f.track_id = t.track_id
      where t.track_id in (${placeholders}) and length(e.embedding_blob) = ${ARTIFACT_VECTOR_BYTES}
      order by t.track_id`,
  };
  const rows = typedRows<Record<string, unknown>>((await client.execute(statement)).rows);
  const items = await Promise.all(
    rows.map(async (row) => ({ ...(await snapshotItem(row)), revision: Number(row.revision) })),
  );
  const found = new Set(items.map((item) => item.subjectId));

  return { absentIds: input.subjectIds.filter((id) => !found.has(id)), items };
}

async function centroidItem(row: Record<string, unknown>) {
  const blob = validCentroid(row.centroid_blob);

  if (blob === null) {
    return null;
  }

  const artistId = String(row.artist_id);

  return {
    artistId,
    blobBase64: artifactBytesToBase64(blob),
    digest: await sonarCentroidDigest(artistId, blob),
  };
}

export async function listSonarCentroidDigests(
  client: Pick<Client, "execute">,
  input: { after?: string; limit?: number },
) {
  const limit = input.limit ?? 1_000;
  assertLimit(limit, MAX_PAGE_LIMIT);
  const items: { artistId: string; digest: string }[] = [];
  let after = input.after;

  while (items.length < limit) {
    const requested = limit - items.length;
    const rows = typedRows<Record<string, unknown>>(
      (await client.execute(buildSonarCentroidDigestStatement(after, requested))).rows,
    );

    if (rows.length === 0) {
      break;
    }

    for (const row of rows) {
      after = String(row.artist_id);
      const item = await centroidItem(row);

      if (item !== null) {
        items.push({ artistId: item.artistId, digest: item.digest });
      }
    }

    if (rows.length < requested) {
      break;
    }
  }

  return { items, nextAfter: items.length === limit ? (items.at(-1)?.artistId ?? null) : null };
}

export async function listSonarCentroids(
  client: Pick<Client, "execute">,
  input: { artistIds: string[] },
) {
  assertIds(input.artistIds);
  const placeholders = input.artistIds.map(() => "?").join(", ");
  const rows = typedRows<Record<string, unknown>>(
    (
      await client.execute({
        args: input.artistIds,
        sql: `select artist_id, centroid_blob from artist_centroids
        where artist_id in (${placeholders}) order by artist_id`,
      })
    ).rows,
  );
  const resolved = await Promise.all(rows.map(centroidItem));
  const items = resolved.filter((item) => item !== null);
  const found = new Set(items.map((item) => item.artistId));

  return { absentIds: input.artistIds.filter((id) => !found.has(id)), items };
}

export async function listSonarTrackDigestsLive(input: { after?: string; limit?: number }) {
  return listSonarTrackDigests(await getDb(), input);
}

export async function listSonarTracksLive(input: { subjectIds: string[] }) {
  return listSonarTracks(await getDb(), input);
}

export async function listSonarCentroidDigestsLive(input: { after?: string; limit?: number }) {
  return listSonarCentroidDigests(await getDb(), input);
}

export async function listSonarCentroidsLive(input: { artistIds: string[] }) {
  return listSonarCentroids(await getDb(), input);
}
