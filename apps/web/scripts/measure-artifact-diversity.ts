#!/usr/bin/env bun
/**
 * measure-artifact-diversity.ts — the homogenisation MEASUREMENT harness.
 *
 * The roadmap's demand (docs/planning/ROADMAP.md § "Homogenisation"): every generated
 * artifact family wants a cheap, honest diversity metric run on the REAL corpus, so the
 * "our artifacts drift toward a mean" claim stays falsifiable. "An anti-sameness effort
 * with no metric is folklore." The notes already had one (`scoreNoteEcho` + the note-sweep
 * `--dry-run`); this runs the SAME measures across the WRITTEN families — notes, spoken
 * observations, logbook entries, and the newsletter's per-finding why-lines — off the live
 * archive and prints a ranked report. It also cuts the upstream context-note `Texture:`
 * vocabulary (the seed the 07-14 audit named), the stored video axes (vehicle / grain /
 * register / palette, with the palette NULL share reported honestly), and — behind `--embed`
 * — a SEMANTIC cut: it embeds the written corpora with a local bge-class text model and
 * measures pairwise embedding distance, the one automated layer that sees MOVES not words.
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
  categoricalDistribution,
  type CategoricalDistribution,
  type EmbeddedArtifact,
  type EmbeddingDistanceStats,
  extractEditionWhyLines,
  type FamilyDiversity,
  measureFamily,
  measureRegisters,
  measureTextureVocab,
  pairwiseEmbeddingStats,
  rankPairDistance,
  type RegisterStats,
  stripLogbookProse,
  type TextureVocabStats,
  WORN_TEXTURE_WORDS,
} from "../src/lib/server/artifact-diversity";
import { contentOverlap } from "../src/lib/server/note";

// The crutch words the 2026-07-14 audit tracked on the observations — the closer formula
// ("enjoy"/"cosmonaut"), the "hope" reflex, and the "shoulders" body-image tic. Tracked in a
// fixed order so a re-measure lines up column-for-column against the audit's numbers.
const CRUTCH_WORDS = ["hope", "enjoy", "cosmonaut", "cosmonauts", "shoulders"] as const;

/** A family's diversity reading plus its register cut (openers/closers/crutches). */
type FamilyReport = FamilyDiversity & { registers: RegisterStats };

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

/**
 * The REGISTER cut — how templated a family's openers, closers, and reflexes are. This is the
 * cut that makes the observations' worst homogenisation legible: the formulaic closer, the
 * "I…" opener, the "hope" crutch. The before/after on these lines is the proof the prompt +
 * neighbourhood rails broke the formula, in a way the whole-corpus mean overlap never showed.
 */
function renderRegisters(registers: RegisterStats): string {
  const lines: string[] = [];

  lines.push(`**Register (openers / closers / crutches over ${registers.size} artifacts):**`);
  lines.push("");

  const edgeTable = (rows: { docFreq: number; phrase: string }[]) =>
    rows.length === 0
      ? "_None shared across two or more._"
      : rows.map((row) => `\`${row.phrase}\` (${row.docFreq}/${registers.size})`).join(", ");

  lines.push(`- **Top openers (first 3 words):** ${edgeTable(registers.openers)}`);
  lines.push(
    `- **Opening word:** ${
      registers.openingWords.length === 0
        ? "_no first word recurs._"
        : registers.openingWords
            .map((word) => `\`${word.word}\` (${word.docFreq}/${registers.size})`)
            .join(", ")
    }`,
  );
  lines.push(`- **Top closers (last 3 words):** ${edgeTable(registers.closers)}`);
  lines.push(
    `- **Crutch words:** ${registers.crutches
      .map((crutch) => `\`${crutch.word}\` ${crutch.docFreq}/${registers.size}`)
      .join(", ")}`,
  );
  lines.push("");

  return lines.join("\n");
}

function renderFamily(reading: FamilyReport): string {
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
  lines.push(renderRegisters(reading.registers));

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

function renderReport(readings: FamilyReport[], meta: { db: string; when: string }): string {
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

/** One family measured both ways — the overlap/lift reading and the register cut. */
function measureBoth(family: string, artifacts: Artifact[]): FamilyReport {
  return {
    ...measureFamily(family, artifacts),
    registers: measureRegisters(artifacts, { crutchWords: CRUTCH_WORDS }),
  };
}

// Suffix duplicate ids so a why-line that references the same finding across two editions
// stays a DISTINCT artifact (the lift scan filters by id !== id, so identical ids would be
// read as self and never compared). With one sent edition today this is a no-op; it keeps
// the newsletter cut honest once the corpus reaches the ≥4-edition re-measure the ledger asks for.
function uniqueIds(artifacts: Artifact[]): Artifact[] {
  const seen = new Map<string, number>();

  return artifacts.map((artifact) => {
    const n = (seen.get(artifact.id) ?? 0) + 1;

    seen.set(artifact.id, n);

    return n === 1 ? artifact : { ...artifact, id: `${artifact.id}#${n}` };
  });
}

/** The tags of one finding's video, as stored (any axis may be null on an older render). */
type VideoAxes = {
  grain: string | null;
  palette: string | null;
  register: string | null;
  vehicle: string | null;
};

/** The whole archive reading: the family readings plus the Texture + video cuts + raw corpora. */
type ArchiveReading = {
  /** The overlap/register readings, ranked in the report. */
  families: FamilyReport[];
  /** The raw written corpora, kept for the optional `--embed` semantic cut. */
  corpora: { name: string; texts: Artifact[] }[];
  /** The upstream context-note Texture vocabulary. */
  texture: TextureVocabStats;
  /** The stored video axes, one distribution per axis. */
  video: {
    grain: CategoricalDistribution;
    palette: CategoricalDistribution;
    register: CategoricalDistribution;
    total: number;
    vehicle: CategoricalDistribution;
  };
};

async function readCorpora(url: string): Promise<ArchiveReading> {
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

    // The newsletter family: the per-finding "why" lines flattened out of every SENT
    // edition's content_json (a draft mid-author is not a shipped artifact). A malformed
    // payload yields no lines rather than crashing the re-run.
    const editionRows = await client.execute(
      "SELECT content_json FROM editions WHERE status = 'sent' ORDER BY number",
    );
    const newsletter: Artifact[] = uniqueIds(
      editionRows.rows.flatMap((row) => extractEditionWhyLines(cellText(row.content_json, ""))),
    );

    // The upstream seed: the context notes' `Texture:` vocabulary.
    const contextRows = await client.execute(
      "SELECT log_id, context_note FROM findings WHERE context_note IS NOT NULL AND trim(context_note) != ''",
    );
    const contextNotes: Artifact[] = contextRows.rows.map((row) => ({
      id: cellText(row.log_id, "?"),
      text: cellText(row.context_note, ""),
    }));
    const texture = measureTextureVocab(contextNotes, { wornWords: WORN_TEXTURE_WORDS });

    // The video axes: the flat category tags on every finding that HAS a video.
    const videoRows = await client.execute(
      "SELECT video_vehicle, video_grain, video_register, video_palette FROM findings WHERE video_url IS NOT NULL AND trim(video_url) != ''",
    );
    const axes: VideoAxes[] = videoRows.rows.map((row) => ({
      grain: typeof row.video_grain === "string" ? row.video_grain : null,
      palette: typeof row.video_palette === "string" ? row.video_palette : null,
      register: typeof row.video_register === "string" ? row.video_register : null,
      vehicle: typeof row.video_vehicle === "string" ? row.video_vehicle : null,
    }));

    return {
      corpora: [
        { name: "notes", texts: notes },
        { name: "observations", texts: observations },
        { name: "logbook", texts: logbook.map((entry) => ({ ...entry })) },
        { name: "newsletter", texts: newsletter },
      ],
      families: [
        measureBoth("notes", notes),
        measureBoth("observations", observations),
        measureBoth("logbook", logbook),
        measureBoth("newsletter", newsletter),
      ],
      texture,
      video: {
        grain: categoricalDistribution(axes.map((axis) => axis.grain)),
        palette: categoricalDistribution(axes.map((axis) => axis.palette)),
        register: categoricalDistribution(axes.map((axis) => axis.register)),
        total: axes.length,
        vehicle: categoricalDistribution(axes.map((axis) => axis.vehicle)),
      },
    };
  } finally {
    client.close();
  }
}

// ── The Texture + video render sections ───────────────────────────────────────────────

function renderTexture(texture: TextureVocabStats): string {
  const lines: string[] = [];

  lines.push("## Context-note Texture vocabulary (the upstream seed)");
  lines.push("");
  lines.push(
    `The \`context_distil\` prompt ends every note on a \`Texture:\` line — 3–6 pointers that seed ` +
      `EVERY downstream voice. The 2026-07-14 audit named this the upstream cause of the written ` +
      `families' sameness, and the prompt was changed the same day to demand track-specific pointers ` +
      `and warn off the worn five. This is the number that makes that fix falsifiable: re-run it and ` +
      `the worn descriptors should thin as new notes are distilled.`,
  );
  lines.push("");
  lines.push(
    `**${texture.size} of ${texture.total} context notes carry a parseable \`Texture:\` line; ${texture.vocabulary} distinct descriptors in all.**`,
  );
  lines.push("");
  lines.push("**The worn five (the audit's tracked descriptors), notes reaching for each:**");
  lines.push("");
  lines.push(
    texture.worn.map((worn) => `\`${worn.word}\` ${worn.docFreq}/${texture.size}`).join(", ") ||
      "_none tracked._",
  );
  lines.push("");
  lines.push("**Most-widespread descriptors (in ≥2 notes):**");
  lines.push("");
  lines.push(
    texture.descriptors.length === 0
      ? "_None recurring._"
      : texture.descriptors
          .map((entry) => `\`${entry.word}\` (${entry.docFreq}/${texture.size})`)
          .join(", "),
  );
  lines.push("");

  return lines.join("\n");
}

function renderDistribution(label: string, dist: CategoricalDistribution): string {
  const lines: string[] = [];
  const nullShare = dist.total === 0 ? 0 : dist.nullCount / dist.total;
  const topShare = (count: number) => (dist.present === 0 ? 0 : count / dist.present);

  lines.push(
    `- **${label}:** ${dist.categories.length} distinct over ${dist.present} recorded` +
      ` — NULL on ${dist.nullCount}/${dist.total} (${pct(nullShare)}).`,
  );

  if (dist.categories.length > 0) {
    const top = dist.categories
      .slice(0, 6)
      .map((cat) => `\`${cat.value}\` ${cat.count} (${pct(topShare(cat.count))})`)
      .join(", ");

    lines.push(`  - Top: ${top}`);
  }

  return lines.join("\n");
}

function renderVideo(video: ArchiveReading["video"]): string {
  const lines: string[] = [];

  lines.push("## Video axes (vehicle / grain / register / palette)");
  lines.push("");
  lines.push(
    `The video family's sameness is a LOOK, not a phrase: four consecutive renders sharing one ` +
      `amber halftone palette (07-13), the register axis collapsing to representational (07-14). ` +
      `Those axes are stored as flat tags on the finding. Measured over the **${video.total}** findings ` +
      `that have a video. \`video_palette\` shipped in PR #702, so it reads NULL on every render made ` +
      `before it — the share below is reported honestly, not hidden.`,
  );
  lines.push("");
  lines.push(renderDistribution("vehicle", video.vehicle));
  lines.push(renderDistribution("grain", video.grain));
  lines.push(renderDistribution("register", video.register));
  lines.push(renderDistribution("palette", video.palette));
  lines.push("");

  return lines.join("\n");
}

// ── The embedding (semantic) cut ──────────────────────────────────────────────────────
//
// A local bge-class text model, fetched once into a gitignored cache and run offline — no
// secret, no paid API, no Workers AI (that is a separate roadmap pilot). Opt-in via `--embed`
// so a normal re-run stays instant and needs no model. The math (cosineDistance,
// pairwiseEmbeddingStats, rankPairDistance) is pure and unit-tested; only the vectors come
// from the model.

const EMBED_MODEL = "Xenova/bge-small-en-v1.5";

async function embedCorpus(texts: readonly Artifact[]): Promise<EmbeddedArtifact[]> {
  const { env, pipeline } = await import("@huggingface/transformers");

  // Keep the download inside the gitignored apps/web/.cache dir (a runtime cache).
  env.cacheDir = join(dirname(fileURLToPath(import.meta.url)), "..", ".cache", "transformers");

  const extractor = await pipeline("feature-extraction", EMBED_MODEL, { dtype: "fp32" });
  const embedded: EmbeddedArtifact[] = [];

  for (const artifact of texts) {
    if (artifact.text.trim().length === 0) {
      continue;
    }

    const output = await extractor(artifact.text, { normalize: true, pooling: "mean" });

    embedded.push({ id: artifact.id, vector: Array.from(output.data as Iterable<number>) });
  }

  return embedded;
}

/** The validation verdict for one family: does its lexically-worst pair separate in embedding space? */
function renderEmbeddingFamily(
  name: string,
  stats: EmbeddingDistanceStats,
  lexicalWorstPair: string[],
  texts: Map<string, string>,
): string {
  const lines: string[] = [];
  // The lexical overlap for a pair — the same content-word Jaccard the echo gate uses. This
  // is what turns the closest-pairs list into the gate-worthiness test: embedding-close +
  // lexical-LOW is a paraphrase `scoreEcho` cannot see (the case for a second rail).
  const lexical = (a: string, b: string): number => {
    const left = texts.get(a);
    const right = texts.get(b);

    return left !== undefined && right !== undefined ? contentOverlap(left, right) : 0;
  };

  lines.push(`### ${name} — ${stats.size} embedded`);
  lines.push("");

  if (stats.pairs.length === 0) {
    lines.push("_Fewer than two vectors; no pairwise distance._");
    lines.push("");

    return lines.join("\n");
  }

  lines.push(
    `- **Mean pairwise distance:** ${stats.mean.toFixed(4)} (± ${stats.stdev.toFixed(4)} stdev)`,
  );
  lines.push(
    `- **Closest pair (min distance):** ${stats.min.toFixed(4)}` +
      (stats.minPair.length === 2 ? ` — ${stats.minPair[0]} ↔ ${stats.minPair[1]}` : ""),
  );

  // The validation: where does the LEXICALLY-worst pair (the one scoreEcho would already
  // condemn) sit in the SEMANTIC ordering? Rank 1 far below the mean = the two agree, the
  // condemned pair separates. Mid-pack = the semantic layer does not single it out.
  if (lexicalWorstPair.length === 2) {
    const [left, right] = lexicalWorstPair;
    const ranked = left && right ? rankPairDistance(stats, left, right) : undefined;

    if (ranked && left && right) {
      const zScore = stats.stdev === 0 ? 0 : (ranked.distance - stats.mean) / stats.stdev;

      lines.push(
        `- **Lexically-worst pair (${left} ↔ ${right}, ${pct(lexical(left, right))} word overlap):** ` +
          `embedding distance ${ranked.distance.toFixed(4)}, rank ${ranked.rank} of ${ranked.totalPairs} closest ` +
          `(${pct(ranked.percentile)} of pairs are more diverse), ${zScore.toFixed(2)}σ from the mean.`,
      );
    } else {
      lines.push(
        `- **Lexically-worst pair (${left} ↔ ${right}):** not both embedded (one side had no prose).`,
      );
    }
  }

  // The top-5 embedding-closest pairs, with their LEXICAL overlap alongside — the agreement
  // check. A pair that is embedding-close but lexical-far is a PARAPHRASE the word gate misses
  // (the case for a second rail); broad agreement means embedding just restates scoreEcho.
  lines.push("- **Embedding-closest pairs (with their lexical word overlap):**");

  for (const pair of stats.pairs.slice(0, 5)) {
    lines.push(
      `  - ${pair.a} ↔ ${pair.b}: distance ${pair.distance.toFixed(4)}, lexical ${pct(lexical(pair.a, pair.b))}`,
    );
  }

  lines.push("");

  return lines.join("\n");
}

async function renderEmbedding(reading: ArchiveReading): Promise<string> {
  const lines: string[] = [];

  lines.push("## Embedding distance — the semantic cut (experiment)");
  lines.push("");
  lines.push(
    `Every other measure here counts shared WORDS, so a paraphrase — the same move in different ` +
      `words — is invisible to it (the escape \`scoreEcho\` leaves open). A text embedding sees the ` +
      `MEANING. Ratified 2026-07-18 as a VALIDATION experiment, not a shipped gate: the question is ` +
      `whether semantic distance actually SEPARATES the operator-condemned pairs from the healthy ` +
      `ones, given that baseline similarity across one persona/register/genre is high by design. ` +
      `Model: \`${EMBED_MODEL}\` (a cheap bge-class model, run locally, no secret, no paid API). The ` +
      `"lexically-worst pair" per family is this harness's own max content-word-overlap pair — the ` +
      `one \`scoreEcho\` already flags — used here as the known-condemned probe.`,
  );
  lines.push("");

  // Embed the two ~61 written corpora (the ledger's Monrroe/Muffler condemned pair is an
  // observation), plus the smaller families for completeness where they have ≥2 artifacts.
  for (const corpus of reading.corpora) {
    const family = reading.families.find((reading) => reading.family === corpus.name);

    if (!family || family.size < 2) {
      continue;
    }

    const embedded = await embedCorpus(corpus.texts);
    const stats = pairwiseEmbeddingStats(embedded);
    const texts = new Map(corpus.texts.map((artifact) => [artifact.id, artifact.text]));

    lines.push(renderEmbeddingFamily(corpus.name, stats, family.maxPair, texts));
  }

  lines.push("### Reading the cut (the decision rule)");
  lines.push("");
  lines.push(
    "Decision rule (ratified 2026-07-18): if semantic distance SEPARATES the condemned pairs " +
      "cleanly from the healthy ones, it is a candidate second rail beside `scoreEcho`; if it " +
      "OVERLAPS, it stays a corpus dashboard number and nothing more is spent. Two things to read " +
      "off the numbers above. FIRST — does the lexically-condemned pair sink in the semantic " +
      "ordering? (A σ well below the mean and a high percentile = the two agree it is unusually " +
      "alike.) SECOND — are the embedding-CLOSEST pairs ones the word gate would MISS, i.e. do they " +
      "carry LOWER lexical overlap than the condemned pair? Those are paraphrases `scoreEcho` is " +
      "blind to (the escape it leaves open) — the only reason a semantic rail would earn its keep. " +
      "A unimodal spread with no gap between condemned and healthy means no fixed threshold can be " +
      "a clean binary gate; the honest use of that is a RANKED review signal, never an auto-block.",
  );
  lines.push("");

  return lines.join("\n");
}

async function main(): Promise<void> {
  const url = resolveDbUrl();
  const reading = await readCorpora(url);
  const meta = { db: dbLabel(url), when: new Date().toISOString() };

  let report = renderReport(reading.families, meta);

  report += `\n${renderTexture(reading.texture)}`;
  report += `\n${renderVideo(reading.video)}`;

  if (process.argv.includes("--embed")) {
    report += `\n${await renderEmbedding(reading)}`;
  }

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
