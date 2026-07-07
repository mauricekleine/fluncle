# RFC: Per-track / per-step cost insights — read the number the pipeline already emits; split cash from subsidized

**Status:** Final (divergent research → /taste → a three-role adversarial panel that verified every claim live → completeness-held, 2026-07-07). Backlog item **COST-01** (`docs/followups-backlog.csv`).
**For:** a fresh build session or a team of agents.
**Canon/authority:** the codebase arbitrates; this is planning, not spec (AGENTS.md: `docs/*-rfc.md` is non-canonical). Where this deviates from the code, the code wins.

> Process note: three divergent researchers (instrumentation sources · data-model + write-path · admin surface + external pricing), a /taste pass, and a three-role adversarial panel (staff-eng, box-ops + cost-accuracy, product/scope) that read the real scripts and refuted the draft. They caught real defects — a fixed-cost double-count hidden under an "estimated" flag, an append-ledger idempotency hole the `record_health` precedent masks, a write path that ignored that half the captures already run in the Worker, a CLI capture path unbuildable on the box's baked binary, a stale migration number, two unnamed build-fail coverage edits, effort-ordered phasing that shipped the operator's headline term last, and a self-imposed "no history" that was really recoverable for the biggest bars. All are corrected below; the corrections reshaped the model (one `costBasis: cash | subsidized` axis, two explicit write paths, an idempotency key, a resolution-ordered phasing, a one-time historical estimate). Corrections + live verifications are in the appendix.

## The standard (definition of done)

Boil the ocean: the `cost_events` ledger (table + migration) **plus** the agent-tier `record_cost` write op (idempotent) **plus** the editable `cost-rates.ts` **plus** the per-step capture wired into every metered step across BOTH write paths **plus** the one-time historical estimate **plus** the `/admin/usage` read surface — each with tests + docs. The bar is "holy shit, that's done."

The only sanctioned "not now" is **honest phasing on a genuine internal-dependency chain**: render-_agent-token_ precision and any capture refinements (Phase 2) depend on the Phase-1 spine existing, and they only _sharpen_ numbers that already exist — they never fill a hole in the comparison. COST-02 (the manual subscriptions table) is a **separate backlog item, `Ready`, `M`**; this RFC does not design its table — it only shares a sidebar group with it.

Two things are genuinely out of scope, stated as scoping not deferral: (a) COST-02's subscriptions CRUD; (b) **historical LLM-token cost** for findings authored before instrumentation — those token counts were physically discarded and cannot be recovered (unlike render/compute/TTS history, which is estimable and _is_ backfilled — §7). The archive shows "—" for pre-instrumentation LLM tokens only.

## 0. Summary / the reframe

- **The instrumentation is already done — the pipeline just throws the number away.** The three hybrid authoring sweeps (`note`, `observe`, `newsletter`) already invoke `claude -p … --output-format json` and already `JSON.parse()` the envelope — they read `.result`/`.is_error` and **discard `usage` and `total_cost_usd`, which sit in the same parsed object** (verified: `ClaudeEnvelope` at `note-sweep.ts:108` declares only `{is_error, result, subtype}`). The context-distil step already receives an OpenRouter `usage{prompt_tokens,completion_tokens}` in the response body and reads only `.content`. Cartesia's billable quantity (`sanitizeForCartesia(text).length`) is known at the call site. So "capture usage across a distributed pipeline" is mostly **read the field you already parsed and record it** — not new measurement infrastructure.
- **The one hard idea: separate cash from subsidized — the same guard, applied consistently.** This is the correction that reshaped the RFC. There are two economic natures of "cost," and conflating them corrupts the one number the operator asked for:
  - **`cash`** — real incremental money out the door _because_ this finding ran: OpenRouter (context distil), Cartesia (TTS), Firecrawl, Apify, Resend. Processing one more finding costs this much more.
  - **`subsidized`** — a resource draw under a **fixed plan you pay regardless**: the `claude -p` authoring tokens (Claude subscription OAuth, verified — `total_cost_usd` is API-_equivalent_, not a charge), _and_ all on-box compute (enrich/embed/studio-clip seconds on the always-running rave-02; render box-minutes on the flat-tier rave-03). An extra finding here costs ≈ $0 marginal — the box bill is the same at 10 findings or 1000.

  The draft caught this for subscription LLM ($) and then **walked into the identical trap for on-box compute**, pricing enrich/embed at "box $/hour" as if it were spend — a fixed cost allocated per-finding, double-counting COST-02's box line and inflating every per-finding total by a number the operator cannot cut. The fix is one axis, applied to both: **`costBasis: cash | subsidized`**. The headline "cost per finding" sums **cash only**. Subsidized draws render separately as _fixed-plan usage_ (tokens, seconds, box-minutes) — visible for "evaluate alternatives" and capacity, never summed into the cash total.

- **One ledger, two write paths, one rates file.** The ledger is a `cost_events` append-only table (structural sibling of `serviceCheckSamples`). The two write paths follow _where the vendor call actually runs_ (the box holds **no vendor keys** — verified): **(a) Worker-local** in-process `insertCostEvents()` for context-distil/Firecrawl/Cartesia/Resend (they execute in the Worker — no HTTP, no retry, no 120 s risk); **(b) box→Worker** best-effort, **idempotent** `record_cost` POST only for the genuinely box-side numbers (the 3 `claude -p` token sets, enrich/embed seconds, render conductor minutes). Pricing is one committed `cost-rates.ts`, except `anthropic` rows which store the envelope's own `total_cost_usd` (accurate at the real model/rate — strictly better than a stale local multiply).
- **Two questions, two GROUP BYs.** "Cost per finding" = `SUM(estimated_usd) WHERE cost_basis='cash' GROUP BY track_id`; "cost per step" = `… GROUP BY step` (cash and subsidized in separate columns). Both are SQL aggregations in one `getCostInsights()` lib fn (the `artists.ts` raw-SQL-aggregate precedent), surfaced on `/admin/usage`.
- **Honest calibration up front (the number the feature exists to produce).** Back-of-envelope: the real _cash_ marginal cost of a finding is small — a Firecrawl search (~$0.0016) + an OpenRouter Haiku distil (sub-cent) + a Cartesia observation (~a few hundred chars, cents). The big money is **fixed/subsidized**: the Claude subscription, rave-02, and the flat-tier rave-03 render box — which is COST-02's domain. So COST-01's real value is (1) the small **cash-per-finding** truth, and (2) the **utilization proportions** (where tokens/compute/render-minutes actually go) that inform "is embed worth the box; is video the expensive step." This is exactly why cash and subsidized must not be summed — the interesting answer lives in the split, not a blended total.

## 1. Context & goals

**Why now.** COST-01 is a `Needs-scoping` backlog `L`. The operator wants two numbers from real data — total spend to take one finding add → live, and spend **per automation step** (their words: "video render vs audio-gen vs context-notes vs embed"). The question is _comparative_, and video/render leads their list — so the comparison must be complete and honest on day one, not missing its largest bar. It pairs with COST-02 (the manual subscriptions table) for the full spend picture and "evaluate alternatives."

**Goals, honestly calibrated.**

- In reach, Phase 1 (the spine + every step category at coarse-but-honest resolution): LLM authoring tokens, context-distil tokens, TTS characters, render **box-minutes**, enrich/embed **seconds** — plus the `/admin/usage` read and the one-time historical estimate. Every bar in the comparison exists day one; the split (cash vs subsidized) is honest.
- In reach, Phase 2 (precision only, never hole-filling): render-_agent_ tokens (the one `claude -p` missing `--output-format json`), any per-call refinements. Each sharpens an existing number.
- Reserved, not designed here: COST-02's subscriptions panel, beside COST-01 under a shared "Costs" sidebar group.
- Physically out of reach: pre-instrumentation **LLM-token** cost (discarded). Render/compute/TTS history is recoverable and backfilled (§7).

## 2. Unit 0 — the `cost_events` ledger (ships first, deploys as a no-op)

A new append-only table in `apps/web/src/db/schema.ts`, matching the real idiom (`sqliteTable`, `text`/`integer`/`real` helpers, ISO-string timestamps as `text`, status/enum-ish columns as plain TEXT with an inline `enum` that only _narrows_ the TS type — so widening the vendor/step list needs **zero DDL**). The closest existing shape is `serviceCheckSamples` (`schema.ts:276`): `id` PK + a time index + query-key indexes. **`cost_events` is never pruned** (full history is the point — and the panel confirmed volume is trivial: ~15–20 rows per finding lifetime, dozens/day, far below the pruned `serviceCheckSamples` rate, so unbounded is correct, not a risk).

**One row per unit of work, not per unit-type.** An LLM authoring call emits **one** row (not four rows for input/output/cache) — because the `anthropic` row stores the envelope's `total_cost_usd`, which already prices the full cache breakdown correctly, so decomposing tokens into rows is over-normalization the vendor's own dollar makes unnecessary.

```ts
// An append-only per-step COST ledger — one row per billable unit of work spent on a
// finding (or a non-finding step). Sibling of serviceCheckSamples / statusEvents: id PK
// + occurred_at time index + query keys indexed. NEVER pruned. Written two ways: Worker-
// local insertCostEvents() for Worker-side vendor calls, and the agent-tier record_cost
// POST for box-side numbers (the record_health precedent, MADE IDEMPOTENT — see id).
//
// costBasis is the load-bearing axis: `cash` = real incremental money (headline "cost per
// finding" sums THIS only); `subsidized` = a resource draw under a fixed plan (subscription
// LLM tokens + on-box compute) — shown as usage/proportion, NEVER summed into the cash
// total. source is the ORTHOGONAL quantity-confidence: `measured` (a real usage number or
// a real timestamp diff) vs `estimated` (a rate×count heuristic, incl. the §7 backfill).
export const costEvents = sqliteTable(
  "cost_events",
  {
    // A client-generated STABLE id = the idempotency key. Emitters build a deterministic
    // key (e.g. `${step}:${logId ?? trackId ?? "global"}:${vendor}:${unitType}:${occurredAt}`)
    // so a retried best-effort POST re-inserts the SAME id and is ignored (INSERT OR IGNORE) —
    // an append-only ledger with a retried write DOUBLE-COUNTS without this (the record_health
    // precedent is upsert-shaped and hides the hole; here it must be explicit).
    id: text("id").primaryKey(),
    costBasis: text("cost_basis", { enum: ["cash", "subsidized"] }).notNull(),
    createdAt: text("created_at").notNull(), // ISO write time — kept DISTINCT from occurred_at because a box row's spend time (occurred_at) precedes its Worker write time under clock skew / retry
    // NULLABLE on purpose: a rate-miss (unknown vendor/unit) must surface as "—/unpriced",
    // never launder to $0 (indistinguishable from a genuinely-free row). cash: real $;
    // subsidized: API-equivalent / allocated (never summed into cash); null: unpriced.
    estimatedUsd: real("estimated_usd"),
    logId: text("log_id"), // Log ID snapshot (coordinate-first read); NULL for non-finding steps
    model: text("model"), // e.g. claude-sonnet-4-6 (from modelUsage, never assumed); NULL for non-LLM rows
    occurredAt: text("occurred_at").notNull(), // ISO when the work was spent
    quantity: real("quantity").notNull(), // total tokens / characters / seconds / requests (the step's natural unit; real, since seconds/chars can be fractional)
    source: text("source", { enum: ["measured", "estimated"] }).notNull(),
    step: text("step", {
      enum: [
        "enrich",
        "embed",
        "context",
        "observe",
        "note",
        "video",
        "publish",
        "discogs",
        "lastfm",
        "newsletter",
        "studio-clip",
      ],
    }).notNull(),
    trackId: text("track_id"), // finding id (no declared FK — socialPosts.trackId / user_galaxy_collections.trackId precedent); NULL for non-finding steps
    unitType: text("unit_type", {
      enum: ["tokens", "characters", "seconds", "requests", "emails"],
    }).notNull(),
    vendor: text("vendor", {
      enum: ["anthropic", "openrouter", "cartesia", "firecrawl", "apify", "resend", "self"],
    }).notNull(), // "self" = on-box compute (no invoice → subsidized)
  },
  (table) => [
    // Index the QUERY SHAPE, not every column (the rate_limit_events / submissions composite
    // precedent). The two aggregations group by step / track_id and window by occurred_at;
    // a plain occurred_at serves the global window. No vendor index (nothing groups by vendor).
    index("cost_events_step_occurred_at_idx").on(table.step, table.occurredAt),
    index("cost_events_track_id_occurred_at_idx").on(table.trackId, table.occurredAt),
    index("cost_events_occurred_at_idx").on(table.occurredAt),
  ],
);
```

Keys shown alphabetized (oxlint `sort-keys`); carry `// oxlint-disable-next-line sort-keys` if a grouping is preferred, as elsewhere in the repo. `notNull()` without a DDL default is safe here (the trap only bites `ALTER TABLE ADD COLUMN` on a populated table — this is a brand-new empty `CREATE TABLE`).

**Migration:** `bun run --cwd apps/web db:generate` (drizzle-kit, `out: ./drizzle`). **Do not hard-code the number** — `0051_kind_xavin.sql` is already taken (the full-audio capture columns, PR #359), so this emits **`0052_*` (or higher if others land first)**; commit the generated file + the `meta/` journal entry with the schema change; never hand-write SQL. Deploys as a no-op; Cloudflare auto-migrates on push (`deploy:cf` runs `db:migrate`). No behavior change until Unit 1.

**No `raw_usage_json` column.** The draft parked the vendor blob; the panel cut it as YAGNI once `quantity` + `model` + `estimated_usd` are extracted (the `features_json` precedent doesn't apply — there the vector _is_ the data). Add it later only if a debugging need proves real.

## 3. Unit 1 — the two write paths + `record_cost`

The box holds **no vendor keys** — context-distil (OpenRouter), Firecrawl, Cartesia TTS, and Resend all execute **inside the Worker** (`apps/web/src/lib/server/observation.ts`, `resend.ts`). So the capture surface splits cleanly by _where the vendor call runs_.

### Path A — Worker-local (no HTTP, no retry, no 120 s risk)

For every vendor call that runs in the Worker, capture is a **direct in-process `insertCostEvents([...])` call** in `apps/web/src/lib/server/costs.ts`, right where the response is handled: context-distil (`observation.ts`, read the OpenRouter `usage`), Firecrawl (count the search), Cartesia (`sanitizeForCartesia(text).length`), Resend (recipient count). All `costBasis: cash`, priced from `cost-rates.ts`. No `record_cost`, no best-effort dance — these can't be dropped and can't double-count.

### Path B — box→Worker `record_cost` (idempotent, best-effort, box-side numbers only)

Only the numbers that exist **on the box** need the POST: the 3 `claude -p` authoring token sets (note/observe/newsletter — `subsidized`), enrich/embed seconds (`self`, `subsidized`), and the render conductor minutes (`self`, `subsidized`). Modeled on `record_health` — made idempotent because the ledger is append-only.

- **Contract** — `packages/contracts/src/orpc/admin-costs.ts` mirroring `admin-health.ts`: `recordCost = oc.route({ method: "POST", operationId: "recordCost", path: "/admin/costs/events", tags: ["Admin"] }).input(z.array(CostEventInput)).output(z.object({ ok: z.literal(true), inserted: z.number() }))`. Register in `packages/contracts/src/orpc/index.ts`.

  **`CostEventInput` (pinned — the box supplies the semantic facts it alone knows; the Worker prices):**

  ```ts
  const CostEventInput = z.object({
    id: z.string(),                                   // deterministic idempotency key (see schema)
    step: z.enum([...]),                              // same enum as the column
    vendor: z.enum([...]),
    unitType: z.enum([...]),
    quantity: z.number(),
    costBasis: z.enum(["cash", "subsidized"]),        // known at the call site, NOT inferable from vendor alone
    source: z.enum(["measured", "estimated"]),        // ditto (Cartesia=measured vs Firecrawl=estimated can share a vendor)
    occurredAt: z.string(),                           // ISO
    trackId: z.string().nullish(),
    logId: z.string().nullish(),
    model: z.string().nullish(),                      // LLM rows
    usd: z.number().nullish(),                        // anthropic sends the envelope's total_cost_usd; others omit → Worker prices from cost-rates.ts
  });
  ```

  The Worker sets `createdAt`, sets `estimatedUsd = usd ?? priceFromRates(vendor, unitType, quantity)` (**null** if the rate is unknown — surfaced as unpriced, never $0), and inserts. Same `CostEventInput` is reused by Path A's in-process `insertCostEvents()` (one pricing seam).

- **Router** — `apps/web/src/lib/server/orpc/admin-costs.ts`: `os.record_cost.use(adminAuth).handler(...)` (**not** `operatorGuard` — the box holds the _agent_ token) → `insertCostEvents()` with **`INSERT … ON CONFLICT(id) DO NOTHING`** so a retried POST is a no-op. Wrap errors in `apiFault`.
- **The two coverage-test edits the build REQUIRES (name them — a builder hits two red builds otherwise):**
  - `apps/web/src/lib/server/orpc-admin-coverage.test.ts` — add `"POST /admin/costs/events": "record_cost"` to `ADMIN_ROUTE_OPS` (the exhaustive "holds EXACTLY these ops" map), else _"in the registry but absent from ADMIN_ROUTE_OPS."_
  - `apps/web/src/lib/server/orpc-auth-coverage.test.ts` — add `record_cost: "admin"` to `EXPECTED_TIERS`; the handler must be `.use(adminAuth)` only (no `operatorGuard`) so the derived tier equals the declared one.
  - `orpc-naming.test.ts` needs **no** edit — `record` is already in `APPROVED_VERBS` (added for `record_health`).
- **Auth** — `adminAuth` (`orpc-auth.ts:54`) = any admin principal (operator OR agent); the box's `FLUNCLE_API_TOKEN` env is the agent token, so a POST authenticates as `agent` automatically. No field-level guard needed.
- **The box emitter** — a shared `emitCost(events[])` helper in the sweep-shared TS that builds the deterministic idempotency `id` and does **one** `fetch(\`\${WORKER_URL}/api/admin/costs/events\`, …)`with the agent bearer, a **hard`AbortSignal.timeout(2500)`**, and **zero retries** (idempotency would make a retry safe, but the 120 s kill window — verified, observe/note already run `BATCH_CAP=1`because one authoring+TTS pass ≈ the budget — means we must not spend budget re-POSTing; emit once, after the real work is durable, and move on).`emitCost` is wrapped so it **cannot throw and cannot block past the timeout** — capture is in-process (the envelope is already parsed), no extra process spawn.

  **Named tension (honest lossiness, not a silent bug):** because the emit is best-effort _after_ the finding is already flipped to its done-state, a dropped POST is a permanently-lost row (the next sweep skips the already-done finding). This is acceptable for a spend _ledger_ (a missing row understates, never overstates, and never corrupts the pipeline). If exactness ever matters more, the escape hatch is a small durable spool on the box drained by a cron — noted, not built.

**No `fluncle admin costs record` CLI subcommand.** The draft recommended one; the panel killed it: the box runs a **baked** `fluncle` CLI that lags `main` (documented — the social-capture sweep POSTs its endpoint directly _because_ the baked CLI predates the verb, `cron/README.md:99`), so a new verb isn't callable on the box until the next image re-bake. Direct POST is the **only** Phase-1 path; the shared `emitCost()` helper is the DRY seam.

## 4. Unit 2 — the rates config (`cost-rates.ts`)

Greenfield: `apps/web/src/lib/server/cost-rates.ts`, a committed, world-readable TS map of per-vendor, per-unit USD rates. Legitimate config, not a secret (AGENTS.md bans secret _values_ and the secret _map_; published list prices grant nothing). Concrete _spend_ stays in the DB; the _multiplier_ is config.

**Scope it narrowly** — it prices only vendors that return **no dollar**: Cartesia (per character), Firecrawl (per search), Resend (per email), and `self` on-box compute (per second). **`anthropic` rows do NOT use it** — they store the envelope's own `total_cost_usd` (computed by the CLI at the _actual_ model's _actual_ rate; and the `subsidized` framing means it's the API-equivalent figure anyway). This dodges the draft's bug where the seed headlined **Opus 4.8** while the box actually runs **`claude-sonnet-4-6`** (verified: `note-sweep.ts:71`, `observe-sweep.ts:68`, `newsletter-sweep.ts:69`) — a model not even in the seed table. **A rate-miss returns `null`, not `0`** (§2) so a new/unknown vendor-unit is visibly unpriced.

Seed values (⚠️ **editable, drift-y, NOT authoritative** — pull live from the `claude-api` skill / Context7 at build time; cited July 2026):

| Vendor · unit                                       | Seed rate (Jul 2026)                             | costBasis    | Notes                                                           |
| --------------------------------------------------- | ------------------------------------------------ | ------------ | --------------------------------------------------------------- |
| OpenRouter Haiku (context distil) in/out per 1M tok | pass-through of the model rate                   | `cash`       | the one genuinely metered LLM call                              |
| Cartesia Sonic TTS per character                    | ≈ 1 credit/char (≈ $0.03/min)                    | `cash`       | no cost field in the SSE response; count chars at the call site |
| Firecrawl search per call                           | ≈ 2 credits/10 results (≈ $0.0016)               | `cash`       | no credit field; 1 search/finding when queued                   |
| Resend per email                                    | ≈ $0.0009/email (Pro overage)                    | `cash`       | recipient count from the segment                                |
| `self` on-box compute per second                    | box $/hour ÷ 3600 (Decision #B)                  | `subsidized` | **utilization, not cash** — an allocation of a fixed bill       |
| `anthropic` authoring tokens                        | _(use envelope `total_cost_usd`, not this file)_ | `subsidized` | subscription OAuth → API-equivalent, never a charge             |

Postiz is a flat seat → COST-02, not a per-unit rate. Gemini/Nano-Banana is a one-time creative-asset flow (sprites/art), **not** per-finding → excluded.

## 5. Unit 3 — capture per step (the instrumentation map)

`M` = a real usage number or timestamp diff exists; `E` = rate × count. **Path A** = Worker-local insert; **Path B** = box POST.

| Step                           | Where                                           | Vendor             | Unit               | costBasis · source · path  | Capture                                                                                                                                                                                                                                                                                                                              |
| ------------------------------ | ----------------------------------------------- | ------------------ | ------------------ | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **note**                       | `note-sweep.ts:264/297`                         | anthropic          | tokens             | subsidized · M · **B**     | Add `usage`+`total_cost_usd`+`modelUsage` to `ClaudeEnvelope` (:108); read after `JSON.parse`. Send `usd = total_cost_usd`, `model` from `modelUsage`. Zero new flags.                                                                                                                                                               |
| **observe** (author)           | `observe-sweep.ts:252/285`                      | anthropic          | tokens             | subsidized · M · **B**     | Same change (type :104).                                                                                                                                                                                                                                                                                                             |
| **observe** (TTS)              | `observation.ts` `renderObservationCartesia`    | cartesia           | characters         | cash · M · **A**           | `sanitizeForCartesia(text).length`; derive seconds from last word timestamp. Worker-local insert.                                                                                                                                                                                                                                    |
| **context** (distil)           | `observation.ts` `distilContextNote`            | openrouter         | tokens             | cash · M · **A**           | The response body carries `usage{prompt_tokens,completion_tokens}` but the `OpenRouterChatResponse` type doesn't model it and the code reads only `.content`. **Extend the type + read `usage`**, then insert. (Pricing from token counts sidesteps OpenRouter's `usage:{include:true}` cost flag — "zero new request flags" holds.) |
| **context** (Firecrawl)        | `observation.ts` `fetchTrackContext`            | firecrawl          | requests           | cash · E · **A**           | No credit field; 1 search when queued. Worker-local insert.                                                                                                                                                                                                                                                                          |
| **newsletter**                 | `newsletter-sweep.ts:355/388`                   | anthropic          | tokens             | subsidized · M · **B**     | Same envelope change (type :112). Non-finding (`track_id` NULL).                                                                                                                                                                                                                                                                     |
| **enrich**                     | `enrich-sweep.ts:140`                           | self               | seconds            | subsidized · **M** · **B** | Wrap the analyze call in a start/stop stamp — the **quantity is measured** (a real duration); only the $/s rate is fuzzy (that's a rate property, not `source`). Emit via `emitCost`.                                                                                                                                                |
| **embed**                      | `embed-sweep.ts`→`embed-track.py`               | self               | seconds            | subsidized · M · **B**     | Per-item timing (the py already loops).                                                                                                                                                                                                                                                                                              |
| **video/render**               | `render-conductor.sh` / `render-detached.sh:20` | self (+ anthropic) | seconds (+ tokens) | subsidized · M · **B**     | Box-minutes = the render's **own** `date -u` stamp in `conductor-run.done` (`render-detached.sh:22`), **not** the wake→detect delta (which folds in ~an hour of idle-wait before the next hourly tick detects the marker). rave-03 is flat-tier ($20/555 box-hr) → subsidized. Render-_agent_ tokens are **Phase 2**.                |
| **studio-clip**                | `clip-sweep.ts`                                 | self               | seconds            | subsidized · M · **B**     | On-box ffmpeg. Non-finding (set-level).                                                                                                                                                                                                                                                                                              |
| **publish / discogs / lastfm** | `postiz.ts` / `backfill-sweep.ts`               | —                  | —                  | omit                       | Flat-subscription (Postiz→COST-02) or free (Discogs/Last.fm). Not cash; omit from the ledger.                                                                                                                                                                                                                                        |

**Render-agent tokens (Phase 2, with a real tradeoff — Decision #C).** `render-detached.sh:20` is the only pipeline `claude -p` without `--output-format json` (output scraped as a streaming log). Adding the flag captures the render-agent tokens (also `subsidized` — injected subscription OAuth, `render-conductor.sh:276`), **but** it turns `conductor-run.log` from a tail-able live log into a single end-of-run JSON blob, losing progress visibility during an ~85-min render. Deferred to Phase 2, gated on the operator accepting that regression (or a tee/two-stream workaround).

## 6. Unit 4 — the read surface (`/admin/usage`)

- **Decoupled from COST-02.** The draft forced "one route, two panels"; the panel refuted it — the two share only the operator's mental model, not data, write path, auth tier, currency, or ship schedule. Coupling them dragged COST-02's per-row `currency` into COST-01 and invented a cross-basis combined total that _is_ the double-count the RFC guards against. **Two routes under one "Costs" `SidebarGroup`** (the exact ADM-01 pattern in the same backlog): `/admin/costs` = COST-02 subscriptions (ships first, independently — it's `Ready`), `/admin/usage` = COST-01. No combined cross-basis total.
- **Route** `apps/web/src/routes/admin/usage.tsx`, mirroring `renders.tsx`: `beforeLoad: () => ensureAdmin()`, a `createServerFn({ method: "GET" })` loader calling `getCostInsights()` from `@/lib/server/costs.ts` in-process (the browser-admin pattern — no oRPC client), seeded into `useQuery({ initialData, refetchOnWindowFocus: true })`. Wrapped in `<AdminShell current="usage" title="Usage & cost" subtitle="…cash MTD · …subsidized draw">`.
- **Aggregation is SQL GROUP BY** in `getCostInsights()` — the `listArtistsWithFindingCounts` precedent (`artists.ts:191`) uses `getDb()` + `db.execute({ sql })` + manual `result.rows` casting (not the `typedRows` helper, which lives in the feed routes) — copy that raw-SQL-aggregate shape: one query `SUM(estimated_usd) FILTER (cost_basis='cash'), SUM(...) FILTER ('subsidized'), COUNT(*) GROUP BY step` (per-step rollup, cash and subsidized in separate columns), one `… GROUP BY track_id ORDER BY cash DESC LIMIT n` joined to `tracks` (per-finding top-N). Windowed by `occurred_at`. Unpriced (`estimated_usd IS NULL`) rows are counted separately, never summed as 0.
- **The read is a per-step rollup + a per-finding top-N LIST — not a finding×step matrix.** "Cost per finding" (Q1) is _one cash number per finding_ → a sortable top-N list (the existing `renders.tsx` row + `bg-card/60` BoxCell tile patterns, `tabular-nums`). "Cost per step" (Q2) is the per-step tile row (cash | subsidized-draw columns). The draft's finding×step matrix exceeded the brief and dragged in a **new Shadcn `Table` primitive** — both cut. (REF-04 in the backlog adds a Table primitive elsewhere; COST-01 doesn't need it, sidestepping the `packages/ui` vs `components/ui` home question entirely.)
- **Sidebar** — add `"usage"` to `AdminNavCurrent` (`admin-sidebar.tsx:53`); put the two entries in a **System-area** "Costs" `SidebarGroup`. Phosphor money glyph (regular idle / fill active). **No count badge** (aggregates aren't cheap honest counts — the doctrine keeps them off the rail).
- **The split renders as the split.** Cash spend is the headline stat; subsidized draw is a separate, clearly-labeled column ("fixed-plan usage — already in Subscriptions"), never added to cash. `source: estimated` and unpriced rows carry a subtle confidence marker so a guess never reads as a fact.
- **oRPC read op — not required for the browser** (a `createServerFn` is a TanStack server RPC, not a `/routes/api/**` file-route, so the coverage tests don't force a contract — verified: the coverage nets enumerate `routes/api/admin/**` + the contract registry). Add an `adminAuth` `get_cost_insights` (`GET /admin/usage`, which resolves under `/api/v1/admin/usage`, distinct from the HTML route — no collision) only when a non-browser consumer lands (a `fluncle admin usage` CLI or a weekly cost-report cron), wrapping the same `getCostInsights()` lib fn.

## 7. Unit 5 — the one-time historical estimate

The draft called all history "physically unrecoverable." That's true **only for LLM tokens** (discarded). For the biggest bars it's a recoverable estimate — the _same_ `count × avg-rate` the RFC sanctions going forward, just pointed backward, badged `source: estimated`:

- **Render** — every rendered finding has a timestamp; `count × avg render-minutes × $/hr` (`subsidized`).
- **enrich / embed** — every finding was analyzed/embedded; `count × avg-seconds × $/hr` (`subsidized`).
- **Cartesia TTS** — observation text is stored; `char-count × rate` per existing observation (`cash`, fully recoverable).

A one-time seed script (`apps/web/scripts/backfill-cost-history.ts`, run once, idempotent via the same event-id key) writes these rows so the operator gets the **complete comparison on day one** rather than waiting weeks for a low-volume archive to accumulate. Only pre-instrumentation **LLM authoring tokens** stay "—". This is the fastest honest path to the operator's actual question.

## Sequencing & ownership

**Phase 1 — the spine + every step category at coarse, honest resolution (complete comparison, day one):**

1. Unit 0 — `cost_events` + migration (no-op deploy).
2. Unit 2 — `cost-rates.ts` seed + the pricing fn (vendors-without-$ only; null on miss).
3. Unit 1 — `record_cost` (idempotent) + the two coverage-test edits + `insertCostEvents()` + the box `emitCost()` helper + both write paths.
4. Unit 3 (all categories, coarse): the already-in-envelope LLM captures (note/observe/newsletter, Path B) + context-distil + Cartesia + Firecrawl + Resend (Path A) + enrich/embed seconds + **render box-minutes** (Path B). Render-agent-_tokens_ excluded (Phase 2).
5. Unit 5 — the one-time historical estimate.
6. Unit 4 — `/admin/usage` (per-step rollup + per-finding top-N; the split rendered as the split; System-area "Costs" group).

Phase 1 answers **both** headline questions with **all** step categories present and the cash/subsidized split honest.

**The single most de-risking move:** wire ONE step end-to-end first — `note` (the cheapest, already-JSON step) → schema → `record_cost` (idempotency key) → a row visible on `/admin/usage` — before fanning out. It proves the whole spine (idempotent write, pricing, the split, the read) on the safest step. **Riskiest change to watch:** Unit 3's box-side capture is wired into live production authoring crons — the acceptance test must assert `emitCost` cannot throw and cannot block past its timeout, because a hung/throwing emit would stall a public-content cron despite the "swallow" intent.

**Phase 2 — precision only (never hole-filling):** render-agent tokens (the `--output-format json` add, gated on Decision #C), per-call refinements. Each sharpens a number Phase 1 already shows.

**Phase 3 — the pairing:** COST-02's subscriptions route lands beside `/admin/usage` under the "Costs" group; optionally the `get_cost_insights` oRPC op + a weekly cost-report cron.

**Deploy discipline:** each unit is its own PR; a push to `main` auto-deploys and the migration auto-applies — space the merges (coalescing note, AGENTS.md).

## Decisions needed BEFORE handoff

The panel resolved most of the draft's list from the codebase/canon; only genuine operator inputs remain.

- **A. The cash/subsidized presentation.** Confirm: headline "cost per finding" = **cash only**; subsidized (subscription LLM `total_cost_usd` + on-box compute) shown as a separate _fixed-plan usage_ column, never summed into cash. (Recommended — the only way "cost per finding" is a number the operator can act on. Alternative: drop $ on subsidized rows entirely, show pure utilization — tokens/seconds/box-minutes.)
- **B. The `self` $/second rate** (and whether subsidized compute gets a $ at all). rave-02 is fixed 24/7; rave-03 is a flat $20/555-box-hr tier — any `self` dollar is an _allocation_ of a fixed bill, not marginal cash. Provide the amortized figure if you want a $ shown; otherwise elect utilization-only. A wrong constant only rescales a column already fenced out of the cash total.
- **C. Render-agent token capture (Phase 2).** Accept turning the ~85-min render's `conductor-run.log` into an end-of-run JSON blob (losing live tail) to capture render-agent tokens — or keep the live log and leave render at box-minutes only. (Render tokens are `subsidized` regardless, so the cash total is unaffected either way.)
- **D. Run the historical estimate (§7)?** Recommended (complete comparison day one), but it writes `estimated` rows to prod, so it wants operator sign-off.

Resolved by the panel (no longer decisions): migration number is whatever `db:generate` emits (currently `0052`, not `0051`); `track_id` nullable (non-finding steps must log); the Worker prices vendors-without-$ / `anthropic` uses its envelope $ (thin-client canon); `estimatedUsd` nullable (a rate-miss is unpriced, not $0); route split (`/admin/costs` = COST-02, `/admin/usage` = COST-01, one group); no Shadcn Table primitive (matrix descoped); no CLI subcommand (baked-CLI reality); ledger is USD-only (currency decision evaporated with the decouple); idempotency key + `INSERT OR IGNORE` (just build it); `CostEventInput` fields pinned in §3; the two coverage-test edits named in §3.

## Acceptance criteria

- `cost_events` + the generated migration (whatever number `db:generate` emits) committed together; `db:generate` no-diff on re-run.
- `record_cost`: contract + router + auth tier + `index.ts` registration + the `ADMIN_ROUTE_OPS` and `EXPECTED_TIERS` edits; passes `orpc-admin-coverage`/`orpc-auth-coverage`/`orpc-naming`. Agent token can POST; anon 401s. **Idempotency tested:** the same event id POSTed twice inserts once. `emitCost` cannot throw and cannot block past the 2.5 s timeout (unit test both).
- Two write paths tested: a Worker-side vendor call (context-distil) inserts in-process with no HTTP; a box-side number arrives via `record_cost`.
- `cost-rates.ts` prices a known cash payload to the expected USD (test); an unknown vendor/unit returns `null` → the row is stored unpriced, not $0 (test); `anthropic` rows store the envelope `total_cost_usd` verbatim with `model` set from `modelUsage` (test).
- Captures wired (Phase 1): note/observe/newsletter emit one `subsidized` token row each with `model` set; context-distil/Cartesia/Firecrawl/Resend emit `cash` rows; enrich/embed/render emit `subsidized` `self` rows; render box-minutes read from the marker's own stamp, not the detect-delta (test).
- `/admin/usage` renders per-step rollup (cash | subsidized columns) + per-finding top-N from real rows; `getCostInsights()` aggregates in SQL (test the GROUP BYs + the `cost_basis` filter + unpriced exclusion); `requireAdmin` gates the route; **cash and subsidized are never summed** (test the header math).
- Historical estimate script runs once, idempotent, badges rows `estimated`; leaves LLM-token history empty.
- Docs: `docs/agents/hermes/cron/README.md` gains a cost-capture line per instrumented cron; `docs/admin-shell.md` gains `/admin/usage` + the "Costs" group; `docs/track-lifecycle.md` notes the ledger. `cost-rates.ts` header states rates are editable config (not authoritative) and actuals live in the DB. `docs/followups-backlog.csv` COST-01 flipped from `Needs-scoping`.

## Risks & open questions

- **The cash/subsidized split is the whole correctness story.** If subsidized $ ever leaks into the cash total, "cost per finding" inflates by a number the operator can't cut (the exact defect the panel caught in the draft). The `cost_basis` column + the never-sum rule + the header-math test are the guard, applied to **both** fixed sources (subscription LLM _and_ on-box compute) symmetrically.
- **Append-ledger double-count.** A retried best-effort POST would double-count without the idempotency key; the client-generated stable `id` + `INSERT OR IGNORE` closes it. (The `record_health` precedent's retry-safety is an upsert artifact that does not transfer — verified.)
- **Best-effort lossiness (undercount) is accepted, documented.** A dropped POST is a permanently-lost row (the next sweep skips the done finding); a ledger that undercounts never corrupts the pipeline and never overstates. The durable-spool escape hatch is named, not built (§3).
- **Rate-miss must not read as free.** `estimatedUsd` nullable + an "unpriced" surface keeps a missing rate visible instead of a laundered $0.
- **120 s kill window.** observe/note already run at the budget ceiling (`BATCH_CAP=1`). Capture is in-process + one POST with a 2.5 s hard timeout + zero retries, emitted after the real work is durable.
- **Render duration ambiguity.** Read the render's own stamp, not the wake→detect delta (folds in idle-wait). Labeled box-minutes (a subsidized draw), not cash.
- **Rate drift.** Seed rates go stale monthly; operator-editable config, history frozen at price-of-record; `source`/`cost_basis` badges keep confidence legible. `anthropic` sidesteps this (uses the vendor's own $).
- **Forward-only LLM history.** Only LLM tokens show "—" pre-instrumentation; render/compute/TTS are backfilled (§7).
- **Volume is a non-issue.** ~dozens of rows/day, never-pruned is correct (panel-confirmed against the higher-volume pruned `serviceCheckSamples`).

## Appendix — verifications & sources

- **Live CLI envelope probe** (research), `claude` v2.1.202, `-p … --output-format json`: top-level keys include `usage`, `total_cost_usd`, `modelUsage`, `duration_ms`; a sample run showed `input_tokens: 9`, `cache_read: 17294`, `cache_creation: 21963`, `total_cost_usd: 0.0459` — confirming cache-token dominance (hence: store the envelope's own $, don't re-multiply raw input tokens) and that note/observe/newsletter parse-then-discard `usage`/`total_cost_usd`.
- **Panel live verifications:** `0051_kind_xavin.sql` already exists (full-audio capture, PR #359) → the ledger migration is `0052+`, not `0051`; the two coverage tests are exhaustive maps (`orpc-admin-coverage` `ADMIN_ROUTE_OPS`, `orpc-auth-coverage` `EXPECTED_TIERS`) that fail the build until `record_cost` is added to both; `record` is already in `APPROVED_VERBS` (`orpc-naming.test.ts`); subscription-auth CONFIRMED (note/observe/newsletter-sweep headers: "SUBSCRIPTION auth via `CLAUDE_CODE_OAUTH_TOKEN`, NOT OpenRouter"); `ClaudeEnvelope` discards usage CONFIRMED (`note-sweep.ts:108`); render `--output-format json` gap CONFIRMED (`render-detached.sh:20`); 120 s kill window + `BATCH_CAP=1` CONFIRMED (`cron/README.md:161,472`); rave-03 flat $20/555-box-hr tier CONFIRMED (README:198,244); box holds no vendor keys → context/Firecrawl/Cartesia/Resend run Worker-side CONFIRMED (README:57,75,97; `observation.ts`); baked-CLI lag kills a new box CLI verb CONFIRMED (README:99); box model default = `claude-sonnet-4-6` CONFIRMED (`*-sweep.ts:68–71`); render `claude -p` on subscription OAuth CONFIRMED (`render-conductor.sh:276`); render duration recoverable from the marker's own stamp CONFIRMED (`render-detached.sh:22`); `createServerFn` needs no oRPC contract + `/api/v1/admin/usage` vs the HTML route = no collision CONFIRMED (`orpc.ts` dual-mount); the `artists.ts:191` aggregate uses `db.execute` + manual row casting (not `typedRows`).
- **Data-model precedents:** `schema.ts` — `serviceCheckSamples:276`, `statusEvents:254`, `rateLimitEvents:505` (append-only ledger + composite `(action,bucket,created_at)` index precedent); `tracks.trackId:146` PK + `logId:100`; `socialPosts.trackId:642` / `user_galaxy_collections.trackId` (no-FK child); JSON-column idiom `features_json`/`embeddingJson:86`. Migrations: `apps/web/drizzle/` (`0051_kind_xavin` latest), `drizzle.config.ts`, `package.json:10,17`.
- **Write-path precedents:** `record_health` (`packages/contracts/src/orpc/admin-health.ts:52`, `apps/web/src/lib/server/orpc/admin-health.ts:54`), `record_live_state` (`admin-twitch.ts`); box best-effort POST `fluncle-healthcheck.ts:846-877`. Auth: `orpc-auth.ts:54-88` (`adminAuth` agent-allowed, `operatorGuard` operator-only), `env.ts:189-238`.
- **Surface precedents:** `routes/admin/renders.tsx:80-133,184,248,364` (admin route + SSR-seeded query + BoxCell tiles + row list), `routes/admin/artists.tsx:43` (lib-fn loader); `artists.ts:191-215` (raw-SQL GROUP BY aggregate); `components/admin/admin-sidebar.tsx:53,117,218` (nav union + System entry + the ADM-01 `SidebarGroup` pattern); `packages/ui/src/components/` (no `table.tsx` — deliberately not added).
- **External pricing (July 2026, editable-config seed, NOT authoritative):** Cartesia — cartesia.ai/pricing; Firecrawl — firecrawl.dev/pricing; Apify — apify.com/pricing; Resend — resend.com/pricing; Claude (reference only; rows use the envelope's own $) — `claude-api` skill; Gemini image — ai.google.dev/gemini-api/docs/pricing; Postiz — postiz.com (flat seat → COST-02).
