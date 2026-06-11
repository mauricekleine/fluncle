# Agent prompt scaffolds

Reusable shapes for the two fan-out phases. Adapt the bracketed parts; keep the spine (ground in code, verify live, return structured findings). Launch agents in the background so each phase runs in parallel.

## Phase 2 — divergent research thread

One per non-overlapping thread. Read-only.

```
Read-only research (change nothing). Produce <the specific finding this thread owns> for an RFC — be concrete and specific; this feeds a synthesis.

Ground in BOTH:
- The codebase — read the real files (<name the likely paths/areas>); verify what exists today, name paths, don't theorize about code you can read.
- Current external practice — Context7 (resolve-library-id → query-docs) for <library/framework> docs; WebSearch dated to <current month, year> for <fast-moving topic>. Cite sources.

Deliver a structured markdown findings report covering: <the 3–5 questions this thread must answer>. Flag the constraints and the open decisions you surface. Your final message IS the data (not a human-facing note).
```

Good threads are **non-overlapping** (no two agents chasing the same files/topic) and **answerable independently**. Typical splits: one per subsystem, one per concern (data / routing / UI), one per external domain (SEO / a vendor API / a spec). Tell each agent what the *others* are covering so they stay in their lane.

## Phase 5 — adversarial reviewer (one per role)

3–4 of these, each a distinct critical role. The framing must be **refute, not approve**.

```
You are a skeptical <ROLE — e.g. STAFF ENGINEER / DESIGN-BRAND DIRECTOR / SEO-GEO SPECIALIST / PRODUCT-SCOPE LEAD> doing an ADVERSARIAL review of an RFC. Read `<path-to-draft-rfc>` in full, and ground yourself in the relevant code (<paths>). <One line of domain context.>

Critique it as someone who has to live with the consequences. Be specific and adversarial — find what will BREAK, what's underspecified, what's factually WRONG in the draft, and what should decompose:
- <3–6 role-specific probes — the things this role is uniquely positioned to catch.>
- VERIFY load-bearing claims live (curl the endpoint, run the build, read the lockfile/source) rather than trusting the draft. Quote what you find.

Return a structured, prioritized critique with concrete fixes/additions for the RFC. Read-only; change nothing.
```

### Choosing roles
Pick the lenses the work actually has stakes in. A safe default quartet for product/web work:
- **Staff engineer** — does the approach actually work in the installed versions; the concrete component/route/data structure; what's underspecified enough to block a builder; the riskiest single change.
- **Design / brand** — does it deliver the intended change or just polish; canon conflicts; information architecture; what it should *look* like.
- **Domain specialist** (SEO/GEO, security, performance, a11y, data) — the deep correctness of the specialized claims; what the draft oversells or misses; realistic horizons.
- **Product / scope** — decompose vs bundle; sequencing; what to do first; what's gold-plating; whether it serves the real goal.

Swap roles to fit: an API change wants security + DX + reliability lenses; a data migration wants a DBA + a correctness reviewer + a rollback skeptic.

### Why "verify live" matters
The reviewers that earn their keep don't just opine — they `curl` the page and find the draft claimed two bugs when there's one, or read the lockfile and find the version pinned in the RFC is wrong, or run the build and find both feature sets compile together. Demand evidence, not opinion. A panel that only theorizes is a worse version of the author.
