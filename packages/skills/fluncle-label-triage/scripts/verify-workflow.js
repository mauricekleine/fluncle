export const meta = {
  description:
    "Second-opinion pass over a triage round's medium/low-confidence dnb / not_dnb verdicts: an independent agent tries to REFUTE each one with fresh evidence; only verdicts that survive at high confidence are promoted to 'clear'",
  name: "label-dnb-verify",
  phases: [{ detail: "Refute-framed re-research, one agent per batch", title: "Verify" }],
};

// ── Output shape ─────────────────────────────────────────────────────────────────────────────
// One entry per label. `agrees` is the load-bearing bit: the verifier reached the SAME bucket
// independently. A promoted verdict needs agrees=true AND confidence=high; everything else stays
// for the operator. The verifier may flip to `unclear` (conflation, too little evidence) — that
// is a refutation, not a third opinion.
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
const starts = [];
for (let s = 0; s < total; s += batch) {
  starts.push(s);
}

const brief = (
  start,
) => `You are the SECOND OPINION on crawl-seed label verdicts for **Fluncle**, a drum & bass archive. A first researcher already ruled each label below \`dnb\` or \`not_dnb\` at medium or low confidence. Fluncle's crawler only STORES tracks from \`enabled\` (dnb) labels, so a wrong "dnb" pollutes a public DnB archive and a wrong "not_dnb" silently loses good music. Your job is to TRY TO REFUTE each verdict with evidence the first pass did not cite. Default to doubt: a verdict you cannot independently confirm stays unconfirmed.

## Your slice
Read the JSON array at \`${file}\` and take **items [${start}, ${start + batch})** (0-indexed, may run past the end — just take what exists). Each item has \`name\`, \`slug\`, \`mb_label_id\` (the EXACT MusicBrainz entity — never research a same-named label), the first pass's \`verdict\`, \`confidence\`, \`evidence\` and \`notable\`.

## Calibrate to the operator's real boundary
- Already ENABLED (DnB, in scope): read \`${enabled}\`
- Already DISABLED (out of scope): read \`${disabled}\`
Read BOTH before judging. Majors, subsidiaries, distributors and aggregators are OUT even when they carry DnB; DnB-specific media brands (Drum&BassArena, UKF, Knowledge) are IN; house/techno/trance/EDM/trap/dubstep/grime/UKG/pop/rock/jazz/reggae labels are OUT. Jungle and every DnB subgenre (liquid, neuro, jump-up, techstep, drumfunk, halftime, ragga jungle, jungletek-dominant) are IN.

## Method — look for what the first pass did NOT look at
1. **MusicBrainz releases with credits** (the strongest signal): \`curl -sS -H "User-Agent: FluncleLabelTriage/1.0 ( https://www.fluncle.com )" "https://musicbrainz.org/ws/2/release?label=<MBID>&limit=50&inc=artist-credits&fmt=json"\`. Read ALL of \`release-count\` if it is ≤ 50; otherwise page a second time. The first pass often read 25 — read more.
2. **The Discogs label page** via the url-rel on \`label/<MBID>?inc=url-rels\` — style tags per release are usually decisive. Fetch with \`firecrawl scrape <url>\` or WebFetch. If the first pass already cited Discogs, check the ARTISTS' own pages instead.
3. **Web** only for what is still open: the label's own Bandcamp / SoundCloud / RA bio.

**RATE LIMIT: MusicBrainz allows 1 request/second — \`sleep 1.2\` between every MB call, and always send the User-Agent or you get 403.**

## Rules
- \`agrees: true\` ONLY when you reach the same bucket from your OWN evidence. Restating the first pass's evidence is not confirmation.
- \`confidence: high\` ONLY when the catalogue is unambiguous on what you read — every (or nearly every) release in one lane, or a clear major/distributor/aggregator shape.
- A label whose MBID mixes two real labels' catalogues (conflation) is \`unclear\`, always — name the conflation.
- A label with too little evidence to call stays \`unclear\` / \`low\`. Do not rescue a guess with a better guess.
- A mixed label (meaningful DnB minority on an off-lane label, or a recurring off-lane act on a DnB label) is \`unclear\` here — the census pass handles carving, not you.

## Output
One entry per label via the structured schema. Do not write any files.`;

phase("Verify");
// Execution slices run on the Opus workhorse per the repo model policy (AGENTS.md: Fable
// decides, Opus executes); cfg.model exists so a run can override without editing the script.
const model = cfg.model || "opus";
const results = await parallel(
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
