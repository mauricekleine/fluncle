import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// THE has_embedding MIRROR RAIL (schema.ts § `has_embedding`, docs/db-scale-backlog Wave 2 #4).
//
// `tracks.has_embedding` is a MAINTAINED mirror of "a `track_embeddings` row exists", and the whole
// point of it is that a presence question can be answered off a column the scan already has —
// `/admin/funnel`'s stage scan reads it out of a covering index, and both partial queue indexes
// (`tracks_embed_queue_idx`, `tracks_anchor_order_idx`) are KEYED on it, which a cross-table
// `exists` could never be matched against. A mirror is only worth having if it cannot drift, so the
// invariant is: EVERY statement that writes a `track_embeddings` row moves `has_embedding` in the
// same libSQL write BATCH.
//
// The satellite split makes that structural rather than a habit: `lib/server/embedding.ts` owns the
// only two statements that touch the table (`writeEmbeddingSatellite` and the delete behind
// `clearEmbeddingSatellite`), each published beside the `tracks` fragment it must travel with. So
// the rail here is a SINGLE-WRITER check — no other server module may name the table in a write —
// plus a check that the shared fragments still carry both halves. A new writer has to come through
// embedding.ts, where the pairing is one file away from being read.
//
// The complement — that the mirror's VALUE is right, not merely present — is proven on live rows by
// the funnel fold-equivalence test, which runs the folded scan (reading `has_embedding`) against
// the standalone reference queries (still joining `track_embeddings`) and requires the two to
// agree. Together: this test proves the pair always moves, that test proves it moves correctly, and
// `scripts/backfill-has-embedding.ts` reconciles anything a console or a restore knocks loose.

const SERVER = fileURLToPath(new URL("./", import.meta.url));

/** Every non-test `.ts` under `lib/server`, recursively, as paths relative to the server root. */
function serverSources(dir = SERVER, prefix = ""): string[] {
  const out: string[] = [];

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      out.push(...serverSources(join(dir, entry.name), rel));
    } else if (entry.name.endsWith(".ts") && !entry.name.includes(".test.")) {
      out.push(rel);
    }
  }

  return out;
}

/**
 * One write against `track_embeddings` outside embedding.ts, with the file it sits in. Matching is
 * deliberately crude — any `insert into` / `delete from` naming the table — because a false ALARM
 * is a reviewer reading one line, while a false pass is a drifted mirror in production.
 */
function foreignWrites(): string[] {
  const out: string[] = [];

  for (const file of serverSources()) {
    // embedding.ts IS the writer; integration-db.ts is the test harness, and it writes through
    // embedding.ts's own statements rather than spelling its own (which this cannot see, and does
    // not need to — the pairing it would be checking is the one embedding.ts already carries).
    if (file === "embedding.ts") {
      continue;
    }

    const source = readFileSync(join(SERVER, file), "utf8");

    if (/(?:insert\s+(?:or\s+\w+\s+)?into|delete\s+from)\s+track_embeddings/i.test(source)) {
      out.push(file);
    }
  }

  return out;
}

/** Server modules that clear a vector through the shared fragments rather than spelling it out. */
function sharedClears(): string[] {
  return serverSources().filter(
    (file) =>
      file !== "embedding.ts" &&
      readFileSync(join(SERVER, file), "utf8").includes("clearEmbeddingSatellite("),
  );
}

describe("the has_embedding mirror cannot drift", () => {
  it("finds the satellite's callers at all (the scanner still works)", () => {
    // A guard on the guard: if a refactor moves these writes somewhere this test cannot see, the
    // suite must fail loudly rather than pass by finding nothing to check. The clearing fragment
    // has three catalogue quarantine callers plus the `update_track` clear arm.
    expect(sharedClears().length).toBeGreaterThanOrEqual(3);
  });

  it("keeps embedding.ts the ONLY module that writes track_embeddings", () => {
    expect(foreignWrites()).toEqual([]);
  });

  it("keeps each shared fragment carrying both halves of its pair", () => {
    const embedding = readFileSync(join(SERVER, "embedding.ts"), "utf8");

    // The `tracks` halves…
    expect(embedding).toContain("has_embedding = 0");
    expect(embedding).toContain("has_embedding = 1");
    // …the satellite halves…
    expect(embedding).toContain("delete from track_embeddings");
    expect(embedding).toContain("insert into track_embeddings");
    // …and the ordering contract that makes the guarded clears safe: the DELETE fires only when
    // `tracks` no longer claims a vector, so an update whose WHERE matched nothing is a no-op.
    expect(embedding).toContain("not exists (select 1 from tracks");
  });
});
