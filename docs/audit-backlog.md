# Audit backlog — the nightly auditor's open findings

The **nightly `fluncle-audit` sweep** files a finding here when it chooses not to fix it itself — the high-impact, high-risk, cross-cutting, or canon-touching ones (see the auditor's operating contract in `docs/agents/hermes/scripts/audit/prompts/_preamble.md`). It is **machine-appended and committed as part of each night's PR**, so a filed finding survives the PR's merge instead of being buried in a squashed commit message.

**Forward-facing, open findings only — never a changelog.** Like `docs/planning/ROADMAP.md`, this ledger carries only what is still ahead: a resolved, rejected, or overtaken row is **deleted in the PR that settles it**, with the resolution named in that PR's body — git history keeps the analysis. A ruling that must outlive its row does not live here: write it into the canon doc or code comment it governs, then delete the row.

Keep it distinct from the human-owned list: `docs/planning/ROADMAP.md` is the planning backlog (non-canon per AGENTS.md). The operator promotes a row there when it is worth scheduling — a promoted item cites the row it came from — and the audit never writes to the roadmap directly.

## How it's maintained

- The **auditor** (1am) appends one row per finding it files tonight, most-severe first. It **dedupes**: before appending, it checks for an existing row with the same `domain` + `location` + gist and skips it rather than re-filing. It may also RESOLVE up to two open rows per night (the preamble's conversion rule): fix the thing in the night's PR and delete the row in the same commit.
- The **reviewer** (5am) may resolve a small filed finding by fixing it — deleting its row in the same PR.
- The **operator** resolves rows by acting on them (or promoting them to the roadmap), then deletes them; the deleting commit names what settled the row.

## Columns

`filed` (UTC date) · `domain` · `sev` (high/med/low) · `location` (`path:line`) · `finding` · `proposed_fix` · `ref` (PR/commit that filed it)

| filed | domain | sev | location | finding | proposed_fix | ref |
| ----- | ------ | --- | -------- | ------- | ------------ | --- |

<!-- The auditor appends rows below this line. Newest run on top. -->

| 2026-07-26 | surfaces-seo | med | `apps/web/src/lib/server/artists.ts:337` / `labels.ts:601` / `albums.ts:369` (the sitemap reads) + the public entity pages | **Off-genre catalogue entities the crawler brought back are still live, indexable, and in the entity sitemaps on a drum & bass site.** Probed 2026-07-27: `/artist/bette-bright-and-the-illuminations`, `/album/champions-of-dub`, `/album/duppy-man-top-shotta`, `/album/barrio-funk-ep`, and `/artist/dave-angel` are 200, carry no robots meta, and sit in `sitemap/{artists,albums}-1.xml`; `/album/as-melhores-da-decada-mixed-by-celso-portioli` is below the renderable floor (noindexed) but still stored. `/artist/hepcat` and `/artist/axel-flovent` are already purged. GSC (2026-06-25 → 2026-07-23 window) showed this class carrying ~8.5% of page impressions and ~19% of top-query impressions with zero drum & bass intent, `defected` queries included — Google being told fluncle.com is a relevant result for non-DnB entities. | OPERATOR: run the `fluncle-catalogue-prune` pass (dry-run → rule the seed labels → backup → purge → re-probe the six URLs for 404 → re-fetch the three entity sitemaps), with these six as the head of the worklist and Defected's ruling in the same sitting (the house label is pulling brand-mismatched queries). The structural half is SETTLED — do not re-propose: the operator ruled 2026-07-27 that indexability never consults `seed_state` (the ruling is recorded in docs/label-entity.md beside the crawl-scope-never-storage rule); the levers are this prune and the crawler's boundary gate. | audit/20260726-surfaces-seo |
