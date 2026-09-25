#!/usr/bin/env bun

import { type Client, createClient, type InArgs } from "@libsql/client";
import { REMOTE_DB_CONCURRENCY } from "../src/lib/database-concurrency";
import { galaxySlug } from "@fluncle/contracts/util/galaxy-slug";
import { config } from "dotenv";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type PlanRecordingBackfillResult = {
  claimsNormalized: number;
  draftsDrained: number;
  planCuesInserted: number;
  plansCreated: number;
  takeCuesInserted: number;
  takesSynthesized: number;
  trackFindingIdsFilled: number;
};

function asText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
    return String(value);
  }

  return "";
}

function parseArtists(raw: unknown): string[] {
  if (typeof raw !== "string" || raw.length === 0) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw);

    return Array.isArray(parsed) ? parsed.map((value) => String(value)) : [];
  } catch {
    return [];
  }
}

function insertCueStatement(cue: {
  artistsText: string | null;
  findingId: string | null;
  id: string;
  now: string;
  position: number;
  recordingId: string;
  startMs: number | null;
  titleText: string | null;
}): { args: InArgs; sql: string } {
  return {
    args: [
      cue.id,
      cue.recordingId,
      cue.findingId,
      cue.artistsText,
      cue.titleText,
      cue.position,
      cue.startMs,
      cue.now,
      cue.now,
      cue.recordingId,
      cue.position,
    ],
    sql: `insert into recording_cues
            (id, recording_id, finding_id, artists_text, title_text, position, start_ms, created_at, updated_at)
          select ?, ?, ?, ?, ?, ?, ?, ?, ?
          where not exists (
            select 1 from recording_cues where recording_id = ? and position = ?
          )`,
  };
}

async function mixtapeMemberRows(
  client: Client,
  mixtapeId: string,
): Promise<
  Array<{
    artistsText: string;
    position: number;
    startMs: number | null;
    titleText: string;
    trackId: string;
  }>
> {
  const result = await client.execute({
    args: [mixtapeId],
    sql: `select mt.track_id as track_id, mt.position as position, mt.start_ms as start_ms,
                 t.title as title, t.artists_json as artists_json
          from mixtape_tracks mt
          join tracks t on t.track_id = mt.track_id
          where mt.mixtape_id = ?
          order by mt.position`,
  });

  return result.rows.map((row) => ({
    artistsText: parseArtists(row.artists_json).join(", "),
    position: Number(row.position),
    startMs: row.start_ms === null ? null : Number(row.start_ms),
    titleText: asText(row.title),
    trackId: asText(row.track_id),
  }));
}

async function mintPlanHandle(client: Client, draftId: string): Promise<string> {
  for (let attempt = 0; attempt < 64; attempt++) {
    const slug = galaxySlug(draftId, attempt);
    const clash = await client.execute({
      args: [slug],
      sql: `select 1 from recordings where title = ? limit 1`,
    });

    if (clash.rows.length === 0) {
      return slug;
    }
  }

  return `${galaxySlug(draftId, 0)}-${draftId.slice(0, 8)}`;
}

async function cueCount(client: Client, recordingId: string): Promise<number> {
  const result = await client.execute({
    args: [recordingId],
    sql: `select count(*) as n from recording_cues where recording_id = ?`,
  });

  return Number(result.rows[0]?.n ?? 0);
}

export async function backfillPlanRecordingMixtape(
  client: Client,
): Promise<PlanRecordingBackfillResult> {
  const now = new Date().toISOString();
  const result: PlanRecordingBackfillResult = {
    claimsNormalized: 0,
    draftsDrained: 0,
    planCuesInserted: 0,
    plansCreated: 0,
    takeCuesInserted: 0,
    takesSynthesized: 0,
    trackFindingIdsFilled: 0,
  };

  const unlinkedDrafts = await client.execute({
    sql: `select id, title, note, created_at
          from mixtapes where status = 'draft' and recording_id is null
          order by created_at`,
  });

  for (const draft of unlinkedDrafts.rows) {
    const draftId = asText(draft.id);

    const title = await mintPlanHandle(client, draftId);
    const planId = randomUUID();

    await client.batch(
      [
        {
          args: [planId, title, draft.note ?? null, now, now],
          sql: `insert into recordings
                  (id, title, note, r2_key, parent_id, version, created_at, updated_at)
                values (?, ?, ?, null, null, 1, ?, ?)`,
        },
        {
          args: [planId, draftId],
          sql: `update mixtapes set recording_id = ? where id = ? and recording_id is null`,
        },
      ],
      "write",
    );
    result.plansCreated += 1;
  }

  const normalized = await client.execute({
    args: [now],
    sql: `update mixtapes set status = 'distributing', updated_at = ?
          where status = 'draft'
            and recording_id in (select id from recordings where r2_key is not null)`,
  });

  result.claimsNormalized = normalized.rowsAffected;

  const linkedDrafts = await client.execute({
    sql: `select m.id, m.recording_id from mixtapes m
          join recordings r on r.id = m.recording_id
          where m.status = 'draft' and r.r2_key is null`,
  });

  for (const draft of linkedDrafts.rows) {
    const planId = asText(draft.recording_id);
    const draftId = asText(draft.id);

    const existing = await client.execute({
      args: [planId],
      sql: `select finding_id, coalesce(max(position) over (), 0) as max_position
            from recording_cues where recording_id = ?`,
    });
    const present = new Set(
      existing.rows.map((row) => asText(row.finding_id)).filter((id) => id.length > 0),
    );
    let position = Number(existing.rows[0]?.max_position ?? 0);

    for (const member of await mixtapeMemberRows(client, draftId)) {
      if (present.has(member.trackId)) {
        continue;
      }

      present.add(member.trackId);
      position += 1;
      const insert = await client.execute(
        insertCueStatement({
          artistsText: member.artistsText || null,
          findingId: member.trackId,
          id: randomUUID(),
          now,
          position,
          recordingId: planId,
          startMs: member.startMs,
          titleText: member.titleText || null,
        }),
      );

      result.planCuesInserted += insert.rowsAffected;
    }

    await client.batch(
      [
        { args: [draftId], sql: `delete from mixtape_tracks where mixtape_id = ?` },
        { args: [draftId], sql: `delete from mixtapes where id = ? and status = 'draft'` },
      ],
      "write",
    );
    result.draftsDrained += 1;
  }

  const unlinkedPublished = await client.execute({
    sql: `select id, log_id, title, recorded_at, duration_ms from mixtapes
          where status in ('published', 'distributing') and recording_id is null`,
  });

  for (const mixtape of unlinkedPublished.rows) {
    const logId = asText(mixtape.log_id);

    if (!logId) {
      console.warn(`Skipping ${asText(mixtape.id)}: published/distributing but no log_id.`);
      continue;
    }

    const recordingId = randomUUID();
    const mixtapeId = asText(mixtape.id);

    await client.batch(
      [
        {
          args: [
            recordingId,
            asText(mixtape.title),
            `${logId}/set.mp4`,
            mixtape.recorded_at ?? null,
            mixtape.duration_ms ?? null,
            now,
            now,
          ],
          sql: `insert into recordings
                  (id, title, r2_key, recorded_at, duration_ms, parent_id, version, created_at, updated_at)
                values (?, ?, ?, ?, ?, null, 1, ?, ?)`,
        },
        {
          args: [recordingId, mixtapeId],
          sql: `update mixtapes set recording_id = ? where id = ? and recording_id is null`,
        },
      ],
      "write",
    );
    result.takesSynthesized += 1;
  }

  const linkedPublished = await client.execute({
    sql: `select id, recording_id from mixtapes
          where status in ('published', 'distributing') and recording_id is not null`,
  });

  for (const mixtape of linkedPublished.rows) {
    const recordingId = asText(mixtape.recording_id);

    if ((await cueCount(client, recordingId)) > 0) {
      continue;
    }

    const members = await mixtapeMemberRows(client, asText(mixtape.id));

    for (const member of members) {
      const insert = await client.execute(
        insertCueStatement({
          artistsText: member.artistsText || null,
          findingId: member.trackId,
          id: randomUUID(),
          now,
          position: member.position,
          recordingId,
          startMs: member.startMs,
          titleText: member.titleText || null,
        }),
      );

      result.takeCuesInserted += insert.rowsAffected;
    }
  }

  const filled = await client.execute({
    sql: `update mixtape_tracks set finding_id = track_id where finding_id is null`,
  });

  result.trackFindingIdsFilled = filled.rowsAffected;

  return result;
}

async function main(): Promise<void> {
  if (!process.env.TURSO_DATABASE_URL) {
    config({ path: join(dirname(fileURLToPath(import.meta.url)), "..", ".dev.vars") });
  }

  const url = process.env.TURSO_DATABASE_URL;

  if (!url) {
    throw new Error("TURSO_DATABASE_URL is required (set it in apps/web/.dev.vars)");
  }

  const authToken = process.env.TURSO_AUTH_TOKEN;
  const client = createClient(
    authToken
      ? { authToken, concurrency: REMOTE_DB_CONCURRENCY, url }
      : { concurrency: REMOTE_DB_CONCURRENCY, url },
  );
  const result = await backfillPlanRecordingMixtape(client);

  console.log(
    `plan→recording→mixtape backfill: ${result.plansCreated} plans created, ` +
      `${result.draftsDrained} drafts drained, ${result.claimsNormalized} claims normalized, ` +
      `${result.planCuesInserted} plan cues, ${result.takesSynthesized} takes synthesized, ` +
      `${result.takeCuesInserted} take cues, ${result.trackFindingIdsFilled} finding links filled.`,
  );
}

if (import.meta.main) {
  await main();
}
