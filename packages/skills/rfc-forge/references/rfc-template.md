# RFC template

The section structure for the final RFC. Adapt to the work — drop sections that don't apply, add domain ones that do — but keep the spine: a synthesized plan, stress-tested, held to completeness, ending in the decisions a human must make.

```markdown
# RFC: <topic> — <one-line scope>

**Status:** Draft → Final (research → /taste → N-role adversarial panel synthesized, <date>) — completeness standard applied.
**For:** <who executes — a fresh build session / a team of agents>.
**Canon/authority:** <the docs + the codebase that arbitrate; this is planning, not spec>.

> Process note: divergent research (<threads>), a /taste pass, and a <N>-role adversarial review (<roles>). Their corrections and reframes are baked in; verifications in the appendix.

## The standard (definition of done)

<The completeness block from SKILL.md, restated for this work: nothing deferred/optional; tests + docs part of done; the only sanctioned "not now"; the dangling threads this build ties off.>

## 0. Summary / the reframe

<2–6 bullets. Lead with the unifying simplification — the one idea that makes the rest fall into place. If the panel decomposed the work into units/tracks, show that decomposition here (what's truly coupled vs falsely coupled vs independent).>

## 1. Context & goals

<Why now; the goals; and — critically — an HONEST calibration of which goals are in reach vs. which are outcomes outside our control (state the realistic horizon, don't oversell).>

## 2..N. The units / workstreams

<One section per coupled unit. For each: the decision/direction, the concrete plan (name files, APIs, patterns), the corrections from the panel, and the edge cases a builder will hit. Order by dependency. Mark what ships first.>

## Sequencing & ownership

<The fan-out: what ships day one (ideally a zero-decision unblock), the critical path, what parallelizes across agents, deploy discipline, and the ONE thing that de-risks the most.>

## Decisions needed BEFORE handoff

<Numbered. The calls only the human can make — resolve these before the build starts, not during, or a sub-agent will block or guess. This is the single biggest executability gap in most RFCs.>

## Acceptance criteria

<Verifiable checks, incl. tests and docs as first-class items. Separate true ship-gates from weeks-out monitoring outcomes — don't block ship on the latter. Capture any "before" baseline now.>

## Risks & open questions

<The failure modes, the most-likely-to-go-wrong, the entity/external risks, the honest-scoping caveats.>

## Appendix — verifications & sources

<The panel's live verifications (what was curled/run/read), and cited sources dated to the current month for fast-moving topics.>
```

## Notes on filling it in

- **The unifying simplification earns the most.** If you can't name one, the scope may genuinely be several RFCs — say so.
- **Falsely-coupled vs truly-coupled** is the decomposition lens the panel will press on: two things sharing a URL/file/name aren't coupled if they serve different consumers. Decouple them into separately-shippable units even if one document covers both.
- **Decisions-before-handoff is load-bearing.** An RFC that leaves the URL shape / the naming / the scope boundary "to be decided during the build" hands a sub-agent a coin-flip. Force the calls up front.
- **Completeness ≠ no sequencing.** Separate PRs and an ordered critical path are how a _complete_ delivery ships safely. The standard forbids cutting achievable work, not staging it.
