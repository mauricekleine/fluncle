# Audit backlog — the nightly auditor's findings ledger

This is the durable record of findings the **nightly `fluncle-audit` sweep** chose to _file_
rather than fix (the large, risky, cross-cutting, or judgment-call ones — see the auditor's
operating contract in `docs/agents/hermes/scripts/audit/prompts/_preamble.md`). It is
**machine-appended and committed as part of each night's PR**, so a filed finding survives the
PR's merge instead of being buried in a squashed commit message.

Keep it distinct from the two human-owned lists:

- `docs/followups-backlog.csv` — the operator's hand-curated backlog with its own triage schema.
- `docs/ROADMAP.md` — planning canon.

The operator triages from _this_ ledger into those when a finding is worth scheduling; the audit
never writes to them directly.

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

| 2026-07-09 | design | low | `apps/web/src/styles.css:237` | The `.cover-story-badge` (the play badge on the homepage story-ring cover) carries a genuine dark neutral-black drop-shadow for depth — `box-shadow: 0 4px 10px -3px rgb(0 0 0 / 0.6)` — the only dark-elevation shadow in the whole public surface. DESIGN.md §4 (One Pane / Through-the-Glass) bans box-shadows for elevation (depth is translucency over the fixed backdrop), and the neutral black tint leans against the Warm Dark Rule. Its sibling `.cover-story` already uses the gold-glow idiom instead. | Judgment call — a designer may want to keep the drop-shadow as the Instagram-story play-badge affordance. If tightening: swap to the gold-glow bloom idiom (`color-mix(… var(--eclipse-gold) …)`) the `.cover-story` ring already uses, or at minimum warm the shadow tint off pure black. | open | audit/20260709-design |
