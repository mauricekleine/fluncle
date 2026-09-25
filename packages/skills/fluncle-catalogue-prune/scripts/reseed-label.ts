#!/usr/bin/env bun

import { writeFileSync } from "node:fs";

import { type Client, type Value } from "@libsql/client/web";

import { getDb } from "./lib";

export const resolverNodeId = (slug: string): string => `fluncle:label:${slug}`;

export const retiredNote = (on: Date): string =>
  `wrong namesake; retired ${on.toISOString().slice(0, 10)}`;

export type LabelSeedRow = {
  id: string;
  mb_label_id: string | null;
  name: string;
  seed_state: string;
  slug: string;
};

export type FrontierLabelNode = {
  cursor: number;
  external_id: string;
  hop: number;
  id: string;
  label_slug: string | null;
  note: string | null;
  source: string;
  state: string;
};

const text = (v: Value): string => (typeof v === "string" ? v : "");
const textOrNull = (v: Value): string | null => (typeof v === "string" ? v : null);

export async function readLabelSeed(db: Client, slug: string): Promise<LabelSeedRow | undefined> {
  const result = await db.execute({
    args: [slug],
    sql: `select id, slug, name, seed_state, mb_label_id from labels where slug = ?`,
  });
  const row = result.rows[0];

  return row
    ? {
        id: text(row.id),
        mb_label_id: textOrNull(row.mb_label_id),
        name: text(row.name),
        seed_state: text(row.seed_state),
        slug: text(row.slug),
      }
    : undefined;
}

export async function readLabelNodes(db: Client, slug: string): Promise<FrontierLabelNode[]> {
  const result = await db.execute({
    args: [resolverNodeId(slug), slug],
    sql: `select id, kind, source, external_id, state, cursor, hop, label_slug, note
            from crawl_frontier
           where kind = 'label' and (id = ? or label_slug = ?)
           order by source, id`,
  });

  return result.rows.map((row) => ({
    cursor: Number(row.cursor ?? 0),
    external_id: text(row.external_id),
    hop: Number(row.hop ?? 0),
    id: text(row.id),
    label_slug: textOrNull(row.label_slug),
    note: textOrNull(row.note),
    source: text(row.source),
    state: text(row.state),
  }));
}

export type NodeSplit = {
  correct: FrontierLabelNode[];
  resolver: FrontierLabelNode | undefined;
  wrongNamesake: FrontierLabelNode[];
};

export function splitLabelNodes(
  nodes: FrontierLabelNode[],
  slug: string,
  mbLabelId: string,
): NodeSplit {
  const resolverId = resolverNodeId(slug);
  const mb = nodes.filter((n) => n.source === "musicbrainz");

  return {
    correct: mb.filter((n) => n.external_id === mbLabelId),
    resolver: nodes.find((n) => n.id === resolverId),
    wrongNamesake: mb.filter((n) => n.external_id !== mbLabelId),
  };
}

export async function main(
  argv: string[] = process.argv.slice(2),
  openDb: () => Promise<Client> = getDb,
): Promise<number> {
  const confirm = argv.includes("--confirm");
  const out = process.env.PRUNE_OUT_DIR ?? ".";
  const slugIndex = argv.indexOf("--slug");
  const slug = slugIndex >= 0 ? argv[slugIndex + 1]?.trim() : undefined;

  if (!slug) {
    console.log("Nothing to do. Pass --slug <label-slug>.");

    return 0;
  }

  const db = await openDb();
  console.log(`\n===== RESEED LABEL SEED (${confirm ? "WRITE" : "DRY RUN"}) =====`);

  const label = await readLabelSeed(db, slug);
  if (!label) {
    console.log(`  ⚠ no labels row for slug "${slug}"`);
    console.log(`\nABORTED — nothing to reseed. Check the slug against /admin/labels.`);

    return 1;
  }
  console.log(`label: ${label.name} (${label.slug}) · seed_state=${label.seed_state}`);

  if (label.seed_state !== "enabled") {
    console.log(
      `\nABORTED — this repair is for an ENABLED seed whose IDENTITY resolved wrong. A ${label.seed_state} label is not seeded at all, so its frontier needs no repair; rule it or purge it instead.`,
    );

    return 1;
  }

  const mbLabelId = label.mb_label_id;
  if (!mbLabelId) {
    console.log(
      `\nABORTED — no mb_label_id on this label, so there is no authority to tell the right MusicBrainz label from the namesake.`,
    );
    console.log(
      `Resolve the label's MusicBrainz identity first (that is what the fixed resolver writes back), then re-run.`,
    );

    return 1;
  }
  console.log(`mb_label_id: ${mbLabelId}  ← the identity the operator's ruling refers to`);

  const nodes = await readLabelNodes(db, slug);
  const { correct, resolver, wrongNamesake } = splitLabelNodes(nodes, slug, mbLabelId);

  console.log(`\nfrontier label nodes for this slug (${nodes.length}):`);
  if (nodes.length === 0) {
    console.log(`  (none — the seed has never been walked)`);
  }
  for (const n of nodes) {
    const flag =
      n.id === resolver?.id
        ? "resolver node"
        : wrongNamesake.includes(n)
          ? "⚠ WRONG NAMESAKE (external_id ≠ mb_label_id)"
          : "✓ correct identity";
    console.log(`  ${n.id}`);
    console.log(
      `      state=${n.state} cursor=${n.cursor} hop=${n.hop} · ${flag}${n.note ? ` · note: ${n.note}` : ""}`,
    );
  }

  console.log(
    `\nresolver ${resolver ? `${resolver.state} → pending, cursor 0` : "absent (the next tick mints it from the enabled seed — nothing to reset)"}`,
  );
  console.log(`correct MB nodes ${correct.length} · to retire ${wrongNamesake.length}`);

  if (!resolver && wrongNamesake.length === 0) {
    console.log(`\nNothing to repair — no resolver node to re-arm and no namesake to retire.`);

    return 0;
  }

  if (!confirm) {
    console.log(
      `\nDRY RUN — nothing written. Deploy the resolver fix FIRST, then re-run with --confirm.`,
    );

    return 0;
  }

  const now = new Date();
  const nowIso = now.toISOString();
  const path = `${out}/reseed-label-${slug}-rollback.json`;
  writeFileSync(path, JSON.stringify({ at: nowIso, label, prior: nodes, slug }, null, 2));
  console.log(`\nrollback → ${path} (${nodes.length} node rows)`);

  if (resolver) {
    const result = await db.execute({
      args: [nowIso, resolver.id],
      sql: `update crawl_frontier set state = 'pending', cursor = 0, updated_at = ? where id = ?`,
    });
    console.log(`  re-armed resolver ${resolver.id}: ${result.rowsAffected} row`);
  }

  const note = retiredNote(now);
  for (const n of wrongNamesake) {
    const result = await db.execute({
      args: [note, nowIso, n.id],
      sql: `update crawl_frontier set note = ?, updated_at = ? where id = ?`,
    });
    console.log(`  retired ${n.id} (${n.external_id}): ${result.rowsAffected} row · "${note}"`);
  }

  console.log(`\nDONE. Rollback: ${path}`);
  console.log(
    `The retired nodes are KEPT and inert — they stay 'done', and the re-arm join no longer picks them.`,
  );
  console.log(
    `Next: purge the impostor's tracks with purge-artists.ts (SKILL.md § Namesake repair).`,
  );

  return 0;
}

if (import.meta.main) {
  process.exit(await main());
}
