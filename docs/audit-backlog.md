# Audit backlog — the nightly auditor's findings ledger

This is the durable record of findings the **nightly `fluncle-audit` sweep** chose to _file_
rather than fix (the large, risky, cross-cutting, or judgment-call ones — see the auditor's
operating contract in `docs/agents/hermes/scripts/audit/prompts/_preamble.md`). It is
**machine-appended and committed as part of each night's PR**, so a filed finding survives the
PR's merge instead of being buried in a squashed commit message.

Keep it distinct from the human-owned list:

- `docs/planning/ROADMAP.md` — the planning backlog (non-canon per AGENTS.md).

The operator triages from _this_ ledger into it when a finding is worth scheduling; the audit
never writes to it directly.

## How it's maintained

- The **auditor** (1am) appends a row for each finding it filed tonight, most-severe first. It
  **dedupes**: before appending, it checks for an existing open row with the same `domain` +
  `location` + gist and skips it rather than re-filing the same thing every cycle.
- The **reviewer** (5am) may resolve a small filed finding by fixing it — when it does, it flips
  that row's status to `fixed` (with the PR that fixed it).
- The **operator** resolves rows by acting on them (or promoting them to the roadmap/backlog),
  then sets status to `done` / `wontfix`. A row is never silently deleted — status carries the
  history.

## Columns

`filed` (UTC date) · `domain` · `sev` (high/med/low) · `location` (`path:line`) · `finding` ·
`proposed_fix` · `status` (open/fixed/done/wontfix) · `ref` (PR/commit that filed or resolved it)

| filed | domain | sev | location | finding | proposed_fix | status | ref |
| ----- | ------ | --- | -------- | ------- | ------------ | ------ | --- |

<!-- The auditor appends rows below this line. Newest run on top. -->

| 2026-07-10 | voice | low | `apps/web/src/routes/logbook.$sector.tsx:255` | The `/logbook` surface uses "sector" as a structural UI label — the `<h1>` reads `Sector {sectorLabel}`, the prev/next nav and page title carry `Sector NNN`, and both the index intro and meta say "one entry per sector-day of the voyage". VOICE.md §3 bans "sector … as a UI label or a structural noun" (colour-in-first-person-prose only). But VOICE.md §4 (the Found Rule) itself names the Log ID's first coordinate slot "the sector" (days since the epoch), and `docs/agents/logbook-agent.md` makes "sector-day" the canonical structural unit of the whole logbook (the same `036` that leads `036.7.2I`). So this is a genuine canon-internal tension, not clear drift. | Judgment call — needs a human ruling on which clause governs the logbook. Either bless the coordinate reading (the `Sector NNN` heading IS the Log ID's sector slot, so §3's colour-only restriction doesn't reach it) and note the carve-out in VOICE.md §3, or rewrite the logbook's `sector`/`Sector NNN` vocabulary to a coordinate-native label (e.g. lead with the bare `036.·` coordinate) across the two route files + the agent doc. Cross-cutting; do not touch unilaterally. | open | audit/20260710-voice |

| 2026-07-09 | design | low | `apps/web/src/styles.css:237` | The `.cover-story-badge` (the play badge on the homepage story-ring cover) carries a genuine dark neutral-black drop-shadow for depth — `box-shadow: 0 4px 10px -3px rgb(0 0 0 / 0.6)` — the only dark-elevation shadow in the whole public surface. DESIGN.md §4 (One Pane / Through-the-Glass) bans box-shadows for elevation (depth is translucency over the fixed backdrop), and the neutral black tint leans against the Warm Dark Rule. Its sibling `.cover-story` already uses the gold-glow idiom instead. | Judgment call — a designer may want to keep the drop-shadow as the Instagram-story play-badge affordance. If tightening: swap to the gold-glow bloom idiom (`color-mix(… var(--eclipse-gold) …)`) the `.cover-story` ring already uses, or at minimum warm the shadow tint off pure black. | open | audit/20260709-design |
