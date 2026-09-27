---
name: session-reflection
description: >-
  Mine a substantial working session for durable improvements to the repo's agent harness. Route each lesson to the strongest appropriate home: code fix, executable guardrail, scoped skill, memory, or standing instruction. Use when the operator requests reflection or when repeated friction, stale guidance, or corrections reveal a durable gap. Keep product implementation and copy work outside this skill.
---

# Session reflection — route the lessons, guard the constitution

Mine the session for durable improvements and route each lesson to the strongest appropriate home.

Instruction-file growth reduces model adherence. Choose the home that enforces the lesson with the least prose; use standing guidance only when stronger mechanisms do not fit.

## Ground rules (they bind everything below)

1. **Prose is the last resort.** Route each lesson through the ladder from strongest to weakest, stopping at the first suitable home. Use standing instructions only when no stronger rung fits.
2. **No receipt, no proposal.** Every finding cites concrete session evidence: tool output, an operator correction, a deployment result, or measurable recovery effort. Propose only lessons supported by evidence.
3. **One occurrence is an episode, not a rule.** A standing-instruction proposal needs the pattern to have bitten at least twice (in this session, or once here plus a prior memory/doc scar). Single occurrences route to memory at most — or to nothing.
4. **Never regenerate a file.** Propose minimal diffs against curated files, using exact old text and replacement text so existing specifics remain intact.
5. **Hard cap: at most 5 proposals**, ranked by expected cost of recurrence. Summarize any remaining candidates in one line.
6. **Pruning counts as improvement.** Actively hunt deletions: rules now enforced by CI/tests/hooks, stale paths, contradictions, shipped-work references, memories this session proved wrong. The instruction budget should trend flat or down; propose an eviction alongside any addition to an already-long file.
7. **Never propose weakening safety rails, autonomy boundaries, or operator gates — including for yourself.**

## The routing ladder

For each candidate lesson, take the FIRST rung that fits:

| Rung                     | When                                                                                            | Home                                                                                                                                                                                    |
| ------------------------ | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Code fix**             | The lesson papers over a real defect                                                            | Fix the code (or file the fix as the proposal)                                                                                                                                          |
| **Executable guardrail** | Recurring AND mechanically checkable                                                            | Encode the lesson in a test, lint rule, hook, coverage gate, or CI step                                                                                                                 |
| **Skill / scoped rule**  | A procedure or gotcha tied to one workflow or one part of the tree                              | The relevant skill in `packages/skills/**` (then `npx skills add ./packages/skills/NAME --skill NAME --agent claude-code codex opencode --yes`), or a path-scoped `.claude/rules/` file |
| **Memory**               | Narrow, situational, or single-occurrence but worth recall                                      | The persistent memory system (one fact per file, indexed in `MEMORY.md`)                                                                                                                |
| **Standing instruction** | Broad, durable, un-checkable, ≥2 occurrences, and a new teammate would need it in every session | `AGENTS.md` (or the relevant canon doc) — the rarest outcome                                                                                                                            |

The spine, from Anthropic's own guidance: _if Claude already does the thing right without the rule, delete it or convert it to a hook._ Default to the lowest-commitment destination; promotion up the ladder requires a reason.

## What to hold the session against

Review `AGENTS.md`, the loaded or applicable skills, agent rules, hooks, memory, and CI enforcement points. Ask whether executable enforcement can hold each lesson before choosing prose.

## Signal sources, in priority order

1. **Explicit operator corrections** — every time they said "no", "please don't", "why did you…", or fixed your output. The highest-grade ore.
2. **Failed tool calls and their recovery cost** — errors that took multiple turns to route around, especially ones a doc/skill claimed wouldn't happen.
3. **Stale guidance hit live** — any instruction, skill line, or memory that was WRONG when followed. These become deletions/corrections, the best kind of finding.
4. **Repeated friction** — anything done 3+ times by hand that a script/hook/flag should own.
5. **Surprises** — things that worked only because of undocumented knowledge you happened to have.

## Output

Start with an `Already routed in-session` line listing lessons handled during the session, one line each. This keeps the ranked table focused on open items and prevents duplicate proposals.

Then present ONE ranked table and stop for ratification:

| # | Lesson (one line) | Receipt (the session moment) | Rung | Proposed change (diff or new-file summary) |

Below the table: the overflow line (what the cap cut), any proposed **deletions** listed separately, and any proposed **memory deletions** flagged for the operator (never auto-delete a memory).

The operator replies with numbers to approve (e.g. "1, 3, 4"). Then implement exactly those: minimal edits, house verification for whatever you touch (local skills need a named `npx skills add` refresh; public copy needs the copy gates + `canon-reviewer`; code needs its tests and the deploy watched to green), one commit, and a one-line-per-change report. Auto-apply WITHOUT waiting is permitted only for the mechanically-safe class: typo fixes, dead paths, and factually-stale lines in non-canon files.

## Before you trust anything you added

Exercise each proposed detector with a synthetic failing input and verify that it trips before acceptance.
