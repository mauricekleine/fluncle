---
name: agent-orchestration
description: >-
  Doctrine for acting as the orchestrator-and-reviewer over a fleet of sub-agents instead of doing all the work yourself: decompose a job into independent slices, route each slice to the right executor (Opus 5 via the Agent tool for creative/user-facing work; GPT-5.6 Sol via the codex CLI for plumbing, infra, and backend work), delegate into isolated git worktrees, review the diffs (adversarially on anything touching prod), relay feedback until clean, and merge one at a time. Reach for this whenever a task is big enough to split into parallel pieces, involves coordinating several sub-agents or worktrees, fanning work out and reviewing/merging PRs, running a backfill or migration across many items, validating one case before fanning out, de-risking a big change with a spike, or any multi-step build where you should hold the overview while sub-agents execute — even if the user never says the word "orchestrate."
---

# Agent orchestration

## The stance

You are the **orchestrator and reviewer**, not the implementer. You hold the plan, the context, the safety judgment, and the merge authority. Sub-agents hold the file-level grind; their final message is the _conclusion_ you keep, not the file dumps that would flood your context. The whole point is leverage: you stay oriented across a dozen moving slices because you never load the weeds of any one of them.

This orchestrator-and-reviewer role sits with the session's **Fable 5** driver seat; execution is offloaded to two near-peer workhorses, routed by the NATURE of each slice — your judgment call every time, a heuristic and never a strict rule. **Opus 5** (`model: opus` on the Agent tool — the floating alias) takes the creative and user-facing work: frontend, public copy, visual/video, conceptualizing, anything canon-adjacent — it is the only executor that can pass the house gates (the `copywriting-fluncle` skill and `canon-reviewer` are Claude-side; codex cannot load them), so a mixed slice that cannot be split defaults here. **GPT-5.6 Sol** (via `codex exec`, default effort `high` — mechanics below) takes the plumbing: backend architecture, server modules, data migrations, CI, infrastructure, box crons/schedules, the Go/Rust apps — near-Opus capability at a discount on exactly that shape of work, and the favored pick for substantive research (codebase-wide audits, web best-practice sweeps) while quick recon stays on cheap `Explore` fan-outs. Fable's per-token premium is spent where it pays (holding the overview, the adversarial review, the merge judgment), never on execution volume. Sonnet is ruled out for execution slices (see `AGENTS.md`, "Picking the right models and effort for workflows and subagents").

Use this loop when the work is decomposable — several independent build slices, a backfill or migration across many items, a review across many files, or a multi-step feature where parallelism or a clean separation of "decide" from "execute" buys you speed or clarity. For a single edit you already understand, just do it; the orchestration overhead only pays off at scale.

## The loop

**1. Recon before you brief.** A sub-agent only knows what you tell it, so a wrong assumption in a brief becomes a wrong build. Ground every brief in real file paths, function signatures, and existing patterns — gathered by you, or by read-only `Explore` agents fanned out in parallel when the surface is broad. Cheap recon up front prevents an expensive wrong turn downstream.

**2. Decompose into independent slices.** Prefer slices that touch disjoint files so their PRs merge without conflict. Where two slices must touch the same file, sequence them (or hand both edits to one agent) rather than racing them. Name the overlap explicitly so you remember to reconcile it.

**3. Brief precisely.** The brief is the entire contract. Give it: the scope, the recon facts, the constraints (build-only vs. ship, hold-for-merge, voice/canon, safety rails), the exact verification steps, and **what to report back**. Embed the gotchas you already know so the agent doesn't rediscover them. Tell prod-touching agents what they may and may not mutate, and to _stop and flag_ rather than hack around a blocker.

**4. Delegate into isolated worktrees, routed by slice nature.** An **Opus slice** goes through the Agent tool with `isolation: "worktree"` (`model: opus` — a floating alias that resolves to the current Opus tier, deliberately not pinned): the agent works on an isolated copy, builds, runs the relevant checks (typecheck / build / test / lint), and opens a PR itself. A **Sol slice** goes through `codex exec` into a worktree YOU prepared, and you own its git leg — the full recipe is the "Delegating to GPT-5.6 Sol" section below. Either way: worktrees branch from the **last pushed commit**, so push first if a local-only change must be visible, or inline it into the brief. **Every worktree's first step is `bun install --frozen-lockfile`** — a fresh worktree has no `node_modules`, and module resolution then silently falls through to the MAIN checkout's copy, so the agent tests someone else's code and reports green. For Opus agents that install is the brief's first step; for Sol worktrees it is YOURS (codex's `workspace-write` sandbox blocks network, so Sol cannot install). Routing to Sol is a domain call between near-peers, never a cost downgrade — the banned move is a weak tier (a cheap agent that under-delivers costs more than it saves).

**5. Review the diff, not the summary.** Read the actual changes. On anything load-bearing or prod-touching, review _adversarially_ and verify the safety-critical property yourself — e.g., "does this truly deploy as a no-op until the flag flips?", "is this auth gate actually first?", "is this SQL parameterized?". The agent's confident report is a hypothesis; the diff is the evidence. On the highest-stakes diffs (prod/auth/SQL/paid-action — the ones already earmarked for `xhigh` review), additionally fire a **Sol adversarial pass** over the diff (a read-only `codex exec` at `xhigh`, or `codex exec review`) — cross-vendor eyes catch failure modes same-family redundancy cannot. Sol's findings are an INPUT to your verdict, never the gate: you remain the sole reviewer and merge authority.

**6. Ping-pong until clean.** When review surfaces findings, relay them back to the agent (continue it with its context intact) for another pass, or apply a small fix yourself when that's faster than a round-trip. Several passes is normal. Never merge on the agent's word alone.

**7. Merge one at a time.** Squash-merge and delete the branch. Respect **deploy/build coalescing**: rapid back-to-back merges can drop intermediate CI/deploy builds, so space them and make sure a build runs on the _final_ HEAD (the last build includes everything; re-trigger if it got swallowed). Update a stale branch before merging if the host requires an up-to-date branch.

**8. Hold gated PRs.** Some PRs are correct but must not merge until a prerequisite lands (a backfill finishes, an operator flips a setting, another slice ships first). Open them, mark **HOLD** in the body with the gate, and merge when the gate clears.

## Delegating to GPT-5.6 Sol (codex)

Sol runs through the `codex` CLI's non-interactive `codex exec` — invoked from your Bash tool (with the harness sandbox off: codex needs network for its own API calls), backgrounded for parallel slices, with the usual sliding-window concurrency. The Workflow tool cannot spawn codex, so Sol fan-out always rides background Bash. The contract, end to end:

1. **You prep the worktree.** Create it from `origin/main` and run `bun install --frozen-lockfile` yourself — codex's `workspace-write` sandbox blocks network, so the install cannot be Sol's step.
2. **Launch.** `codex exec -C <worktree> --sandbox workspace-write -m gpt-5.6-sol -c model_reasoning_effort="high" -o <report-file> "<brief>"` (a long brief pipes via stdin). `high` is Sol's default; step UP to `xhigh` for the most complex slices and the adversarial review pass (`max` is marginally better than `xhigh` at twice the price — the ROI is not there), and down for mechanical ones. Do not pass `--ephemeral` — session files are what make resume work.
3. **The brief still carries the slice contract.** Codex reads `AGENTS.md` natively (that is why `CLAUDE.md` is just `@AGENTS.md`), so repo doctrine loads free — but scope, recon facts, constraints, verification steps, and what-to-report are yours to state, exactly as for an Opus brief.
4. **Sol edits and verifies inside the worktree**; its final message lands in the `-o` report file. It never needs network or git credentials.
5. **You own the git leg.** Review the diff in the worktree, then commit, push, and open the PR yourself — signing, credentials, and merge authority stay in one seat.
6. **Ping-pong via resume — and mind the flag ORDER.** Every option must come BEFORE the `resume` subcommand, and `-C` is not accepted on it at all, so `cd` into the worktree instead (resume filters sessions by cwd; pass the session id when juggling several). Verified against codex-cli 0.146.0, where the documented-looking form fails with `error: unexpected argument '-C' found`:

   ```bash
   cd <worktree> && codex exec --sandbox workspace-write \
     -m gpt-5.6-sol -c model_reasoning_effort="xhigh" -o <report-file> \
     resume --last "<findings>"
   ```

   The failure is quiet in a backgrounded run: the launcher exits 0, no report file appears, and the slice looks like it is still working. **Confirm the process is actually alive after launching** (`pgrep -f "codex exec.*<worktree>"`) rather than assuming the `nohup` took.

7. **Research mode is `--sandbox read-only`.** For codebase-wide audits, best-practice sweeps, and doc gathering, the read-only sandbox makes the run safe by construction — no worktree needed, point it at the main checkout.
8. **Box-config slices are Sol's alone.** Remote box configuration on the Tailscale-only boxes — timer units, cron schedules, script deploys, service restarts — may be delegated to Sol with a permissive sandbox; it is the ONE executor allowed to touch a live box (Claude sub-agents stay blocked, see "Keep the human in the loop"). The standing rails still bind: destructive ops (box delete/rebuild, data-bearing changes), secrets, and paid actions stay operator/Fable-gated, and you verify the box state yourself after.
9. **Fallback is Opus, never a weaker tier.** If codex is unavailable or a run dies unrecoverably, reassign the slice to an Opus worktree agent.

## The review/merge checklist (repo gates)

Verify these repository gates before merging:

- **Brief the type-aware lint.** Every sub-agent brief includes running `bun run lint` (the repo root's `oxlint --type-aware --deny-warnings`) — a plain `oxlint` run under-reports, so an agent reports "lint clean" while CI fails on the type-aware pass.
- **Run whole-repo checks before merging.** Worktree agents typically run only their package's checks; the orchestrator runs the root gates (`bun run typecheck`, `bun run lint`, `bun run format:check`) so cross-package fallout surfaces before the merge, not in the deploy build.
- **Register a new oRPC verb twice.** A new operation verb goes into the closed set in `docs/naming-conventions.md` AND into the `APPROVED_VERBS` list in `apps/web/src/lib/server/orpc-naming.test.ts` — the naming test build-fails on the omission.
- **Format touched docs before handing off.** The pre-commit hook (`lint-staged`) formats only the files staged in that commit, while CI runs `oxfmt --check .` over the whole tree — run `bunx oxfmt <touched files>` (markdown included) so an edit that dodged the hook doesn't fail the deploy gate.
- **Verify the worktree installed before trusting its green.** Trust worktree validation only after confirming that the worktree has its own installed dependencies. Cheap check: the report mentions running `bun install`, or the diff's behavior was verified against schema-true fixtures.
- **A slice adding SQL against prod tables ships a generated-migrations integration test** that executes the actual query (the `createIntegrationDb` pattern) — pure-helper unit coverage does not discharge this.
- **Watch checks with `scripts/watch-checks.sh <pr#|sha>`** so polling stays pinned to the requested revision and returns the repository's standard green/red/undetermined exit codes.

## Patterns worth keeping

**Validate one before fanning out.** For a repetitive, prod-mutating pipeline (render-and-upload, resolve-and-write), run exactly **one** case end-to-end first — a pilot. It proves the recipe _and_ that the deploy/credentials/permissions actually work. A blocker found on item 1 is cheap; the same blocker found on item 40, after 39 half-mutations, is not. Crucially, validate the pilot's _output against the source of truth_ — the original, the spec, the expected result — not merely that it ran and "looks plausible." A subtle regression the pilot waves through (a re-render that quietly shifts the color, a transform that drops a field) gets multiplied across every item in the fan-out, so the comparison must be to what it _should_ be, not to a vibe. Bake the confirmed recipe into the fan-out.

**Diversity at fan-out.** Parallel creative agents converge on a shared attractor — identically-briefed agents return N variations of one idea. Assign each agent a distinct structural family or angle in its launch brief, and put the divergence there: prescriptive mid-flight coaching increases convergence, it doesn't fix it.

**Sliding-window concurrency pools.** For N independent items, don't run discrete batches (a batch pays `max()` of its slowest member while the rest idle). Hold a fixed concurrency — say 2 — and start the next item the instant any one finishes. Total wall-clock trends to `sum / concurrency` with both slots always saturated. A background job per item plus a "spawn next on completion" rule realizes this cleanly.

**De-risk a big commit with a spike.** Before committing a whole subsystem to a new architecture or dependency, spend an hour proving the _one real unknown_ (does it run on the target runtime? does it compose with what's there?) on a trivial end-to-end case. A clear go/no-go beats a half-built migration discovered to be unviable.

**Durable resume-memory for long ops.** A backfill across dozens of items, or a multi-phase rollout, will outlive a context window. Before it's done, write a memory holding the recipe and the _resume query_ ("the remaining set is everything where `X is null`") so a context reset picks up exactly where it left off instead of losing the thread.

## Keep the human in the loop

Autonomy has a boundary. Stop, flag, and recommend — don't guess — for:

- **Direction:** anything that changes product direction or canon.
- **Operator-only steps:** secrets, infrastructure, dashboard/security settings, production credentials, paid/destructive actions, anything you genuinely can't (or shouldn't) do yourself.
- **Remote box mutations never delegate to a Claude sub-agent.** A Claude sub-agent's permission classifiers block remote box mutations (box `start`/`stop`/`delete`, remote `systemctl`, `docker exec` against a live box) — so a delegated slice that needs one stalls or silently skips it. Box CONFIG work routes to Sol (see "Delegating to GPT-5.6 Sol", rail 8) or runs in the main seat; destructive box ops, secrets, and paid actions stay with the operator regardless of executor.
- **Surfaced unknowns:** a real fork or blocker the brief didn't anticipate, where the human's context settles it faster than a spike.
- **Taste:** subjective quality calls (design, copy, anything where "does it read well?" is the bar).

Approval in one context doesn't extend to the next; re-confirm per side-effectful action. When you flag, lead with a crisp recommendation and the tradeoffs, so the human can answer in one line.

## Hygiene

Keep a terse running status during a long grind — milestones, not a play-by-play of every step. Track the work-list and your pointer into it so nothing is dropped or double-run. Clean up merged worktrees and stale branches as you go. And report outcomes faithfully: what merged, what's still in flight, what's held and on what gate.
