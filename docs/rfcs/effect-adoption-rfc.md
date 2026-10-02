# RFC: Adopt Effect 4 in Fluncle's server code

**Status:** in flight. Delete this file when wave 2 ships or the adoption stops (see _Stop rule_).
**Scope:** `apps/web/src/lib/server/**` and `apps/cli`. Contracts, mobile, extension, raycast and every client chunk stay Effect-free.

## The problem

Fluncle's server code reimplements the same resilience primitives by hand, and each copy behaves slightly differently:

- About 8 retry implementations: `retry.ts` (linear), `spotifyFetch` (Retry-After plus a time budget), `deezer.ts` (delay array), `musicbrainz.ts` (503 only), `db.ts` `runWithRetry` (jitter plus cause-chain sniffing), `follow-digest.ts` (exponential).
- About 14 timeout sites in three styles: `AbortSignal.timeout`, `AbortController` plus `setTimeout`, and `Promise.race`.
- 11 private `sleep` copies.
- A throttle duplicated verbatim in `musicbrainz.ts` and `discogs.ts`.
- 5 near-identical OAuth refresh flows. Only Spotify handles a concurrent `invalid_grant`.
- 3 breakers persisted in settings (Spotify anchor, Apple auth, Spotify quota hold).
- A database concurrency gate that polls every 1 ms.

Errors are mostly untyped:

- 62 `{ ok: false }` unions.
- 26 empty `catch {}`.
- 51 `.catch(() => null)`-style swallows.
- `quotaExceeded` duck-typed onto an `Error`, and `message.includes("429")` string sniffing.
- `ApiError` lives in `spotify.ts` and is imported by 50 files.

Effect 4 (`effect@4.0.0`, published 2026-10-01) has typed errors, `Schedule`, `Effect.timeout`, `Semaphore`, `Layer` and a test clock in one zero-dependency package. It claims about 7 kB gzipped and a 5x smaller footprint than v3.

## Decisions

1. **Effect inside, Promise outside.** Every migrated module keeps its exported Promise API until all of its callers are Effect, so no slice forces a change on a caller in another slice. The `runPromise` edge lives in one helper.
2. **One `ManagedRuntime` per isolate**, built lazily at module scope from infra layers only (today: the logger). Never create a runtime per request.
   - Per-request state (the DB client, leases) stays on the existing `AsyncLocalStorage` scope in `server.ts`.
   - Effect reaches that state through a thin service over `getDb()`.
3. **Errors use `Data.TaggedError`.** `Schema.TaggedError` pulls in the whole `Schema` module. In the pilot it added 141 KB (33 KB gzipped) to the Worker bundle on top of the 255 KB (60 KB gzipped) that the Effect core itself costs. `Schema` comes in when a slice needs to decode untrusted data, not for error classes. `runServerEffect` rejects with the failure itself, so `ApiError` and `apiFault` keep working at the boundary. `encodeErrorBody` and the wire format do not change.
4. **No change to the data layer.** Keep the libsql client, the `instrument()` proxy, drizzle and the raw-SQL call sites. `@effect/sql-drizzle` has no v4 release, and the proxy carries Sentry spans, the gate and retries for about 3,000 call sites.
5. **Contracts stay on zod.** Effect Schema would leak `z.infer` breakage and runtime weight into every consumer, including mobile. Effect Schema can implement Standard Schema through `Schema.toStandardSchemaV1` if a later case justifies it.
6. **No Effect in client chunks.** Extend the `fluncle-client-chunk-purity` gate to fail when `effect` reaches a client chunk. `recording-upload.ts` (browser) stays out for now.
7. **Out of scope by default:** `database-admission.ts`, `database-operation-registry.ts`, the `due-work*` and `crawl*` families, better-auth, `edge-cache.ts` SWR internals, TanStack server-function internals, and the Vercel AI SDK. Each needs its own proposal with evidence from earlier waves.

## Constraints found

- **Install date.** `bunfig.toml` enforces a 3-day `minimumReleaseAge`, and `effect@4.0.0` was published 2026-10-01. The foundation PR adds `effect`, `@effect/tsgo` and `@effect/vitest` to `minimumReleaseAgeExcludes`, with a comment in the style of the `cf` entry. Once 4.0.0 is past the age window, a follow-up PR removes them so later Effect releases go through the normal hold.
- **Typecheck.** No editor plugin. `@effect/tsgo` (0.47.2, which supports exactly TS 7.0.2) runs as a separate CI `diagnostics` step, which keeps the main typecheck independent of it. It catches v3 APIs and floating effects that agents would otherwise ship.
- **Lint.** The oxlint Effect patch needs oxlint 1.82 or later, and the repo has 1.80. Skip it.
- **Tests.** `@effect/vitest@4.0.0` needs vitest `>=5 <6`. `apps/web` moves from `~4.1.11` to `~5.0.2` (5.0.3 is inside the age window until 2026-10-03 11:31 UTC), together with `@vitest/coverage-v8`. Effect tests use `it.effect` and the test clock.
- **Workers startup CPU.** Effect issue #8038 (module-scope `Effect.fn` costs) is fixed upstream. Measure startup CPU on the real bundle anyway, and don't use `HttpApp.toWebHandler*`: issue #6319, first-request layer build hangs the isolate.
- **No fiber may wake another request's fiber.** In workerd, when request A's fiber wakes request B's fiber through a shared `Deferred`, `Semaphore`, `Queue`, `Pool` or `Latch`, B hangs until the runtime cancels it. The same happens to a request that waits on a shared `ManagedRuntime` whose layer is still building asynchronously (upstream issue #6319). Upstream's async-context fix (Effect-TS/effect#8629) does not change this; it was checked against both builds under `wrangler dev`. Independent concurrent requests are fine, and so is a runtime whose layers build synchronously. Rule: state shared across requests hands off through Promises (Promise reactions resume in the waiting request), as `effect/spaced-queue.ts` does, and runtime layers stay synchronous.
- **Agents write v3 Effect by default.** `@effect/tsgo` `outdatedApi` and `obsoleteSchemaImport` catch it in CI. The canonical reference is `node_modules/effect/ai-docs` plus the `.d.ts` files, never memory.
- **Lint rules to confirm in the foundation PR:**
  - `no-comments` applies to every file.
  - Confirm `anti-slop/no-object-parameters` and `sort-keys` don't fight `Effect.fn` and option bags.

## PR slices

Each slice is one PR. Branch names use the form `effect/<slice>`, in its own worktree.

Slices inside a wave share no files. Shared files (`package.json`, `bun.lock`, `lib/server/effect/**`, `api-error.ts`, `AGENTS.md`) belong to wave 0 only. A slice that needs a foundation change stops and asks the lead.

### Wave 0: foundation (serial, lead-owned)

| PR                                 | Content                                                                                                                                                                                                                                                                                                              | Depends on | Route                                                            |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ---------------------------------------------------------------- |
| 0 `effect/rfc`                     | This RFC                                                                                                                                                                                                                                                                                                             | none       | lead                                                             |
| 1a `effect/api-error`              | Move `ApiError` from `spotify.ts` to `lib/server/api-error.ts` and update its 50 importers. No Effect.                                                                                                                                                                                                               | none       | GPT-6 Luna `max` (codemod), Claude review                        |
| 1b `chore/vitest-5`                | Upgrade `apps/web` to vitest 5 and `@vitest/coverage-v8` 5, and fix any breakage across the 510 test files. No Effect.                                                                                                                                                                                               | none       | GPT-6.1 Sol `high`, Claude review                                |
| 1c `docs/maintenance-merge-mode`   | Drop `--admin` from the `fluncle-maintenance` skill's merge step, so it lands through the reviewer like every other PR. #1597 already removed the AGENTS.md rule.                                                                                                                                                    | none       | lead                                                             |
| 2 `effect/foundation`              | See the list below.                                                                                                                                                                                                                                                                                                  | 1a, 1b     | Opus 5.5 `high` lead; GPT-6.1 Sol `xhigh` review                 |
| 3 `effect/pilot-throttled-lookups` | `musicbrainz.ts` and `discogs.ts` on one shared throttled-client service: `Semaphore` or spaced `Schedule`, Retry-After-driven retry, `Effect.timeout`, and typed `RateLimited`, `HttpError` and `Timeout`. Keep the `{data, rateLimited}` adapter for `crawl.ts`. Replace real sleeps in tests with the test clock. | PR 2       | Opus 5.5 `high` (sets the reference pattern); Sol `xhigh` review |

PR 2 (`effect/foundation`) adds:

- `effect` (`~4.0.0`) and `@effect/tsgo` in the catalog, plus `minimumReleaseAgeExcludes` entries for them and the tsgo platform binaries. `@effect/vitest` joins once vitest 5 (1b) is on `main`.
- `effect-tsgo diagnostics --strict` chained into `apps/web`'s `typecheck`, so CI, `check` and `deploy:gate` all run it.
- `lib/server/effect/`: the lazy isolate runtime with `runServerEffect`, a logger that writes the `logEvent` JSON shape, and `keepAlive` for `waitUntil` background work.
- Client-chunk purity for `effect`, and the AGENTS.md "Effect" section.

Left out on purpose, since no slice needs them yet:

- A config layer: Effect's default `ConfigProvider` already reads `process.env`, and slices keep calling `readEnv`.
- A fetch service: `Effect.tryPromise` passes an abort signal that `Effect.timeout` triggers, and modules keep their `FetchImpl` parameter for tests.
- `runApi`: it belongs to the oRPC slice.

Startup CPU and the Sentry span parent are measured in the pilot, the first PR whose Effect code the Worker actually loads.

PR 3 is the end-to-end validation required before fan-out. Wave 1 starts only after it merges and its pattern is reviewed.

### Wave 1: parallel leaf slices (sliding window, at most 4 open)

| Slice               | Files                                                                                                                                                                                                                                                  | Route                                  |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------- |
| A2 lookup clients   | `deezer.ts`, `lastfm.ts`, `listenbrainz.ts`                                                                                                                                                                                                            | MiMo-V2.6-Pro                          |
| F small timeouts    | `fx.ts`, `youtube-official.ts`, `search-llm.ts`, `beatport-resolve.ts`, `sonar.ts`, `demand.ts`                                                                                                                                                        | MiMo-V2.6-Pro                          |
| E edge side-effects | `entity-cache-purge.ts`, `indexnow.ts`, `video-cache.ts`, `r2-presign.ts`, `preview-archive.ts`, plus the `waitUntil` call sites in `edge-cache.ts` only. This replaces `try { waitUntil } catch {}` with the `WaitUntil` service and logged failures. | GPT-6.1 Sol `high`                     |
| G messaging         | `resend.ts`, `follow-digest.ts`, `telegram.ts`, `discord-alert.ts`, `postiz.ts`, `push.ts`                                                                                                                                                             | GPT-6.1 Sol `high`                     |
| C OAuth token store | One `TokenStore` refresh service for `youtube.ts`, `tiktok.ts`, `twitch.ts`, `instagram.ts`, `mixcloud.ts`, with `invalid_grant` race handling ported from Spotify. Spotify stays out.                                                                 | GPT-6.1 Sol `high`; Opus review (auth) |
| D Apple Music       | `apple-music.ts`, `apple-breaker.ts`, `preview-live.ts`. Defines a reusable settings-persisted `Breaker` service.                                                                                                                                      | GPT-6.1 Sol `high`                     |
| CLI                 | `apps/cli` `retry.ts`, `api.ts`, `evidence-http.ts`. Check the compiled binary size delta.                                                                                                                                                             | MiMo-V2.6-Pro                          |

### Wave 2: dependent slices

| Slice              | Content                                                                                                                                                                                                                                                 | Depends on                                       | Route                                     |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ----------------------------------------- |
| B Spotify          | `spotify.ts`, `spotify-budget.ts`, `spotify-anchor-breaker.ts`, `anchor-spotify-search.ts`, `retry.ts`, `publish.ts`. Reuse `Breaker` (D) and `TokenStore` (C). The quota hold becomes a typed `QuotaExceeded`, and `withRetries` becomes a `Schedule`. | C, D                                             | GPT-6.1 Sol `high`; Opus 5.5 review       |
| oRPC boundary      | Convert handler groups from `try { … } catch (e) { throw apiFault(e) }` to `runApi(effect)`, in batches of disjoint `orpc/*.ts` files. Prove one group end to end before the fan-out. `orpc-auth-coverage` must stay green.                             | PR 2; follows the leaf slices that own the logic | GPT-6 Luna `max` after the representative |
| DB edge (optional) | Replace the `WorkerDatabaseConcurrencyGate` 1 ms poll with a `Semaphore`, and `runWithRetry` with a `Schedule`, behind the unchanged `Client` surface. SQL-critical: independent review required.                                                       | wave 1 evidence                                  | Opus 5.5 `high`; Sol `xhigh` review       |

## Orchestration

- An Opus 5.5 lead owns wave 0, the pattern review, integration and the stop rule. Executors follow `mk-agent-orchestration`. Each worktree comes from `wt switch --create effect/<slice>`.
- Each child opens its PR as a draft, runs the gate locally, then shepherds the PR through deploy with `mk-pr-shepherd`. Review is cross-provider with fresh context, so Codex-built slices get a Claude reviewer and vice versa.
- PRs merge through review and auto-merge, one at a time, with no `--admin`. Every push to `main` deploys.
- Each executor brief names:
  - the slice's files
  - "don't edit shared files"
  - "read `node_modules/effect/ai-docs` and the pilot module, never v3 memory"
  - the acceptance checks: gate green, `@effect/tsgo diagnostics` clean, behaviour-preserving tests, and the deleted hand-rolled helpers listed in the PR body
- Alternatively, hand the whole plan to Hyperspeed as one goal with this RFC as the strategy.

## Stop rule

After the pilot (PR 3) and wave 1, the lead judges the result on:

- net lines changed, and the count of hand-rolled helpers deleted
- test wall time, now that tests use the test clock instead of real sleeps
- Worker startup CPU and bundle delta
- review findings on v3 idioms or Effect misuse per PR

Continue to wave 2 only if code shrank and reviews stayed clean. Otherwise keep Effect confined to the migrated leaves and delete this RFC.
