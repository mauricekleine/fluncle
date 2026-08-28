---
name: fluncle-rfc-writer
description: >-
  Produce a rigorous, build-ready RFC / design doc for a substantial or multi-faceted change by orchestrating sub-agents through divergence → convergence → taste → adversarial review → completeness, then writing the final RFC to ./docs. Use this whenever the user wants to scope, research, plan, or "turn an idea into something we can hand off" — an RFC, design doc, technical proposal, architecture/feature spec, or research that must become a plan — ESPECIALLY work spanning both the codebase and current external/web practice, or work meant to hand off to a fresh session or a team of agents. Trigger even when the user doesn't say "RFC": "research how we'd do X and write it up", "scope this properly before we build", "plan out the overhaul", "turn these ideas into a handoff", "figure out the best approach to X", or "do a research pass and give me a doc" should all pull this in. Not for trivial, single-file, or already-decided changes — just do those directly.
---

# RFC Forge

A repeatable pipeline that turns a fuzzy, multi-faceted idea into an RFC good enough to hand to a fresh session or a team of agents. It works by deliberately **diverging** (parallel research grounded in the code AND current web practice), **converging** (one synthesized draft that hunts for the unifying simplification), **stress-testing** (a taste pass plus an adversarial role panel that verifies claims live), and holding the result to a **completeness bar**. The payoff: a plan that's already been attacked from every angle before anyone writes a line of feature code — so the build session executes instead of re-deciding.

Reach for it on substantial, multi-faceted, or hand-off work. Skip it for trivial or already-decided changes; those don't need a panel, they need a diff.

## Why this shape

Independent researchers provide coverage, a taste pass and adversarial review test the draft's assumptions and factual claims, and the completeness standard supplies a concrete definition of done.

## The pipeline

### Phase 1 — Frame

State the single outcome in a sentence. Split it into **distinct, non-overlapping research threads** (typically 2–5) — each a question a separate agent can chase without stepping on the others. Note up front the decisions only the human can make (they become the RFC's "decisions before handoff" section). If the request is really several independent outcomes, say so and pick the first.

### Phase 2 — Divergent research (parallel sub-agents)

Fan out one read-only sub-agent per thread (the Agent tool, run in the background so they go in parallel). Every researcher must ground findings in **both**:

- **the codebase** — read the relevant files, name paths, and verify the current implementation, and
- **current external practice** — Context7 for any library/framework/API docs, and WebSearch **dated to the current month/year** for fast-moving topics (SEO, model behavior, platform defaults). Cite sources.

Tell each agent to return a **structured findings report** (its final message is the data, not a human-facing note). See `references/agent-prompts.md` for the research-thread scaffold.

### Phase 3 — Converge (the draft)

Synthesize all findings into a draft RFC using the structure in `references/rfc-template.md`. Synthesize the reports around the unifying simplification: the framing or shared primitive that makes the separate threads fall into place. Where findings conflict, resolve them and say why. Write the draft to `docs/rfcs/<topic>.md` with `Status: Draft`.

### Phase 4 — Taste pass

Run the **/taste** skill on the draft. Aim it at the real questions: is the core idea the _elegant_ simplification or is it forcing unrelated concerns together? What's over-engineered, redundant, or missing a simpler path? Is the scope coherent, or should it split? Is the recommendation the timid choice where a bolder one is right? Capture the refinements; they go into the final.

### Phase 5 — Adversarial review panel

Spin up **3–4 sub-agents in distinct critical roles** — pick the roles the work actually needs (e.g. staff engineer, design/brand, a domain specialist such as SEO/GEO or security, product/scope). Prompt each to **refute, not approve**: find what breaks, what's underspecified, what's factually wrong in the draft, and what should decompose. Require code-grounded, live verification of claims by curling endpoints, running builds, and reading the lockfile. See `references/agent-prompts.md` for the reviewer scaffold. Apply every verified error as a factual correction to the final RFC.

### Phase 6 — Finalize

Merge the taste findings and panel critiques — **including their factual corrections** — into the final RFC. Apply the completeness standard below. Flip `Status: Final`, end with the decisions to resolve before handoff, and (optionally) emit a paste-ready `/goal` so a fresh session starts pointed at the finished bar.

## The completeness standard (non-negotiable in the final)

Boil the ocean: **do the whole thing, do it right, with tests and documentation, every thread tied off.** The bar is "holy shit, that's done," not "good enough." Bake this into the final RFC explicitly (a "definition of done" section — see the template):

- **Nothing is deferred or optional.** Every unit ships, complete. Decomposition, sequencing, and separate PRs are _ordering a complete delivery_ — not a menu to cut from.
- **Tests + docs are part of done**, in the acceptance criteria, not a follow-up.
- **The only sanctioned "not now"** is a genuine external-dependency chain (B truly needs A first) or an outcome outside our control (e.g. whether a third party cites you) — and those are stated as **honest scoping, not excuses**. Reframe every "defer / optional / table for later / good enough" toward the complete solve unless it's one of those.
- **Tie off dangling threads** the work surfaces — if a related gap is in reach, close it as part of the delivery.

Apply this completeness standard to every plan this skill produces.

## Scale to the task

Match the machinery to the size. A focused two-surface change: 2–3 research threads, a 3-role panel. A sprawling cross-cutting overhaul: 4–5 threads, a 4-role panel, maybe a second research round if the first surfaces unknowns. The fan-out is genuinely heavy (a full run can spawn ~8–10 agents), so it earns its keep on substantial work and is overkill for a one-file fix. When unsure, lean thorough for research/architecture asks.

## Output

The final RFC lives at `docs/rfcs/<topic>.md` (or `docs/<topic>-rfc.md`). In this repo that file is NON-CANONICAL by AGENTS.md — a plan, never specification — and the scope of that ruling is exactly `docs/rfcs/`, `docs/planning/`, and `docs/*-brief.md` / `docs/*-rfc.md`; the rest of `docs/` is doctrine the codebase defers to, so never write an RFC's claims into one of those. Use the structure in `references/rfc-template.md`. The deliverable is a final, reviewed RFC suitable for implementation handoff. Relay the headline reframes and the open decisions to the user; the document carries the rest.

An RFC is a plan with an expiry date: once its work has SHIPPED, AGENTS.md's prune rule deletes the file rather than flipping it to a done status, and the shipped behaviour is documented in the code and the canon docs instead. Git history keeps the RFC.
