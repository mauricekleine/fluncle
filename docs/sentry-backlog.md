# Sentry backlog — the nightly triage's filed-issues ledger

This is the durable record of Sentry issues the **nightly `fluncle-sentry-triage` sweep** chose to
_file_ rather than auto-fix (the large, risky, cross-cutting, judgment-call, or hard-to-reproduce
ones — see the triage operating contract in
`docs/agents/hermes/scripts/sentry-triage-prompt.md`). It is **machine-appended and committed as a
docs-only ledger PR** each night, so a filed issue survives instead of being lost in a run's logs.

It is the Sentry-side sibling of the codebase-audit ledger `docs/audit-backlog.md`. Keep the two
distinct: the audit ledger holds findings from the nightly codebase audit; this one holds real
production errors Sentry caught that need a human's fix.

## How it's maintained

- The **triage sweep** (03:30) appends a row per issue it filed tonight, most-frequent-first. The
  driver **dedupes** before triage: an issue already in a row here (or already covered by an open
  triage PR) is never re-triaged, so a row is never duplicated across nights.
- Each filed row ends with an **invisible marker** `<!-- sentry_id:<id> -->` (the numeric Sentry
  issue id). This is what the driver's fetch step reads to dedupe — do not remove it.
- The **operator** resolves rows by acting on them: fix the issue (its own PR resolves it in Sentry
  once merged, via the sweep's reconcile), or decide it is noise and resolve/ignore it in Sentry
  directly. Then set the row's `status` to `done` / `wontfix` — never silently delete (status
  carries the history).
- A **fixed** issue never lands here: the sweep opens a fix PR for it instead, and resolves the
  Sentry issue when that PR merges.

## Columns

`filed` (UTC date) · `project` · `shortId` · `title` · `reason` (why it was filed, not auto-fixed) ·
`status` (open/done/wontfix) · `ref` (the Sentry permalink or the PR that resolved it)

| filed | project | shortId | title | reason | status | ref |
| ----- | ------- | ------- | ----- | ------ | ------ | --- |

<!-- The triage sweep appends rows below this line. Newest run on top. Each row ends with `<!-- sentry_id:<id> -->`. -->
