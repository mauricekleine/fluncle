export const meta = {
  description: "Classify Fluncle's undecided crawl-seed labels as DnB / not DnB / unclear",
  name: "label-dnb-triage",
  phases: [{ detail: "MusicBrainz + Discogs + web per label batch", title: "Research" }],
};

const VERDICTS = {
  properties: {
    verdicts: {
      items: {
        properties: {
          confidence: { enum: ["high", "medium", "low"], type: "string" },
          evidence: {
            description:
              "One line: the concrete finding that decided it (artists seen, Discogs styles, release titles).",
            type: "string",
          },
          name: { type: "string" },
          notable: {
            description:
              "Up to 4 representative artists or releases, comma separated. Empty if none found.",
            type: "string",
          },
          slug: { type: "string" },
          verdict: { enum: ["dnb", "not_dnb", "unclear"], type: "string" },
        },
        required: ["slug", "name", "verdict", "confidence", "evidence"],
        type: "object",
      },
      type: "array",
    },
  },
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
) => `You are triaging crawl-seed labels for **Fluncle**, a drum & bass archive. Fluncle's catalogue crawler only STORES tracks from labels the operator marks \`enabled\`, so your verdict decides whether a label's releases enter a DnB archive. A wrong "dnb" pollutes the catalogue with off-genre music; a wrong "not_dnb" silently loses good music. Be accurate over decisive.

## Your slice
Read the JSON array at \`${file}\` and take **items [${start}, ${start + batch})** (0-indexed, may run past the end — just take what exists). Each item has \`name\`, \`slug\`, and \`mb_label_id\` (a MusicBrainz label MBID that identifies the EXACT entity — never research a same-named label instead).

## Calibrate to the operator's real boundary
- Already ENABLED (DnB, in scope): read \`${enabled}\`
- Already DISABLED (out of scope): read \`${disabled}\`
Read BOTH before judging. Note the pattern: DnB labels of any size are in; **majors, their subsidiaries, distributors and aggregators are OUT even when they carry DnB** (e.g. Believe, BBE, Beggars, Boiler Room, Atlantic, BMG are disabled), as are house/techno/trance/EDM/trap/pop/rock/jazz/reggae/world labels.

## Buckets
- **dnb** — predominantly drum & bass or jungle, including subgenres: liquid, neurofunk, jump-up, techstep, drumfunk, halftime, ragga jungle, darkside. A DnB-dominant label counts even if it releases the odd other thing.
- **not_dnb** — clearly another genre, OR a major/subsidiary/distributor/aggregator/reissue-house/compilation mill. NOTE the ratified media-brands rule (2026-07-26): a DnB-SPECIFIC media brand that presses/releases DnB (a magazine's cover-mount imprint, a DnB platform's label arm — the Knowledge Magazine / Drum&BassArena / UKF class, all enabled) is **dnb**; GENERAL dance media (the DJ Magazine class, disabled) is not_dnb.
- **unclear** — genuinely mixed-genre electronic with meaningful but minority DnB; or too little evidence exists to call it (tiny/defunct/no web presence). Use this honestly rather than guessing — the operator reviews these by hand.
- **unclear, ALWAYS, for MB entity CONFLATION**: when the MBID's release list mixes the label's real catalogue with a clearly-foreign one (a UK DnB label's MBID also carrying a Swedish rock label's albums — a measured case), do NOT rule through it. Enabling crawls BY MBID, so an enable imports the foreign catalogue. Name the conflation in your evidence; the fix is an upstream MusicBrainz entity split.

## Method (in order, stop when confident)
1. **MusicBrainz label**: \`curl -sS -H "User-Agent: FluncleLabelTriage/1.0 ( https://www.fluncle.com )" "https://musicbrainz.org/ws/2/label/<MBID>?inc=tags+genres+url-rels&fmt=json"\` — gives type, area, and often a **Discogs URL** in \`relations\`. NOTE: MB \`tags\`/\`genres\` are usually EMPTY, so do not rely on them.
2. **MusicBrainz releases** (the strongest signal — the ARTISTS tell you the genre): \`curl -sS -H "User-Agent: ..." "https://musicbrainz.org/ws/2/release?label=<MBID>&limit=25&inc=artist-credits&fmt=json"\`. Read \`release-count\`, titles, and artist credits. Recognisable DnB artists ⇒ dnb.
3. **Discogs** via the url-rel from step 1 — its label page lists releases with genre/style tags, which is often decisive. Fetch with \`firecrawl scrape <url>\` (the CLI is authenticated) or WebFetch.
4. **Web** for anything still open: \`firecrawl search "<label name> drum and bass label"\`, or WebSearch. Check the label's own site, Bandcamp, RA, Juno.

**RATE LIMIT: MusicBrainz allows 1 request/second — \`sleep 1.2\` between every MB call, and always send the User-Agent or you get 403.** Work through your labels one at a time.

## Output
Return one entry per label in your slice via the structured schema. \`evidence\` must cite what you actually saw (artist names, Discogs styles, release titles) — never a guess restated. If a label had no findable evidence, say so and mark it \`unclear\` with \`low\` confidence. Do not write any files.`;

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
const by = (v) => all.filter((x) => x.verdict === v);
log(
  `triaged ${all.length}/${total} — dnb=${by("dnb").length} not_dnb=${by("not_dnb").length} unclear=${by("unclear").length}`,
);

return {
  counts: {
    dnb: by("dnb").length,
    not_dnb: by("not_dnb").length,
    total: all.length,
    unclear: by("unclear").length,
  },
  dnb: by("dnb"),
  not_dnb: by("not_dnb"),
  unclear: by("unclear"),
};
