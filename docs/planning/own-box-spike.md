# Own-box target + de-risking spike

Non-canonical planning doc (a brainstorm, not a spec — the codebase and canon win on any conflict). Companion to `docs/planning/turso-latency-research.md`. The research report's recommendation is "optimize in place first" (Phase 0 shipped; Placement Hints is Phase 1). This doc sketches the **endgame the report defers**: hosting the whole app on a box so the database is `localhost`, and the de-risking spike that decides whether to commit to it.

## Why a box at all

The maximal latency solve. Placement Hints co-locate compute and data in the same _region_ (still an intra-region hop); a box co-locates them in the same _process_ — the DB is `localhost`, reads are microseconds, the compounding of sequential SSR queries disappears entirely, and the exact `vector_distance_cos` scan runs on real RAM with the full corpus in-process (the whole "will it OOM the 128 MB Worker / hit the 10 MiB response cap" class of worry evaporates). For Fluncle's multi-query SSR pages, a distant cold render even _wins_ vs Workers: one reader↔box ocean crossing instead of N×Dublin.

The trade: the serverless zero-ops posture and the global per-PoP compute become a single origin we own. Cloudflare's cache in front is what buys back global reach — the **same Phase 0 cache**, now load-bearing rather than an optimization.

## Target architecture

```
reader ──▶ Cloudflare PoP (nearest)
             │
             ├─ cache HIT (public pages) ──▶ served at the PoP, box untouched   ← global reach engine
             │
             └─ cache MISS / dynamic / per-user
                      │  (Cloudflare Tunnel — no inbound port, origin IP hidden)
                      ▼
                 the box (VPS)
                   ├─ app: TanStack Start SSR + oRPC + MCP, under Bun, systemd-managed
                   ├─ DB: local libSQL file (reads = in-process, µs; exact vector scan local)
                   └─ media: R2 over its S3 endpoint (unchanged)
                      │
                      ▼  backup / DR
                 Litestream → R2 (continuous WAL, RPO ~seconds)  and/or  Turso (hot standby)
```

- **Fronting: a Cloudflare Tunnel** (`cloudflared` on the box). No public inbound port, no exposed origin IP, no origin-cert management — the box is invisible except through Cloudflare, which also collapses the "single origin is a fat security surface" worry. CDN cache + WAF + TLS + DDoS stay exactly as today. Media Transformations (`/cdn-cgi/image`, video variants) keep working — they're CDN-layer, and Cloudflare is still in front.
- **Compute under Bun** (already the repo runtime). Process = long-lived; `systemd` unit with auto-restart + `unattended-upgrades` (the rave-box operational pattern we already run). Deploy = git pull + build + restart, or a baked image with the render-box freshen pattern.
- **Data local, backed up offsite.** The DB is a libSQL file on the box. See the backup-topology fork below.

## The runtime port (the real work, and the spike's core unknown)

Every Workers binding needs a Node/Bun equivalent. Most are thin:

| Workers today                                               | On the box                                                                                                                                                                       |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@libsql/client/web` (HTTP to Dublin)                       | `@libsql/client` (embedded, file + optional sync URL) — same API surface                                                                                                         |
| `env` from `cloudflare:workers`                             | `process.env` behind the existing `env.ts` `readEnvs` seam (swap the source)                                                                                                     |
| `waitUntil` from `cloudflare:workers`                       | a shim: `(p) => { p.catch(logError) }` — a long-lived process needs no keep-alive                                                                                                |
| `caches.default` (the Phase 0 edge-cache engine)            | **deleted** — a true origin behind the CDN caches natively via `Cache-Control: s-maxage/stale-while-revalidate`. The purge (CF cache-purge API) is origin-agnostic and **stays** |
| R2 bindings (`env.VIDEOS`, `env.SOURCE_AUDIO`)              | R2 over its S3 endpoint (`aws-sigv4` already in the repo)                                                                                                                        |
| `handleOrpc` / `handleMcp` / TanStack router in `server.ts` | TanStack Start's Node/Bun server target — the app's server entry becomes a Node HTTP handler                                                                                     |

The single biggest unknown is not any one row — it's **whether the whole graph actually boots and serves under Bun with an embedded libSQL replica**. That's what the spike proves.

## Backup topology — the fork to decide

- **(A) Embedded replica, Turso stays write-primary** (Turso Sync). Box reads local, writes forward to Dublin, syncs back. Turso is always current and authoritative → the old Workers+Turso stack stays a **live, instant DNS-flip fallback**. Writes pay the Dublin hop (fine — cron-dominated, low rate).
- **(B) Box-primary, Litestream → R2** for DR. The box owns the data; continuous WAL shipping to R2 gives an explicit ~seconds RPO. The canonical SQLite-on-a-box pattern; Turso drops to optional mirror or goes away.

**Recommended path:** run **(A) during transition** — box as a read replica while Workers+Turso stays the primary and the always-available rollback — then cut over to **(B)** once confident (flip the box to primary, turn on Litestream). This keeps the whole migration reversible by DNS.

## The spike (throwaway, prod untouched)

Prod stays on Workers throughout. Spin up `box.fluncle.com` on a cheap VPS (Hetzner, single-digit €/mo) **proxied through Cloudflare** — a subdomain, not an alt-domain, so it tests the real CDN-in-front topology and shares cookie/cert domain; trivial to tear down.

**Phase A — viability (~½ day). The one real unknown: does the stack run on a box?**

1. VPS + `cloudflared` tunnel → `box.fluncle.com` (orange-clouded).
2. Build + run the app under Bun with `@libsql/client` embedded replica synced from a **scratch Turso seeded with a prod-data copy** (destroyed after).
3. Serve ONE real page end-to-end — an **artist page** (exercises the loader batch + the entity read) and a **`/log/<id>`** (exercises `getSimilarFindings`, the vector path).
4. Confirm: it renders, the DB read is local (µs, not 184 ms), R2 media loads, the CDN cache warms in front (`x-edge-cache`/`cf-cache-status`).
   → **Go/no-go on "the app runs on a box."** If the Bun/TanStack-Start port or embedded libSQL fights us, we learn it here for a day's cost, not mid-migration.

**Phase B — measurement (~½ day). The decider: is it actually faster where it matters?**
Measure from ≥3 geographies (cloud regions or a VPN):

- Cached public page TTFB — expect edge-fast everywhere (sanity: same as today).
- **Uncached cold render TTFB, near vs far** — the box's single-origin penalty for distant _uncacheable_ traffic (ChatDnB, search, per-user). This is the number that decides it.
- The `getSimilarFindings` / recommendations vector query, local-on-box vs the current ~184 ms-Dublin-bound figures.
- If Placement Hints (Phase 1) got measured, compare against it.

**Decision gate:** if the box wins the paths that matter and the distant-cold penalty is acceptable given audience geography + the cacheable/uncacheable split, greenlight the full port (transition via topology A → B). If not, stay on Workers + Placement Hints. Either way Phase 0 was the shared prerequisite and is not wasted.

## Open questions / risks to close in the spike

1. **Bun + TanStack Start Node/Bun server target** with the full server-module graph — the port's biggest unknown (Phase A).
2. **Embedded-replica cold-start / sync time** on the box under topology A — measure; it bounds restart/deploy latency.
3. **Single-origin availability** — a self-managed box's uptime vs Cloudflare's. Mitigated during transition by the Turso-fallback DNS flip; long-term it's an accepted trade (or a second box).
4. **Audience geography + cacheable share** — the real inputs to the Phase B decision; worth a quick look at current traffic before the spike so the measurement targets the right regions.
5. **Backup topology A vs B** — decide on "is Turso the rollback net": yes → keep A live, no → commit to B.
