# RFC: the Funnel — the catalogue pipeline on one admin page

**Status:** in-flight plan (ratified 2026-07-18, operator: name "Funnel", right edge runs to CERTIFIED). **Prune when shipped.**

## Why

The catalogue machine (crawl → anchor → capture → analyze/embed → rec-eligible → certified) is operated blind: every "where are the queues" question is hand-run SQL, and the day's real bottleneck (anchor starvation) was found by ad-hoc diagnosis rather than a glance. The operator wants the numbers standing on a page: totals, mid-flight, queues, a funnel visualizer, and growth-per-day charts that make a pinched pipe visible.

## Naming (ratified)

The page is **`/admin/funnel`**, nav label **Funnel** — it names the VIEW; `/pipeline` (public) keeps naming the findings machine. NOT "Capture" (collides with a stage/CLI group/budget) and NOT "The Web" (collides with the ratified reach metaphor). The sidebar gains a **Catalogue** group: **Funnel · Catalogue · Labels** (Labels is a crawl-scope control, so it moves down from the archive block; Findings/Renders/Artists/Galaxies stay above).

## The one structural piece: daily snapshots

Live counts are cheap; growth charts need history nobody records (there is no `anchored_at`, no per-day ledger). The house pattern is the `/reach` daily snapshot. So:

- **`catalogue_snapshots`** (one row per UTC day, unique on `day`): crawled totals (tracks, uncertified), anchored, captured, analyzed, embedded, rec-eligible, certified, plus queue depths (anchor with/without ISRC, anchor backoff bench, capture, analyze, embed) and frontier state (done/pending). All columns integers, all derived from the same queries the operator has been hand-running.
- **`record_catalogue_snapshot`** — AGENT-tier op, idempotent per day (an upsert on `day`), so a re-fired tick never doubles a bar. A rave-02 host timer (the anchor-timer pattern: baked script + `<job>-timer/` units + registry `cron.funnel-snapshot` + healthcheck prober entry) fires it daily; box enable is the standard operator-gated step. The script calls oRPC over HTTP directly — no new pinned-CLI dependency.
- **No backfill.** Charts start with the first real snapshot and grow honestly; invented history is worse than a short chart.

## The read op

**`get_funnel`** — admin-tier: `{ live: { stages, queues, meters }, series: snapshot[] }` in one call. Stages carry total + in-flight + queued-behind per stage, crawl → certified. Meters: capture budget remaining today (reuse the budget read), anchor backoff bench size, frontier pending. Series: the snapshot rows, capped (e.g. last 90 days) and cut in SQL.

## The page

- **Top — the funnel**: stages drawn left→right with honest proportional widths, each stage clickable to its operating surface (Catalogue list, Labels, the capture budget view). Certified is the right edge — the catalogue → archive exit is a number, not a feeling.
- **Middle — the meters**: capture budget today, anchor bench, frontier depth. The spend gates get gauges because they are the operator's levers.
- **Bottom — the charts**: catalogue growth/day, eligible-pool growth/day, and per-stage daily throughput (today − yesterday per stage) — the pipe-width view that makes "capture moved 4,900, analyze moved 190" a glance. Reuse `/admin/usage`'s existing charting idiom — no new dependency.
- Admin route conventions throughout: loader-seeded react-query hybrid, `refetchOnWindowFocus: true`, AdminShell placement contract (docs/admin-shell.md).

## Units

- **U1 (server):** `catalogue_snapshots` migration (via db:generate, plain ASC indexes only), `record_catalogue_snapshot` + `get_funnel` ops on contract + router + coverage/auth/naming tests, the box sweep script + timer units + registry/prober wiring, integration tests against the real schema. The snapshot's count queries reuse/extract the exact shapes already proven (the work-queue counts, the eligibility predicate — one shared server module so the funnel can never drift from the real gates).
- **U2 (UI):** the `/admin/funnel` route + the sidebar Catalogue regrouping + funnel/meters/charts, admin exemplar conventions, operator-register copy (admin surface: literal labels; not crew-facing).

Merge order U1 → U2. Box timer enable stays operator-gated per the standard.
