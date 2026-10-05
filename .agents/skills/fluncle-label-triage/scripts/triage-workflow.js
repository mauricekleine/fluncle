export const meta = {
  description:
    "Classify Fluncle's undecided crawl-seed labels as DnB / not DnB / unclear, and census the mixed ones into artist-rule proposals",
  name: "label-dnb-triage",
  phases: [
    { detail: "MusicBrainz + Discogs + web per label batch", title: "Research" },
    { detail: "First-credit census of the mixed labels → artist-rule proposals", title: "Census" },
  ],
};

const RULE_ITEM = {
  properties: {
    artistMbid: {
      description: "The MusicBrainz artist MBID (a UUID). The match key — never a name.",
      type: "string",
    },
    artistName: {
      description: "Credited spelling at proposal time (display only).",
      type: "string",
    },
    evidence: {
      description:
        "One line naming what was seen: the releases/recordings this act is FIRST-credited on, and why they are in or out of lane.",
      type: "string",
    },
    firstCreditCount: {
      description:
        "How many censused recordings this MBID is the FIRST credited artist on. Zero means the rule can never fire — do not propose it.",
      type: "number",
    },
    verdict: { enum: ["allow", "block"], type: "string" },
  },
  required: ["artistMbid", "artistName", "verdict", "evidence", "firstCreditCount"],
  type: "object",
};

const CONFLATION = {
  properties: {
    dnbStrandWorthRecovering: {
      description:
        "True when one of the conflated labels IS a drum & bass / jungle catalogue Fluncle would crawl once separated. False when the entity is broken but no strand is in lane.",
      type: "boolean",
    },
    keep: {
      description:
        "The strand that should remain on this MBID: name it with its catalogue-number scheme and the evidence that ties it there.",
      type: "string",
    },
    moveOut: {
      description:
        "The foreign release(s) to move, each with its catalogue number, artist, year and the evidence that it belongs elsewhere.",
      type: "string",
    },
    trap: {
      description:
        "Optional: anything that makes the obvious move BACKWARDS — the entity's own metadata or Discogs url-rel describing the strand being moved out, a third same-named label, or a reverse split where the in-lane half is the one that must move.",
      type: "string",
    },
  },
  required: ["dnbStrandWorthRecovering", "keep", "moveOut"],
  type: "object",
};

const VERDICT_ITEM = {
  properties: {
    confidence: { enum: ["high", "medium", "low"], type: "string" },
    conflation: CONFLATION,
    evidence: {
      description:
        "One line: the concrete finding that decided it (artists seen, Discogs styles, release titles).",
      type: "string",
    },
    name: { type: "string" },
    needsCensus: {
      description:
        "True when the label is MIXED — part in lane, part out — so a first-credit census should decide whether artist rules can carve the boundary. Phase 1 only.",
      type: "boolean",
    },
    notable: {
      description:
        "Up to 4 representative artists or releases, comma separated. Empty if none found.",
      type: "string",
    },
    slug: { type: "string" },
    verdict: { enum: ["dnb", "dnb_partial", "not_dnb", "unclear"], type: "string" },
  },
  required: ["slug", "name", "verdict", "confidence", "evidence"],
  type: "object",
};

const VERDICTS = {
  properties: { verdicts: { items: VERDICT_ITEM, type: "array" } },
  required: ["verdicts"],
  type: "object",
};

const CENSUS_ITEM = {
  properties: {
    ...VERDICT_ITEM.properties,
    censusSummary: {
      description:
        "What the census counted: releases and recordings read, pages fetched, the in-lane vs off-lane FIRST-credit split, and the SAMPLING CAVEAT verbatim when the page cap was hit.",
      type: "string",
    },
    globalSuggestion: {
      description:
        "Optional prose only: an act the operator may want to rule GLOBALLY (never/always their records, anywhere). Never machine-applied — he authors globals by hand.",
      type: "string",
    },
    imprintChild: {
      description:
        "What ?inc=label-rels showed: an existing MusicBrainz imprint/child label covering the boundary (name it — then propose NO rules), or 'none'.",
      type: "string",
    },
    offLaneFirstCreditShare: {
      description:
        "RAW off-lane share of censused FIRST credits, 0–1 — every off-lane credit, whether or not a global rule already stops it. This is the rail: above 0.15 the label is not mainly in lane, so it is never dnb — dnb_partial or not_dnb, unclear only in the straddle case.",
      type: "number",
    },
    residualNote: {
      description:
        "Required when residualOffLaneShare ≤ 0.15 < offLaneFirstCreditShare: name the globally-ruled acts that account for the gap and their credit counts, so the operator can judge the split himself.",
      type: "string",
    },
    residualOffLaneShare: {
      description:
        "Off-lane share counting ONLY credits that would still arrive — drop every credit whose artist already carries a GLOBAL rule in the calibration list. Equals the raw share when no off-lane act is globally ruled. Reported, never a rail.",
      type: "number",
    },
    rules: { items: RULE_ITEM, type: "array" },
  },
  required: ["slug", "name", "verdict", "confidence", "evidence", "censusSummary"],
  type: "object",
};

const CENSUS = {
  properties: { verdicts: { items: CENSUS_ITEM, type: "array" } },
  required: ["verdicts"],
  type: "object",
};

const cfg = typeof args === "string" ? JSON.parse(args) : args;
const { file, enabled, disabled, rules, total, batch } = cfg;
if (!file || !total) {
  throw new Error(`args did not resolve: ${JSON.stringify(cfg)?.slice(0, 200)}`);
}
const CENSUS_BATCH = Number(cfg.censusBatch) || 5;
const starts = [];
for (let s = 0; s < total; s += batch) {
  starts.push(s);
}

// Every worker's evidence calls queue on ONE MusicBrainz limiter (about a request a second,
// shared across processes), so more simultaneous workers add no throughput: each call just
// waits longer, until the worker's shell times out first and the label comes back unread.
// Lanes cap how many workers run at once; the rest start as lanes free up.
const CONCURRENCY = Math.max(1, Number(cfg.concurrency) || 6);
const pooled = async (thunks) => {
  const out = new Array(thunks.length).fill(null);
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

const SKILL_PATH = ".agents/skills/fluncle-label-triage/SKILL.md";

const READ_FIRST = `## Read first
Read \`${SKILL_PATH}\` (repo-relative) before your first label. Its standing rulings and its DSP oracle ladder bind this pass and are not repeated here.`;

const EVIDENCE_COMMAND = `\`fluncle admin labels evidence <mb_label_id> --json\` (run from the repo root; when the installed \`fluncle\` lacks the command, use \`bun apps/cli/src/cli.ts admin labels evidence …\`)`;

const EVIDENCE_PATIENCE = `The command waits its turn on a MusicBrainz rate limit shared by every worker, so one call can take minutes while other workers are busy. Run it with the Bash tool's \`timeout\` at 600000. A call that times out is a queue, not evidence: re-run it, and every source it already fetched comes back from cache. Never rule a label \`unclear\` because the command had not returned.`;

const NO_FETCHERS = `**Do not write fetchers.** Never curl MusicBrainz, Discogs, Beatport or Apple for what the evidence command returns: it shares rate limits across workers, retries and caches. Re-run it instead (\`--refresh\` skips the cache).`;

const RULE_PRECEDENT = rules
  ? `- Artist rules already RATIFIED (the precedent for any rule you propose): read \`${rules}\`\n`
  : "";

const brief = (
  start,
) => `You are triaging crawl-seed labels for **Fluncle**, a drum & bass archive. Fluncle's catalogue crawler only STORES tracks from labels the operator marks \`enabled\`, so your verdict decides whether a label's releases enter a DnB archive. A wrong "dnb" pollutes the catalogue with off-genre music; a wrong "not_dnb" silently loses good music. Be accurate over decisive.

${READ_FIRST}

## Your slice
Read the JSON array at \`${file}\` and take **items [${start}, ${start + batch})** (0-indexed, may run past the end — just take what exists). Each item has \`name\`, \`slug\`, \`mb_label_id\` (a MusicBrainz label MBID that identifies the EXACT entity — never research a same-named label), and \`rules\` (artist rules this label ALREADY carries — read them; they are the operator's standing exceptions for it).

## Calibrate to the operator's real boundary
- Already ENABLED (DnB, in scope): read \`${enabled}\`
- Already DISABLED (out of scope): read \`${disabled}\`
${RULE_PRECEDENT}Read BOTH lists before judging. Note the pattern: DnB labels of any size are in; **majors, their subsidiaries, distributors and aggregators are OUT even when they carry DnB** (e.g. Believe, BBE, Beggars, Boiler Room, Atlantic, BMG are disabled), as are house/techno/trance/EDM/trap/pop/rock/jazz/reggae/world labels.

## Buckets
- **dnb** — predominantly drum & bass or jungle, including subgenres: liquid, neurofunk, jump-up, techstep, drumfunk, halftime, ragga jungle, darkside. A DnB-dominant label counts even if it releases the odd other thing.
- **not_dnb** — clearly another genre, OR a major/subsidiary/distributor/aggregator/reissue-house/compilation mill. NOTE the ratified media-brands rule (2026-07-26): a DnB-SPECIFIC media brand that presses/releases DnB (a magazine's cover-mount imprint, a DnB platform's label arm — the Knowledge Magazine / Drum&BassArena / UKF class, all enabled) is **dnb**; GENERAL dance media (the DJ Magazine class, disabled) is not_dnb.
- **unclear** — too little evidence exists to call it: no rung of the oracle ladder answers (tiny/defunct/no web presence). A mixed-genre label with a real DnB minority is NOT unclear: flag it for the census (below), which carves it into \`dnb\`, \`dnb_partial\` or \`not_dnb\`.
- **MB entity CONFLATION** — the MBID's release list mixes two or more real labels. Enabling crawls BY MBID, so an enable imports every strand. Name the conflation in your evidence, then: when one strand is a drum & bass / jungle catalogue (a UK DnB label's MBID also carrying a Swedish rock label's albums — a measured case), return **unclear** and fill the \`conflation\` object, because the fix is an upstream MusicBrainz split that unblocks a crawl seed. When NO strand is in lane, return **not_dnb**: every catalogue the MBID would crawl is off-lane, so disabling it loses nothing (measured: 11 of 11 conflations in one week held no DnB strand, and the operator disabled all 11).

## The MIXED flag — \`needsCensus\`
Fluncle can now carve a mixed label with per-artist FIRST-CREDIT exceptions: keep a label enabled but **block** the acts whose own records are off-lane, or keep it disabled and **allow** the DnB acts whose records deserve the archive. You are NOT doing that census — set \`needsCensus: true\` and give your best provisional verdict, and a second pass counts the label properly.

Set \`needsCensus: true\` when the label is genuinely two-sided: mostly DnB with a recurring off-lane act (provisional \`dnb\`), or mostly off-lane with a real DnB minority worth taking (provisional \`dnb_partial\`). Do NOT set it for a clean call either way, for a conflated MBID (ruled by the conflation bullet above), or for a label with too little evidence to count.

## Method (in order, stop when confident)
1. **The evidence command, once per label**: ${EVIDENCE_COMMAND}. It returns the MusicBrainz label and a first-credit release sample (the ARTISTS are the strongest genre signal; MB \`tags\`/\`genres\` are usually empty), Discogs per-release styles, Beatport's genre facet and Apple's genre for sampled barcodes. ${EVIDENCE_PATIENCE} Each source carries a \`status\` and its own \`errors\`; \`no_link\` means the MB entity links no page on that site, and Discogs \`candidates\` there are unverified name matches.
2. ${NO_FETCHERS}
3. **Web** only for what the evidence leaves open: \`firecrawl search "<label name> drum and bass label"\` or WebSearch, the label's own site, Bandcamp, RA, Juno.

## Output
Return one entry per label in your slice via the structured schema. \`evidence\` must cite what you actually saw (artist names, Discogs styles, release titles) — never a guess restated. If a label had no findable evidence, say so and mark it \`unclear\` with \`low\` confidence. Do not write any files.`;

const censusBrief = (
  slice,
) => `You are running the **first-credit census** on mixed crawl-seed labels for **Fluncle**, a drum & bass archive. Phase 1 flagged these labels as two-sided: part in lane, part out. Your job is to count the label exactly and decide whether per-artist exceptions can carve the boundary — or whether it stays a judgment call for the operator.

## Your labels
${slice.map((v) => `- **${v.name}** (slug \`${v.slug}\`) — phase-1 read: ${v.verdict} / ${v.confidence}. ${v.evidence}`).join("\n")}

Look each slug up in the JSON array at \`${file}\` for its \`mb_label_id\` (the EXACT MusicBrainz entity — never census a same-named label) and its \`rules\` (exceptions the label ALREADY carries; a proposal must account for them, and your rule set REPLACES them wholesale).

## The model you are proposing into
\`seed_state\` is the label-level default; an artist rule is an EXCEPTION to it, and it fires on **the FIRST credited MusicBrainz artist of a track** — never on a guest credit, never on a name.

- **enabled + block** — the label is mainly in lane, so enable it, and block the acts whose OWN records are off-lane. Their guest features on the label's DnB tracks still come in (that is measured behaviour, not a hope).
- **disabled + allow** (\`dnb_partial\`) — the label is mainly off-lane, so it stays disabled, and the DnB acts' own records are allowed in. Nothing else from the label arrives.

${READ_FIRST}

## Evidence
Run ${EVIDENCE_COMMAND.replace("--json", "--census --json")} once per label. ${EVIDENCE_PATIENCE} \`musicbrainz.data.census\` counts FIRST credits per artist MBID over DISTINCT recordings exactly as the crawler's artist rules read them (the recording's credit, else the release's; the first entry with an MBID that is not Various Artists), 5-page cap, sampling caveat in \`caveat\`; \`musicbrainz.data.label.labelRelations\` is the imprint check. ${NO_FETCHERS} Artist-level lookups the command does not cover (an act's own catalogue, its Spotify url-rel) may call MusicBrainz directly: \`sleep 1.2\` between calls and always send \`User-Agent: FluncleLabelTriage/1.0 ( https://www.fluncle.com )\`.

## Non-negotiable rails
1. **Imprint child first.** Read \`labelRelations\` in the evidence. If MusicBrainz already models the boundary as a child imprint / sub-label (a DnB imprint of a bigger house), say so in \`imprintChild\` and **propose no rules** — the right move is to rule that MB entity, not to hand-carve artists. Otherwise \`imprintChild: "none"\`.
2. **The 15% share test, measured RAW.** Compute \`offLaneFirstCreditShare\` = off-lane FIRST credits ÷ censused recordings, counting **every** off-lane credit. **≤ 0.15 ⇒ \`dnb\` + block rules.** Above it the label is not mainly DnB, so it is never enabled: return \`dnb_partial\` + allow rules for every in-lane act with first credits, or \`not_dnb\` when the in-lane credits are incidental (a one-off remix, a single compilation track, no act with its own DnB run). Return \`unclear\` only in the straddle case (2b) or when the census caveat leaves the share unreliable. Raw is the rail because enabling a label is a standing commitment to what it releases NEXT, which no existing rule covers.
2b. **Also report the RESIDUAL share, which is never a rail.** Recompute the same fraction dropping every off-lane credit whose artist already carries a **global** rule in the calibration list, and put it in \`residualOffLaneShare\`. When the two straddle the threshold (\`residual ≤ 0.15 < raw\`), the label is the operator's judgment call: return \`unclear\` and fill \`residualNote\` with the globally-ruled acts and their counts. Measured type specimen: a label at 0.205 raw and 0.147 residual, the gap being two acts already globally blocked. Do not let the residual change your verdict — it changes only whether he is shown the label by name.
3. **No inert rules.** A proposed rule needs \`firstCreditCount > 0\` on YOUR census. An act you only ever see as a guest credit can never trigger a first-credit rule — leave it out and say so in the evidence if it matters. (Measured case: Maddslinky on Gutterfunk, 0 first credits, an intuitive block that would never have fired.)
4. **One act is often several MBIDs.** Collaboration entities are separate MusicBrainz artists: "DJ Die" and "DieMantle" are different MBIDs, and on the measured census DJ Die alone was 44/130 first credits while DJ Die + DieMantle was 57/130. Expand every act you rule on into ALL the entities it is first-credited under, and give each its own rule row with its own count. A missed collaboration entity under-imports; it never mis-imports.
5. **Conflation is never carved with rules.** If the MBID mixes two real labels, name the conflation and propose no rules. When no strand is in lane, return \`not_dnb\`. When one is, return \`unclear\` — the fix is an upstream MusicBrainz entity split — and FILL THE \`conflation\` OBJECT, because the split brief is generated from it: which strand stays (with its catalogue-number scheme), which releases move (with catalogue numbers, artists, years), whether a drum & bass catalogue is trapped inside worth recovering, and any \`trap\` that makes the obvious move backwards. Traps are common and each one has bitten a real edit: the entity's own area/url-rel can describe the strand being MOVED OUT rather than the one kept, a third same-named label can exist, and sometimes the in-lane half is the one that must move (a single DnB album sitting inside a foreign publisher's entity).
6. **Globals are the operator's.** If an act deserves a rule EVERYWHERE (not just on this label), write it as prose in \`globalSuggestion\`. Never propose it as a rule row — global rules are authored by hand.
7. **Same alias, different act.** Two acts can share a name. Verify each MBID's own release list before you rule it.

## The census
- Take the counts from \`census.firstCredits\`; \`recordingsCounted\` is the denominator, and it includes \`uncreditedRecordings\` (stored under the label default, never matched by a rule). When \`caveat\` is set the census is a SAMPLE: copy it verbatim into \`censusSummary\` and drop your confidence a step.
- Judge each recurring first-credit act in or out of lane on its OWN catalogue (its MB releases, its Discogs styles), not on the label's average.
- Report the totals in \`censusSummary\`: releases read, recordings counted, pages fetched (all in the census object), in-lane vs off-lane first credits, and what a rule set would take vs drop.

## Output
One entry per label via the structured schema. \`rules\` is empty unless you are proposing exceptions, and every rule carries its own \`evidence\` + \`firstCreditCount\`. Do not write any files.`;

phase("Research");
const results = await pooled(
  starts.map(
    (start) => () =>
      agent(brief(start), {
        effort: "medium",
        label: `labels ${start}-${Math.min(start + batch, total) - 1}`,
        model: "opus",
        phase: "Research",
        schema: VERDICTS,
      }),
  ),
);

const all = results.filter(Boolean).flatMap((r) => r.verdicts || []);

const mixed = all.filter((v) => v.needsCensus === true);
const censusStarts = [];
for (let s = 0; s < mixed.length; s += CENSUS_BATCH) {
  censusStarts.push(s);
}
log(`census queue: ${mixed.length} mixed label(s) in ${censusStarts.length} slice(s)`);

let censused = [];
if (mixed.length > 0) {
  phase("Census");
  const censusResults = await pooled(
    censusStarts.map((start) => {
      const slice = mixed.slice(start, start + CENSUS_BATCH);

      return () =>
        agent(censusBrief(slice), {
          effort: "high",
          label: `census ${slice.map((v) => v.slug).join(", ")}`,
          model: "opus",
          phase: "Census",
          schema: CENSUS,
        });
    }),
  );
  censused = censusResults.filter(Boolean).flatMap((r) => r.verdicts || []);
}

const censusedBySlug = new Map(censused.map((v) => [v.slug, v]));
const final = all.map((v) => censusedBySlug.get(v.slug) ?? v);
const by = (v) => final.filter((x) => x.verdict === v);
const ruleCount = final.reduce((n, v) => n + (v.rules?.length || 0), 0);
log(
  `triaged ${final.length}/${total} — dnb=${by("dnb").length} dnb_partial=${by("dnb_partial").length} not_dnb=${by("not_dnb").length} unclear=${by("unclear").length}; ${ruleCount} artist rule(s) proposed across ${final.filter((v) => v.rules?.length).length} label(s)`,
);

return {
  counts: {
    censused: censused.length,
    dnb: by("dnb").length,
    dnb_partial: by("dnb_partial").length,
    not_dnb: by("not_dnb").length,
    rules: ruleCount,
    total: final.length,
    unclear: by("unclear").length,
  },
  dnb: by("dnb"),
  dnb_partial: by("dnb_partial"),
  not_dnb: by("not_dnb"),
  unclear: by("unclear"),
};
