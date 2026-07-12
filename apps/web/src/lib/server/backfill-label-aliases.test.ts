// The label-alias derivation (RFC musickit-second-authority, U2a), proven against the REAL
// migrated schema on an in-memory libSQL engine. It reads the stored Apple album facts
// (`albums.record_label_raw`, from U1) and proposes `label_aliases` rows under two guardrails:
// the distributor denylist and MusicBrainz cross-source corroboration. Idempotent by construction.

import { type Client } from "@libsql/client";
import { beforeEach, describe, expect, it } from "vitest";
import { backfillLabelAliases } from "../../../scripts/backfill-label-aliases";
import { createIntegrationDb } from "./integration-db";

let db: Client;

beforeEach(async () => {
  db = await createIntegrationDb();
});

/** A canonical label (the MusicBrainz spelling the crawled row already carries). */
async function insertLabel(id: string, name: string, slug: string): Promise<void> {
  const now = new Date().toISOString();
  await db.execute({
    args: [id, name, slug, now, now],
    sql: `insert into labels (id, name, slug, created_at, updated_at) values (?, ?, ?, ?, ?)`,
  });
}

/** An album carrying Apple's `record_label_raw` (the second authority's spelling). */
async function insertAlbum(id: string, slug: string, recordLabelRaw: string): Promise<void> {
  const now = new Date().toISOString();
  await db.execute({
    args: [id, `Album ${slug}`, slug, recordLabelRaw, now, now],
    sql: `insert into albums (id, name, slug, record_label_raw, created_at, updated_at)
          values (?, ?, ?, ?, ?, ?)`,
  });
}

/** A track linking an album to the label its crawled row carries. */
async function insertTrack(trackId: string, albumId: string, labelId: string): Promise<void> {
  await db.execute({
    args: [trackId, albumId, labelId, `spotify:track:${trackId}`],
    sql: `insert into tracks
            (track_id, title, artists_json, album_id, label_id, spotify_uri, spotify_url, duration_ms)
          values (?, 'Tune', '["Artist"]', ?, ?, ?, 'url', 0)`,
  });
}

async function aliasRows(): Promise<
  Array<{ alias: string; alias_slug: string; kind: string; label_id: string; status: string }>
> {
  const result = await db.execute(
    `select alias, alias_slug, kind, label_id, status from label_aliases order by alias`,
  );
  return result.rows.map((row) => ({
    alias: row.alias as string,
    alias_slug: row.alias_slug as string,
    kind: row.kind as string,
    label_id: row.label_id as string,
    status: row.status as string,
  }));
}

describe("backfillLabelAliases (the candidate writer)", () => {
  it("mints a CANDIDATE when Apple's recordLabel fold-agrees with the known label but spells it differently", async () => {
    // "Med School" (Apple) ⋂ "Medschool" (MusicBrainz) — both fold to `medschool`, but slugify
    // apart (`med-school` vs `medschool`). Same recording, two authorities agreeing: a candidate.
    await insertLabel("lbl_med", "Medschool", "medschool");
    await insertAlbum("alb_1", "some-ep", "Med School");
    await insertTrack("t1", "alb_1", "lbl_med");

    const result = await backfillLabelAliases(db);

    expect(result).toMatchObject({ candidates: 1, dropped: 0, hints: 0 });
    expect(await aliasRows()).toEqual([
      {
        alias: "Med School",
        alias_slug: "med-school",
        kind: "name",
        label_id: "lbl_med",
        status: "candidate",
      },
    ]);
  });

  it("mints NOTHING when Apple's spelling already IS the canonical slug (nothing to alias)", async () => {
    await insertLabel("lbl_med", "Medschool", "medschool");
    await insertAlbum("alb_1", "some-ep", "medschool");
    await insertTrack("t1", "alb_1", "lbl_med");

    const result = await backfillLabelAliases(db);

    expect(result).toMatchObject({ candidates: 0, hints: 0 });
    expect(await aliasRows()).toEqual([]);
  });

  it("mints a HINT when Apple names a label the archive does not recognise (a lone disagreement)", async () => {
    await insertLabel("lbl_med", "Medschool", "medschool");
    await insertAlbum("alb_1", "some-ep", "Some Distributor Imprint");
    await insertTrack("t1", "alb_1", "lbl_med");

    const result = await backfillLabelAliases(db);

    expect(result).toMatchObject({ candidates: 0, hints: 1 });
    expect(await aliasRows()).toEqual([
      {
        alias: "Some Distributor Imprint",
        alias_slug: "some-distributor-imprint",
        kind: "hint",
        label_id: "lbl_med",
        status: "candidate",
      },
    ]);
  });

  it("DROPS a denylisted distributor recordLabel — never a candidate, never a hint", async () => {
    await insertLabel("lbl_med", "Medschool", "medschool");
    await insertAlbum("alb_1", "some-ep", "Believe");
    await insertTrack("t1", "alb_1", "lbl_med");

    const result = await backfillLabelAliases(db);

    expect(result).toMatchObject({ candidates: 0, dropped: 1, hints: 0 });
    expect(await aliasRows()).toEqual([]);
  });

  it("skips an album with no linked label (nothing to corroborate or attach to)", async () => {
    await insertAlbum("alb_1", "some-ep", "Med School");
    // A track on the album but with NO label_id.
    await db.execute({
      args: ["t1", "alb_1"],
      sql: `insert into tracks (track_id, title, artists_json, album_id, spotify_uri, spotify_url, duration_ms)
            values (?, 'Tune', '["Artist"]', ?, 'uri', 'url', 0)`,
    });

    const result = await backfillLabelAliases(db);

    expect(result).toMatchObject({ candidates: 0, hints: 0 });
    expect(await aliasRows()).toEqual([]);
  });

  it("is idempotent — a second run mints nothing and never reverts a confirmed row", async () => {
    await insertLabel("lbl_med", "Medschool", "medschool");
    await insertAlbum("alb_1", "some-ep", "Med School");
    await insertTrack("t1", "alb_1", "lbl_med");

    await backfillLabelAliases(db);
    // The operator confirms the candidate.
    await db.execute(`update label_aliases set status = 'confirmed'`);

    const second = await backfillLabelAliases(db);

    expect(second).toMatchObject({ candidates: 0, hints: 0 });
    // The confirmed row survives untouched (on conflict do nothing on the unique index).
    expect((await aliasRows())[0]).toMatchObject({ alias: "Med School", status: "confirmed" });
  });
});
