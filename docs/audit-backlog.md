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
