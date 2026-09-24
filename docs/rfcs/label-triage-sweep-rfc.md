# RFC: the label-triage sweep — the round runs itself, the ruling stays his

**Status:** In flight — nothing built. All twelve design decisions ratified in session; this file carries the build.
**Scope:** the recurring triage round defined by the [fluncle-label-triage](../../packages/skills/fluncle-label-triage) skill. It does not change the crawl, the storage gate, the exception model, or what a ruling means.

## The problem

A round is four mechanical stages and one editorial act. Today the operator drives all five: pull, research, verify, render, rule. Two consecutive rounds (525 labels, then 346) settled ~1,296 rulings and needed him to say "go" four times per round for work no human judgment improves.

Two numbers say the shape has changed. The out-of-lane share of freshly-minted labels went **74% → 86%** across the two rounds, and the refill rate collapsed from **~307/day to ~9/day** — the walk has left drum & bass's neighbourhood and the graph is exhausting. So the pile is no longer a backlog to drain; it is a trickle to keep ruled, which is exactly the work a human should not be scheduling.

The blocker is that the round has no memory. `labels` records `ruled_at` and `scope_changed_at` but nothing that says _a round looked at this and could not rule it_, so every round re-derives its own stuck core. At the 47 unclear labels standing today, ~14k subagent tokens each, an unattended weekly round would spend ~660k tokens a week reproducing answers it already has — 13 of them on conflations that cannot resolve until MusicBrainz changes.

## The model

**Two halves, split on whether judgment is involved** — the box's existing doctrine ([logbook-sweep.sh](../agents/hermes/scripts/logbook-sweep.sh): deterministic script, `claude -p` only for the part that needs a mind).

- **The gate** is a deterministic `--no-agent` host timer on rave-02. It pulls the pile, computes depth, writes the stamp rotation. No agents, so nothing to rot.
- **The research leg** fires only when **≥40 never-seen** labels have accumulated. The shell script slices the pile into batches of 10 and invokes `claude -p` once per batch under bounded concurrency, writing each batch's JSON as it lands.

The leg is batched rather than one long session because that seam is load-bearing: in the first of the two rounds, 20 of 53 slices died mid-run and the round survived **only** because completed slices were cached and resumable. A single session has no such seam, and bounded `--max-turns` per batch also caps a runaway.

**The sweep can never rule.** `update_label` is OPERATOR tier (`adminAuth` + `operatorGuard`) and the box holds an agent-scoped token, so this is enforced by the architecture and pinned by `orpc-auth-coverage`, not by the script's good behaviour.

## The cursor

A `triage_checked_at` stamp on `labels`, patterned on the `label_releases_checked_at` / `label_releases_attempted_at` freshness-tap convention already on that table — sweep bookkeeping, written at agent tier, driving an oldest-first rotation. Never-seen labels first, then anything past a **30-day** staleness window.

**A timestamp, not a hold flag.** The skill refuses a hold list for a reason ([SKILL.md](../../packages/skills/fluncle-label-triage/SKILL.md)): a hold is a snapshot of a judgment that drifts silently. Re-triage is self-correcting and measurably so — 21 of 39 carried-over labels resolved on the second round without anyone remembering them, 11 of which an earlier verify pass had explicitly refuted. A cursor keeps that; a boolean would have frozen all 11.

The stamp also carries **the last verdict and a reason slug** (`conflation` / `thin` / `mixed`), so `/admin/labels` can group the stuck pile by why it is stuck. Today the station can only say "N waiting on a ruling", which conflates 13 labels blocked on upstream MusicBrainz with 19 genuinely mixed catalogues only the operator can call.

**Three scalar columns on `labels`; the fat payload in a sibling table.** There are no `mode: "json"` columns anywhere in this schema, and `labels` sits on the index-only hub path pinned by `entity-hub-seek.integration.test.ts` — the same plan shape a correlated subquery nearly broke on `artists`. Evidence, census summaries and rule proposals live in their own table keyed to the label, the way `artist_rules` and `label_aliases` already do, joined only by the section that renders them.

## The station becomes the ratification surface

`SKILL.md` mandates the ratification page be "a local file, never a hosted artifact". That rule was written when a round only ever ran in-session, and a box-run round cannot satisfy it. The resolution is the direction the admin canon already points ([docs/admin-shell.md](../admin-shell.md)): `/admin/labels` grows a proposed section with tier bulk-actions, reusing its existing `LabelsAdminSection` model, and `/admin/artists` grows a global-suggestion queue on the rule mutation already wired to that board.

This **retires** `render-ratification.py` and most of `apply-rulings.py`'s tiering rather than adding a parallel surface, and it means ratification works from a phone.

## Two judgment rules become machine-applied

**The 15% share test keeps raw as the auto-enable rail, and reports residual.** A label whose raw off-lane share exceeds 15% but whose residual — the share that would leak past existing global rules — falls under it is routed to the operator **by name**, rather than buried in the unclear pile. The measured type specimen is 20.5% raw against 14.7% residual, because two of its off-lane acts already carry global blocks and never arrive. Raw stays the rail because enabling a label is a standing commitment to what it releases _next_, which no existing global covers.

**Conflation briefs auto-emit**, with two rules that were hand-applied and are mechanical: the Group A/B split (does any strand carry a drum & bass catalogue worth recovering, or is the split pure MusicBrainz hygiene), and the standing instruction that the researcher's notes are a **hypothesis to confirm against the live catalogue**, not fact. Both earned their place — the A/B split kept an editing agent from spending the account's standing on 10 splits that gain Fluncle nothing, and the hypothesis framing caught three wrong premises in a hand-written brief.

## One new safety measure

**10% of high-confidence disables are sampled into the verify set for three rounds.** Across the two rounds ~625 labels were disabled on a single agent's read; the verify pass only ever covered the medium/low pool. A disabled label leaves the pile permanently — the pull reads only `undecided` — so a confidently-wrong disable silently loses good music and never resurfaces. No high-confidence verdict has been shown wrong, because none has been checked; three sampled rounds measure the rate, and a clean result earns the trust it currently assumes.

## Slices, in build order

- **Slice 1 — skill edits.** Residual reporting alongside raw in the census, the 10% disable sample in the verify-set builder, the staleness cursor in the pull, and the conflation-brief template with the A/B split. Nearly free, and improves the next in-session round before any schema lands.
- **Slice 2 — schema.** `triage_checked_at` + verdict + reason on `labels`; the sibling proposals table. Generated migration only. The agent-tier write op follows the freshness-tap precedent; naming per [docs/naming-conventions.md](../naming-conventions.md), with `orpc-coverage` / `orpc-auth-coverage` / `orpc-naming` as the gates.
- **Slice 3 — the station.** The `/admin/labels` proposed section with tier bulk-actions and the stuck-pile grouping; the `/admin/artists` global queue. Public-copy gates apply to neither (both are operator tier), but the admin register carve-out does.
- **Slice 4 — the box.** The deterministic gate timer, then the batched research leg. Last, deliberately.

## Decisions locked

Raw rails / residual routes · full pipeline minus applying · box gates and box researches · timestamp cursor not a hold flag · stamp carries verdict + reason · station is the ratification surface · ≥40 never-seen fires, 30-day staleness · globals stay one-click operator acts · 10% disable sample for three rounds · conflation briefs auto-emit · scalar columns on `labels`, payload in a sibling table · script-batched `claude -p`, one call per batch.

## What is provisional

**The box leg.** Every agent-bearing box cron in this repo has had a silent outage — a Claude token six days dead while reading green, a pin rot that took capture down 13 days the same way. The per-batch structure and a tripwire that proves a page was **produced** (never merely that the script exited 0) are load-bearing, not polish. Treat the leg as unproven until it has produced two rounds the operator actually used.

**The ≥40 threshold and the 30-day window** are first guesses against a refill rate that is still falling. Revisit once the gate has a few weeks of depth measurements.
