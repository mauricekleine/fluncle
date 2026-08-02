export const meta = {
  description:
    "Classify Fluncle's undecided crawl-seed labels as DnB / not DnB / unclear, and census the mixed ones into artist-rule proposals",
  name: "label-dnb-triage",
  phases: [
    { detail: "MusicBrainz + Discogs + web per label batch", title: "Research" },
    { detail: "First-credit census of the mixed labels → artist-rule proposals", title: "Census" },
  ],
};

// ── The rule shape the census returns ────────────────────────────────────────────────────────
// A proposal is a FIRST-CREDIT exception to the label's seed state (docs/label-entity.md):
// a `block` on an enabled label refuses that act's own records; an `allow` on a label that
// stays disabled takes theirs and nobody else's. `firstCreditCount` is load-bearing — a rule with
// zero first credits on the census is INERT (it can never fire) and is rejected downstream.
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
    tapBridge: {
      description:
        "Does the artist's MB entity carry a Spotify url-rel? yes = the freshness tap can enforce a block too; no = the rule is tap-blind (the crawler still enforces it); unknown = not checked.",
      enum: ["yes", "no", "unknown"],
      type: "string",
    },
    verdict: { enum: ["allow", "block"], type: "string" },
  },
  required: ["artistMbid", "artistName", "verdict", "evidence", "firstCreditCount"],
  type: "object",
};

const VERDICT_ITEM = {
  properties: {
    confidence: { enum: ["high", "medium", "low"], type: "string" },
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
        "Off-lane share of censused FIRST credits, 0–1. Above 0.15 the label is not mainly in lane: return unclear, not dnb.",
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

const RULE_PRECEDENT = rules
  ? `- Artist rules already RATIFIED (the precedent for any rule you propose): read \`${rules}\`\n`
  : "";

const brief = (
  start,
) => `You are triaging crawl-seed labels for **Fluncle**, a drum & bass archive. Fluncle's catalogue crawler only STORES tracks from labels the operator marks \`enabled\`, so your verdict decides whether a label's releases enter a DnB archive. A wrong "dnb" pollutes the catalogue with off-genre music; a wrong "not_dnb" silently loses good music. Be accurate over decisive.

## Your slice
Read the JSON array at \`${file}\` and take **items [${start}, ${start + batch})** (0-indexed, may run past the end — just take what exists). Each item has \`name\`, \`slug\`, \`mb_label_id\` (a MusicBrainz label MBID that identifies the EXACT entity — never research a same-named label), and \`rules\` (artist rules this label ALREADY carries — read them; they are the operator's standing exceptions for it).

## Calibrate to the operator's real boundary
- Already ENABLED (DnB, in scope): read \`${enabled}\`
- Already DISABLED (out of scope): read \`${disabled}\`
${RULE_PRECEDENT}Read BOTH lists before judging. Note the pattern: DnB labels of any size are in; **majors, their subsidiaries, distributors and aggregators are OUT even when they carry DnB** (e.g. Believe, BBE, Beggars, Boiler Room, Atlantic, BMG are disabled), as are house/techno/trance/EDM/trap/pop/rock/jazz/reggae/world labels.

## Buckets
- **dnb** — predominantly drum & bass or jungle, including subgenres: liquid, neurofunk, jump-up, techstep, drumfunk, halftime, ragga jungle, darkside. A DnB-dominant label counts even if it releases the odd other thing.
- **not_dnb** — clearly another genre, OR a major/subsidiary/distributor/aggregator/reissue-house/compilation mill. NOTE the ratified media-brands rule (2026-07-26): a DnB-SPECIFIC media brand that presses/releases DnB (a magazine's cover-mount imprint, a DnB platform's label arm — the Knowledge Magazine / Drum&BassArena / UKF class, all enabled) is **dnb**; GENERAL dance media (the DJ Magazine class, disabled) is not_dnb.
- **unclear** — genuinely mixed-genre electronic with meaningful but minority DnB; or too little evidence exists to call it (tiny/defunct/no web presence). Use this honestly rather than guessing — the operator reviews these by hand.
- **unclear, ALWAYS, for MB entity CONFLATION**: when the MBID's release list mixes the label's real catalogue with a clearly-foreign one (a UK DnB label's MBID also carrying a Swedish rock label's albums — a measured case), do NOT rule through it. Enabling crawls BY MBID, so an enable imports the foreign catalogue. Name the conflation in your evidence; the fix is an upstream MusicBrainz entity split.

## The MIXED flag — \`needsCensus\`
Fluncle can now carve a mixed label with per-artist FIRST-CREDIT exceptions: keep a label enabled but **block** the acts whose own records are off-lane, or keep it disabled and **allow** the DnB acts whose records deserve the archive. You are NOT doing that census — set \`needsCensus: true\` and give your best provisional verdict, and a second pass counts the label properly.

Set \`needsCensus: true\` when the label is genuinely two-sided: mostly DnB with a recurring off-lane act (provisional \`dnb\`), or mostly off-lane with a real DnB minority worth taking (provisional \`dnb_partial\`). Do NOT set it for a clean call either way, for a conflated MBID (that stays \`unclear\` — the fix is upstream), or for a label with too little evidence to count.

## Method (in order, stop when confident)
1. **MusicBrainz label**: \`curl -sS -H "User-Agent: FluncleLabelTriage/1.0 ( https://www.fluncle.com )" "https://musicbrainz.org/ws/2/label/<MBID>?inc=tags+genres+url-rels&fmt=json"\` — gives type, area, and often a **Discogs URL** in \`relations\`. NOTE: MB \`tags\`/\`genres\` are usually EMPTY, so do not rely on them.
2. **MusicBrainz releases** (the strongest signal — the ARTISTS tell you the genre): \`curl -sS -H "User-Agent: ..." "https://musicbrainz.org/ws/2/release?label=<MBID>&limit=25&inc=artist-credits&fmt=json"\`. Read \`release-count\`, titles, and artist credits. Recognisable DnB artists ⇒ dnb.
3. **Discogs** via the url-rel from step 1 — its label page lists releases with genre/style tags, which is often decisive. Fetch with \`firecrawl scrape <url>\` (the CLI is authenticated) or WebFetch.
4. **Web** for anything still open: \`firecrawl search "<label name> drum and bass label"\`, or WebSearch. Check the label's own site, Bandcamp, RA, Juno.

**RATE LIMIT: MusicBrainz allows 1 request/second — \`sleep 1.2\` between every MB call, and always send the User-Agent or you get 403.** Work through your labels one at a time.

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

## Non-negotiable rails
1. **Imprint child first.** \`curl -sS -H "User-Agent: FluncleLabelTriage/1.0 ( https://www.fluncle.com )" "https://musicbrainz.org/ws/2/label/<MBID>?inc=label-rels&fmt=json"\`. If MusicBrainz already models the boundary as a child imprint / sub-label (a DnB imprint of a bigger house), say so in \`imprintChild\` and **propose no rules** — the right move is to rule that MB entity, not to hand-carve artists. Otherwise \`imprintChild: "none"\`.
2. **The 15% share test.** Compute \`offLaneFirstCreditShare\` = off-lane FIRST credits ÷ censused recordings. **≤ 0.15 ⇒ \`dnb\` + block rules.** Above it the label is not mainly DnB: return \`unclear\` (the operator rules it himself) unless the mirror case holds — a mostly-off-lane label whose DnB acts are worth taking, which is \`dnb_partial\` + allow rules.
3. **No inert rules.** A proposed rule needs \`firstCreditCount > 0\` on YOUR census. An act you only ever see as a guest credit can never trigger a first-credit rule — leave it out and say so in the evidence if it matters. (Measured case: Maddslinky on Gutterfunk, 0 first credits, an intuitive block that would never have fired.)
4. **One act is often several MBIDs.** Collaboration entities are separate MusicBrainz artists: "DJ Die" and "DieMantle" are different MBIDs, and on the measured census DJ Die alone was 44/130 first credits while DJ Die + DieMantle was 57/130. Expand every act you rule on into ALL the entities it is first-credited under, and give each its own rule row with its own count. A missed collaboration entity under-imports; it never mis-imports.
5. **Conflation is still \`unclear\`.** If the MBID mixes two real labels, name the conflation and rule nothing — the fix is an upstream MusicBrainz entity split.
6. **Globals are the operator's.** If an act deserves a rule EVERYWHERE (not just on this label), write it as prose in \`globalSuggestion\`. Never propose it as a rule row — global rules are authored by hand.
7. **Same alias, different act.** Two acts can share a name. Verify each MBID's own release list before you rule it.

## The census
Page the label's releases WITH credits and recordings:
\`curl -sS -H "User-Agent: FluncleLabelTriage/1.0 ( https://www.fluncle.com )" "https://musicbrainz.org/ws/2/release?label=<MBID>&inc=artist-credits+recordings&limit=100&offset=<N>&fmt=json"\`

- **1 request/second — \`sleep 1.2\` between every MB call, and always send the User-Agent or you get 403.**
- \`limit=100\` is MusicBrainz's ceiling. Page with \`offset\` until you have the catalogue **or you have fetched 5 pages** — whichever comes first. If you hit the cap, the census is a SAMPLE: say so verbatim in \`censusSummary\` ("sampled: first 500 of N releases") and drop your confidence a step.
- For each release, walk its media → tracks → recordings and take the **first** entry of the track's \`artist-credit\` array. That MBID is the one a rule matches. Count first credits per MBID across the whole census.
- Judge each recurring first-credit act in or out of lane on its OWN catalogue (its MB releases, its Discogs styles), not on the label's average.
- Report the totals in \`censusSummary\`: releases read, recordings counted, pages fetched, in-lane vs off-lane first credits, and what a rule set would take vs drop.

## Output
One entry per label via the structured schema. \`rules\` is empty unless you are proposing exceptions, and every rule carries its own \`evidence\` + \`firstCreditCount\`. Check each proposed artist's MB entity for a Spotify url-rel (\`?inc=url-rels\`) and set \`tapBridge\` — \`no\` means the rule is tap-blind (the crawler still enforces it; the freshness tap cannot), which the operator wants to see. Do not write any files.`;

phase("Research");
const results = await parallel(
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

// The census runs ONLY for the labels phase 1 flagged as mixed — a plain enable or disable needs
// no census, and the census is the expensive leg (paged MB reads at 1 req/s).
const mixed = all.filter((v) => v.needsCensus === true);
const censusStarts = [];
for (let s = 0; s < mixed.length; s += CENSUS_BATCH) {
  censusStarts.push(s);
}
log(`census queue: ${mixed.length} mixed label(s) in ${censusStarts.length} slice(s)`);

let censused = [];
if (mixed.length > 0) {
  phase("Census");
  const censusResults = await parallel(
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

// The census verdict REPLACES phase 1's provisional read for that label.
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
