#!/usr/bin/env bun

import { type Client, createClient } from "@libsql/client/web";
import { REMOTE_DB_CONCURRENCY } from "../src/lib/database-concurrency";
import { labelFold } from "@fluncle/contracts/util/galaxy-slug";
import { mbFetch } from "../src/lib/server/musicbrainz";

type MbLabelSearch = { labels?: { id?: string; name?: string; score?: number }[] };

type UnstampedLabel = { id: string; name: string; slug: string };

export type LabelMbidCollision = { mbLabelId: string; slug: string; wonBySlug: string };

export type LabelMbidBackfillResult = {
  collisions: LabelMbidCollision[];

  unresolved: number;

  stamped: number;

  throttled: boolean;
};

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export async function resolveLabelMbidByName(
  name: string,
): Promise<{ mbid: null | string; throttled: boolean }> {
  const { data, rateLimited } = await mbFetch<MbLabelSearch>(
    `/label?query=${encodeURIComponent(name)}&limit=5`,
  );

  if (rateLimited) {
    return { mbid: null, throttled: true };
  }

  const want = labelFold(name);
  const match = (data?.labels ?? []).find(
    (candidate) => candidate.id && candidate.name && labelFold(candidate.name) === want,
  );

  return { mbid: match?.id ?? null, throttled: false };
}

export async function backfillLabelMbids(
  client: Client,
  resolve: (name: string) => Promise<{ mbid: null | string; throttled: boolean }>,
): Promise<LabelMbidBackfillResult> {
  const result: LabelMbidBackfillResult = {
    collisions: [],
    stamped: 0,
    throttled: false,
    unresolved: 0,
  };

  const claimed = new Map<string, string>();
  const existing = await client.execute({
    sql: `select slug, mb_label_id from labels where mb_label_id is not null`,
  });

  for (const row of existing.rows) {
    const mbid = asText(row.mb_label_id);
    const slug = asText(row.slug);

    if (mbid !== "" && slug !== "") {
      claimed.set(mbid, slug);
    }
  }

  const unstamped = await client.execute({
    sql: `select id, name, slug from labels where mb_label_id is null
          and name is not null and trim(name) <> '' order by slug asc`,
  });

  for (const row of unstamped.rows as unknown as UnstampedLabel[]) {
    const name = asText(row.name).trim();
    const slug = asText(row.slug);
    const id = asText(row.id);

    if (name === "" || slug === "" || id === "") {
      continue;
    }

    const { mbid, throttled } = await resolve(name);

    if (throttled) {
      result.throttled = true;

      break;
    }

    if (!mbid) {
      result.unresolved += 1;

      continue;
    }

    const wonBySlug = claimed.get(mbid);

    if (wonBySlug && wonBySlug !== slug) {
      result.collisions.push({ mbLabelId: mbid, slug, wonBySlug });

      continue;
    }

    const updated = await client.execute({
      args: [mbid, new Date().toISOString(), id],
      sql: `update labels set mb_label_id = ?, updated_at = ?
            where id = ? and mb_label_id is null`,
    });

    if (updated.rowsAffected > 0) {
      result.stamped += 1;
      claimed.set(mbid, slug);
    }
  }

  return result;
}

const ITEM = process.env.FLUNCLE_TURSO_OP_ITEM;

async function readSecret(field: string): Promise<string> {
  try {
    const value = await Bun.$`op read ${`${ITEM}/${field}`}`.text();

    return value.trim();
  } catch {
    throw new Error(
      `Could not read ${field} from 1Password (${ITEM}). Unlock 1Password and enable its CLI integration, then retry.`,
    );
  }
}

async function main(): Promise<void> {
  if (!ITEM) {
    throw new Error(
      "Set FLUNCLE_TURSO_OP_ITEM to the 1Password item holding the production Turso credentials — see the ops runbook note.",
    );
  }

  const url = await readSecret("TURSO_DATABASE_URL");
  const authToken = await readSecret("TURSO_AUTH_TOKEN");

  const client = createClient({
    authToken,
    concurrency: REMOTE_DB_CONCURRENCY,
    intMode: "bigint",
    url,
  });
  const result = await backfillLabelMbids(client, resolveLabelMbidByName);

  console.log(
    `label-mbid backfill: ${result.stamped} stamped · ${result.unresolved} unresolved · ` +
      `${result.collisions.length} collisions${result.throttled ? " (STOPPED — throttled)" : ""}.`,
  );

  for (const collision of result.collisions) {
    console.log(
      `  collision: label "${collision.slug}" resolves to MBID ${collision.mbLabelId}, ` +
        `already held by "${collision.wonBySlug}" — left NULL, merge is the operator's call.`,
    );
  }
}

if (import.meta.main) {
  await main();
}
