export const meta = {
  description:
    "Second-opinion pass over a triage round's medium/low-confidence dnb / not_dnb verdicts: an independent agent tries to REFUTE each one with fresh evidence; only verdicts that survive at high confidence are promoted to 'clear'",
  name: "label-dnb-verify",
  phases: [{ detail: "Refute-framed re-research, one agent per batch", title: "Verify" }],
};

const VERIFY_ITEM = {
  properties: {
    agrees: {
      description: "True when your own verdict matches the original bucket (dnb / not_dnb).",
      type: "boolean",
    },
    confidence: { enum: ["high", "medium", "low"], type: "string" },
    evidence: {
      description:
        "One line: the concrete NEW finding that confirmed or refuted the original (artists seen, Discogs styles, release titles). Never a restatement of the original evidence.",
      type: "string",
    },
    name: { type: "string" },
    slug: { type: "string" },
    verdict: { enum: ["dnb", "not_dnb", "unclear"], type: "string" },
  },
  required: ["slug", "name", "verdict", "confidence", "agrees", "evidence"],
  type: "object",
};

const VERDICTS = {
  properties: { verdicts: { items: VERIFY_ITEM, type: "array" } },
  required: ["verdicts"],
  type: "object",
};

const cfg = typeof args === "string" ? JSON.parse(args) : args;
const { file, enabled, disabled, total, batch } = cfg;
if (!file || !total) {
  throw new Error(`args did not resolve: ${JSON.stringify(cfg)?.slice(0, 200)}`);
}
if (!cfg.roundDir) {
  throw new Error("roundDir must name a durable round directory outside session scratch");
}
const manifest = `${cfg.roundDir}/manifest.jsonl`;
const shellPath = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
const evidenceCommand = (slice, count, census = false) =>
  `\`fluncle admin labels evidence <mb_label_id> [<mb_label_id> ...]${census ? " --census" : ""} --out ${shellPath(`${cfg.roundDir}/${slice}`)} --manifest ${shellPath(manifest)} --timeout ${Math.min(540, 240 * count)}\` (repo root; use \`bun apps/cli/src/cli.ts admin labels evidence …\` when the installed CLI predates batch evidence)`;

const starts = [];
for (let s = 0; s < total; s += batch) {
  starts.push(s);
}

const CONCURRENCY = Math.max(1, Number(cfg.concurrency) || 6);
const pooled = async (thunks) => {
  const out = Array.from({ length: thunks.length }, () => null);
  let next = 0;
  const lane = async () => {
    while (next < thunks.length) {
      const i = next++;
      out[i] = await thunks[i]().catch(() => null);
    }
  };
  await parallel(Array.from({ length: Math.min(CONCURRENCY, thunks.length) }, () => lane));

  return out;
};

const EVIDENCE_PATIENCE = `Run ONE command for all MBIDs in your slice, in the foreground, with the Bash tool timeout 600000. The CLI fetches labels serially under shared source limiters and writes complete evidence files atomically. If the tool hands back a running task, use its blocking completion tool until it ends. Read the printed text summaries first; open a saved JSON with the file-read tool only for fields your ruling needs. Use the printed manifest paths, not jq/Python shape exploration or evidence-file polling. Single-label calls default to 240 s; this batch allows 240 s per label, capped at 540 s so its exit-124 deadline precedes the 600 s tool timeout. Exit 124 or a failed manifest entry means collection is incomplete: return that fact to the coordinator to resume from cache at lower concurrency before any verdict. A collection failure is not an \`unclear\` genre ruling.`;

const EVIDENCE_SHAPE = `JSON shape: top-level \`label\`, \`fetchedAt\`, \`ok\`, \`partial\`, \`requests\`, \`errors\`, \`sources\`. Source reports live at \`sources.<name>\` for \`apple\`, \`beatport\`, \`discogs\`, \`musicbrainz\`; status is \`ok|partial|error|no_link|not_configured|skipped\`. \`data\`, \`errors\`, \`note\`, \`cached\` may be absent. Nullable: MB label area/country/disambiguation/type/labelCode and lifeSpan begin/end; MB release barcode/catno/date/format/status; census caveat; Discogs parentLabel and release catno/format/year. Unmatched Apple releases omit genre/artist/title fields. Read \`sources.musicbrainz.data.census.firstCredits\` for counts, \`recordingsCounted\` for the denominator, and \`sources.musicbrainz.data.label.labelRelations\` for imprints.`;

const brief = (
  start,
) => `You are the SECOND OPINION on crawl-seed label verdicts for **Fluncle**, a drum & bass archive. A first researcher already ruled each label below \`dnb\` or \`not_dnb\` at medium or low confidence. Fluncle's crawler only STORES tracks from \`enabled\` (dnb) labels, so a wrong "dnb" pollutes a public DnB archive and a wrong "not_dnb" silently loses good music. Your job is to TRY TO REFUTE each verdict with evidence the first pass did not cite. Default to doubt: a verdict you cannot independently confirm stays unconfirmed.

## Read first
Read \`.agents/skills/fluncle-label-triage/references/worker-rulings.md\` (repo-relative) once with the file-read tool before your first label. It contains the standing rulings and DSP oracle ladder for this pass.

## Your slice
Read the JSON array at \`${file}\` and take **items [${start}, ${start + batch})** (0-indexed, may run past the end — just take what exists). Each item has \`name\`, \`slug\`, \`mb_label_id\` (the EXACT MusicBrainz entity — never research a same-named label), the first pass's \`verdict\`, \`confidence\`, \`evidence\` and \`notable\`.

## Calibrate to the operator's real boundary
- Already ENABLED (DnB, in scope): read \`${enabled}\`
- Already DISABLED (out of scope): read \`${disabled}\`
Read BOTH before judging. Majors, subsidiaries, distributors and aggregators are OUT even when they carry DnB; DnB-specific media brands (Drum&BassArena, UKF, Knowledge) are IN; house/techno/trance/EDM/trap/dubstep/grime/UKG/pop/rock/jazz/reggae labels are OUT. Jungle and every DnB subgenre (liquid, neuro, jump-up, techstep, drumfunk, halftime, ragga jungle, jungletek-dominant) are IN.

## Method — look for what the first pass did NOT look at
1. **The evidence command with the census, once for your batch**: ${evidenceCommand(`verify-${start}`, Math.min(batch, total - start), true)}. The census reads first credits over up to five MusicBrainz pages (roughly 400 releases on a large label), far past the 25 releases a first pass usually read; the Beatport genre facet, Apple's genres and Discogs' per-release styles are the rungs a first pass most often skipped. Each source reports a \`status\` and its own \`errors\`. ${EVIDENCE_PATIENCE}

${EVIDENCE_SHAPE}
2. **Do not write fetchers.** Never curl MusicBrainz, Discogs, Beatport or Apple for anything the command returns: it holds the rate limits every worker shares, retries, and caches.
3. **The artists' own pages** when the first pass already cited the label's Discogs styles: \`firecrawl scrape <artist url>\` or WebFetch.
4. **Web** only for what is still open: the label's own Bandcamp / SoundCloud / RA bio.

## Rules
- \`agrees: true\` ONLY when you reach the same bucket from your OWN evidence. Restating the first pass's evidence is not confirmation.
- \`confidence: high\` ONLY when the catalogue is unambiguous on what you read — every (or nearly every) release in one lane, or a clear major/distributor/aggregator shape.
- A label whose MBID mixes two real labels' catalogues (conflation) is \`unclear\` when a DnB strand needs recovering, otherwise \`not_dnb\`; name the conflation.
- A label with too little evidence to call stays \`unclear\` / \`low\`. Do not rescue a guess with a better guess.
- A mixed label (meaningful DnB minority on an off-lane label, or a recurring off-lane act on a DnB label) is \`unclear\` here — the census pass handles carving, not you.

## Output
One entry per label via the structured schema. Do not write any files.`;

phase("Verify");

const model = cfg.model || "opus";
const results = await pooled(
  starts.map(
    (s) => () => agent(brief(s), { label: `verify ${s}-${s + batch}`, model, schema: VERDICTS }),
  ),
);
const verdicts = results.filter(Boolean).flatMap((r) => r.verdicts || []);
log(`verified ${verdicts.length}/${total}`);

const confirmed = verdicts.filter((v) => v.agrees && v.confidence === "high");
const counts = {
  confirmed: confirmed.length,
  confirmedDnb: confirmed.filter((v) => v.verdict === "dnb").length,
  confirmedNotDnb: confirmed.filter((v) => v.verdict === "not_dnb").length,
  refuted: verdicts.filter((v) => !v.agrees).length,
  total: verdicts.length,
  unsure: verdicts.filter((v) => v.agrees && v.confidence !== "high").length,
};
log(JSON.stringify(counts));
return { counts, verdicts };
