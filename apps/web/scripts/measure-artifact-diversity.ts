#!/usr/bin/env bun
/**
 * measure-artifact-diversity.ts — the homogenisation MEASUREMENT harness.
 *
 * The roadmap's demand (docs/planning/ROADMAP.md § "Homogenisation"): every generated
 * artifact family wants a cheap, honest diversity metric run on the REAL corpus, so the
 * "our artifacts drift toward a mean" claim stays falsifiable. "An anti-sameness effort
 * with no metric is folklore." The notes already had one (`scoreNoteEcho` + the note-sweep
 * `--dry-run`); this runs the SAME measures across all three WRITTEN families — notes,
 * spoken observations, logbook entries — off the live archive and prints a ranked report.
 *
 * READ-ONLY. Nothing but SELECTs. It measures; it changes no artifact and writes no DB row.
 *
 * WHERE IT READS. Point it at any libSQL database via TURSO env vars, or let it fall back
 * to apps/web/.dev.vars (the per-worktree local dev server, which is itself seeded from a
 * prod snapshot via `db:pull-prod`). `--db <url>` overrides. To measure PRODUCTION, hand it
 * the prod creds out of 1Password (see the header of db-pull-prod.ts for the item), e.g.:
 *
 *   TURSO_DATABASE_URL="$(op read "$FLUNCLE_TURSO_OP_ITEM/TURSO_DATABASE_URL")" \
 *   TURSO_AUTH_TOKEN="$(op read "$FLUNCLE_TURSO_OP_ITEM/TURSO_AUTH_TOKEN")" \
 *   bun run --cwd apps/web scripts/measure-artifact-diversity.ts --out /tmp/sameness-report.md
 *
 * OUTPUT. The full markdown report goes to stdout; `--out <path>` also writes it to a file.
 *
 * Re-run it whenever the corpus, a prompt, or a model changes — the harness is what keeps
 * the drift claim honest as the archive grows (the roadmap's "re-measure as it grows").
 */
import { createClient } from "@libsql/client";
import { config } from "dotenv";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type Artifact,
  type FamilyDiversity,
  measureFamily,
  stripLogbookProse,
} from "../src/lib/server/artifact-diversity";

// The note work's ratified baseline, from the roadmap + PR #502: the vibe-neighbour layer
// + echo gate CUT within-sonic-region mean pairwise word overlap from 0.041 to 0.015. It
// is an INTRA-REGION number (a note vs its ~6 nearest sonic neighbours), so it is not the
// same scope as this harness's whole-corpus mean — the report says so plainly — but it is
// the one measured anti-sameness result Fluncle has, and every other family is judged
// against the fact that the notes already have a working counter-measure and the rest do not.
const NOTE_BASELINE = { after: 0.015, before: 0.041 } as const;

function arg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);

  return index >= 0 ? process.argv[index + 1] : undefined;
}

function resolveDbUrl(): string {
  const override = arg("--db");

  if (override) {
    return override;
  }

  if (!process.env.TURSO_DATABASE_URL) {
    // Same fallback as the backfill scripts: load .dev.vars, never overriding a set var.
    config({ path: join(dirname(fileURLToPath(import.meta.url)), "..", ".dev.vars") });
  }

  const url = process.env.TURSO_DATABASE_URL;

  if (!url) {
    throw new Error(
      "No database URL. Set TURSO_DATABASE_URL (or pass --db <url>), or provide apps/web/.dev.vars.",
    );
  }

  return url;
}

/** A short, safe label for the report — the DB host/kind, never its token. */
function dbLabel(url: string): string {
  if (url.startsWith("file:")) {
    return "a local libSQL file";
  }

  if (url.includes("127.0.0.1") || url.includes("localhost")) {
    return "the local dev libSQL server (seeded from a prod snapshot via db:pull-prod)";
  }

  if (url.includes("turso.io")) {
    return "a hosted Turso database";
  }

  return "a libSQL database";
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function renderFamily(reading: FamilyDiversity): string {
  const lines: string[] = [];

  lines.push(`### ${reading.family} (${reading.size} artifacts)`);
  lines.push("");
  lines.push(
    `- **Mean pairwise word overlap:** ${reading.meanPairwiseOverlap.toFixed(4)} (${pct(reading.meanPairwiseOverlap)})`,
  );
  lines.push(
    `- **Most-alike pair:** ${reading.maxPairwiseOverlap.toFixed(4)} overlap` +
      (reading.maxPair.length === 2 ? ` — ${reading.maxPair[0]} ↔ ${reading.maxPair[1]}` : ""),
  );
  lines.push(
    `- **Echoing the rest of the family (would trip the gate):** ${reading.echoingCount} of ${reading.size}`,
  );
  lines.push("");

  lines.push(`**Top repeated phrases (n=3..6, ranked by how many artifacts share them):**`);
  lines.push("");

  if (reading.topPhrases.length === 0) {
    lines.push("_None — no phrase recurs across two or more artifacts._");
  } else {
    lines.push("| # | phrase | in N artifacts | total uses | words |");
    lines.push("| - | ------ | -------------: | ---------: | ----: |");
    reading.topPhrases.forEach((phrase, index) => {
      lines.push(
        `| ${index + 1} | "${phrase.phrase}" | ${phrase.docFreq} | ${phrase.count} | ${phrase.n} |`,
      );
    });
  }

  lines.push("");
  lines.push(`**Most-widespread single content words:**`);
  lines.push("");
  lines.push(
    reading.topWords.length === 0
      ? "_None recurring._"
      : reading.topWords
          .map((word) => `\`${word.word}\` (${word.docFreq}/${reading.size})`)
          .join(", "),
  );

  lines.push("");
  lines.push(`**Nearest-neighbour lifts (worst first):**`);
  lines.push("");

  if (reading.neighbourLifts.length === 0) {
    lines.push("_None — no artifact lifts a phrase or reuses the words of another._");
  } else {
    for (const lift of reading.neighbourLifts.slice(0, 8)) {
      const detail = lift.echo.phrase
        ? `lifts "${lift.echo.phrase}" from ${lift.echo.logId}`
        : `reuses ${pct(lift.echo.overlap)} of ${lift.echo.logId}'s words`;

      lines.push(`- **${lift.id}** ${detail}`);
    }

    if (reading.neighbourLifts.length > 8) {
      lines.push(`- _…and ${reading.neighbourLifts.length - 8} more._`);
    }
  }

  lines.push("");

  return lines.join("\n");
}

// A family this small can post a high mean pairwise overlap off two or three artifacts,
// and a mean over three items is not a trend. So a family below this size is reported as a
// WATCH, never named the priority on its raw number alone — the honest read must not let a
// thin corpus outshout a large one.
const MIN_CONFIDENT_SIZE = 10;

/**
 * The honest one-paragraph read. NOT a mechanical "highest mean wins": a three-entry family
 * can top the mean off almost nothing, so this is size-aware. It names the raw ranking, then
 * picks the PRIORITY as the largest, most-pervasively-echoing family that has NO shipped rail
 * yet — the one where fixing sameness pays the most and is least likely to be a sampling
 * artifact — and flags any thin family as a watch rather than the target.
 */
function renderVerdict(readings: FamilyDiversity[]): string {
  const measurable = readings.filter((reading) => reading.size >= 2);

  if (measurable.length === 0) {
    return "_Not enough data in any family to read a trend._";
  }

  const byMean = [...measurable].sort((a, b) => b.meanPairwiseOverlap - a.meanPairwiseOverlap);
  const rawTop = byMean[0];

  // The notes are the one family with a shipped anti-sameness rail; they are the yardstick,
  // never the priority. The priority is a rail-less family with a corpus big enough to trust.
  const candidates = measurable.filter(
    (reading) => reading.family !== "notes" && reading.size >= MIN_CONFIDENT_SIZE,
  );
  const priority = [...candidates].sort(
    (a, b) =>
      b.echoingCount / b.size - a.echoingCount / a.size ||
      b.meanPairwiseOverlap - a.meanPairwiseOverlap,
  )[0];

  const notes = readings.find((reading) => reading.family === "notes");
  const notesLine = notes
    ? `For scale, the notes — the one family with a shipped rail (the vibe-neighbour layer + echo gate, measured to cut intra-region overlap ${NOTE_BASELINE.before}→${NOTE_BASELINE.after}) — sit at ${notes.meanPairwiseOverlap.toFixed(4)} whole-corpus overlap, ${notes.echoingCount}/${notes.size} echoing. `
    : "";

  // The thin families that top the raw mean but cannot yet be trusted as a trend.
  const thin = measurable.filter(
    (reading) => reading.family !== "notes" && reading.size < MIN_CONFIDENT_SIZE,
  );
  const thinLine =
    thin.length > 0 && rawTop && rawTop.size < MIN_CONFIDENT_SIZE
      ? `The **${rawTop.family}** post the highest raw mean (${rawTop.meanPairwiseOverlap.toFixed(4)}), but at ${rawTop.size} artifacts that is a handful of pairs, not a trend — and a logbook entry structurally retells its findings' notes and observations, so some of that overlap is by design. Treat it as a watch: it will inherit whatever fix the larger families get. `
      : "";

  if (!priority) {
    return (
      `Sameness is real but no rail-less family is yet large enough (≥ ${MIN_CONFIDENT_SIZE}) to name a confident priority. ` +
      notesLine +
      thinLine +
      "Re-run this harness as the corpora grow."
    );
  }

  return (
    `Sameness is worst, and most confidently so, in the **${priority.family}**: ${priority.echoingCount} of ${priority.size} would trip the echo gate against their own family and the mean pairwise overlap is ${priority.meanPairwiseOverlap.toFixed(4)}. ` +
    notesLine +
    `The tells are in the phrase table above — a templated closing formula recurs almost corpus-wide (the "hope it…"/"fam, enjoy" sign-off and the "before I'd clocked it" opener), which is exactly the "spent moves" the note layer neutralises by handing the generator its neighbourhood as already-taken. ` +
    thinLine +
    `**The ${priority.family} most need the homogenisation slice first** — biggest corpus, no rail, and the most pervasive echoing. Extend the notes' proven mechanism to it (author each against its neighbours' notes/scripts as spent moves; gate on lifted phrases), then re-run this harness to confirm the number moved. The notes show the mechanism works; the ${priority.family} are where it now pays most.`
  );
}

function renderReport(readings: FamilyDiversity[], meta: { db: string; when: string }): string {
  const ranked = [...readings].sort((a, b) => b.meanPairwiseOverlap - a.meanPairwiseOverlap);
  const lines: string[] = [];

  lines.push("# Fluncle — artifact sameness report");
  lines.push("");
  lines.push(`Generated ${meta.when} against ${meta.db}.`);
  lines.push("");
  lines.push(
    "The measures are corpus-wide and built on the exact primitives the note echo gate uses " +
      "(`echoWords` / `contentOverlap` / `scoreNoteEcho`), so every number here agrees with the " +
      'gate about what "same" means. Read-only; nothing was written.',
  );
  lines.push("");

  lines.push("## Data source & re-running against production");
  lines.push("");
  lines.push(
    `Measured against ${meta.db}. When that is the local dev server / a file, it is seeded from a ` +
      "production snapshot (`bun run db:pull-prod`), so it tracks prod but can lag live by whatever " +
      "has landed since the last pull. To measure LIVE production, hand the runner the prod Turso " +
      "creds out of 1Password (the item named in `db-pull-prod.ts`'s header) — `op` must be unlocked:",
  );
  lines.push("");
  lines.push("```sh");
  lines.push('TURSO_DATABASE_URL="$(op read "$FLUNCLE_TURSO_OP_ITEM/TURSO_DATABASE_URL")" \\');
  lines.push('  TURSO_AUTH_TOKEN="$(op read "$FLUNCLE_TURSO_OP_ITEM/TURSO_AUTH_TOKEN")" \\');
  lines.push(
    "  bun run --cwd apps/web scripts/measure-artifact-diversity.ts --out /tmp/sameness-report.md",
  );
  lines.push("```");
  lines.push("");

  lines.push("## Families, ranked most-homogenised first");
  lines.push("");
  lines.push("| family | artifacts | mean pairwise overlap | max pair | echoing |");
  lines.push("| ------ | --------: | --------------------: | -------: | ------: |");
  for (const reading of ranked) {
    lines.push(
      `| ${reading.family} | ${reading.size} | ${reading.meanPairwiseOverlap.toFixed(4)} | ${reading.maxPairwiseOverlap.toFixed(4)} | ${reading.echoingCount}/${reading.size} |`,
    );
  }
  lines.push("");

  lines.push("## The notes' known baseline");
  lines.push("");
  lines.push(
    `The shipped note counter-measure (the vibe-neighbour layer + the echo gate) cut **within-sonic-region** ` +
      `mean pairwise word overlap from **${NOTE_BASELINE.before}** to **${NOTE_BASELINE.after}** (roadmap; PR #502). ` +
      `That is an INTRA-REGION figure — a note against its ~6 nearest sonic neighbours — so it is a tighter scope than ` +
      `the whole-corpus means in the table above (every pair, no sonic filter), and the absolute numbers are not directly ` +
      `comparable. What IS comparable is the trajectory and the relative standing: the notes are the one family with a ` +
      `working rail, and any family measuring near or above them here without one is the priority.`,
  );
  lines.push("");

  lines.push("## Per-family detail");
  lines.push("");
  for (const reading of ranked) {
    lines.push(renderFamily(reading));
  }

  lines.push("## The honest read");
  lines.push("");
  lines.push(renderVerdict(readings));
  lines.push("");

  return lines.join("\n");
}

// A libsql cell as text. The columns read here are TEXT (log_id, note, body) or INTEGER
// (sector); anything else — a blob, a null — honestly becomes the fallback. Narrowing by
// typeof (rather than String(...)) is what satisfies oxlint's type-aware no-base-to-string:
// a raw `Value` may be an ArrayBuffer, whose default stringification is garbage.
function cellText(value: unknown, fallback: string): string {
  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number") {
    return String(value);
  }

  return fallback;
}

async function readCorpora(url: string): Promise<FamilyDiversity[]> {
  const authToken = process.env.TURSO_AUTH_TOKEN;
  const client = createClient(authToken ? { authToken, url } : { url });

  try {
    const notesRows = await client.execute(
      "SELECT log_id, note FROM findings WHERE note IS NOT NULL AND trim(note) != ''",
    );
    const notes: Artifact[] = notesRows.rows.map((row) => ({
      id: cellText(row.log_id, "?"),
      text: cellText(row.note, ""),
    }));

    const obsRows = await client.execute(
      "SELECT log_id, observation_script FROM findings WHERE observation_script IS NOT NULL AND trim(observation_script) != ''",
    );
    const observations: Artifact[] = obsRows.rows.map((row) => ({
      id: cellText(row.log_id, "?"),
      text: cellText(row.observation_script, ""),
    }));

    const logRows = await client.execute(
      "SELECT sector, body FROM logbook_entries WHERE body IS NOT NULL AND trim(body) != '' ORDER BY sector",
    );
    const logbook: Artifact[] = logRows.rows.map((row) => ({
      id: `sector ${cellText(row.sector, "?")}`,
      text: stripLogbookProse(cellText(row.body, "")),
    }));

    return [
      measureFamily("notes", notes),
      measureFamily("observations", observations),
      measureFamily("logbook", logbook),
    ];
  } finally {
    client.close();
  }
}

async function main(): Promise<void> {
  const url = resolveDbUrl();
  const readings = await readCorpora(url);
  const report = renderReport(readings, { db: dbLabel(url), when: new Date().toISOString() });

  const out = arg("--out");

  if (out) {
    writeFileSync(out, report, "utf8");
    console.error(`[measure-artifact-diversity] wrote ${out}`);
  }

  console.log(report);
}

if (import.meta.main) {
  await main();
}
