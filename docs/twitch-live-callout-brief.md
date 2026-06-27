# Live on Twitch — the on-the-decks callout (build brief)

A planning brief, not canon. Per `AGENTS.md`, `docs/*-brief.md` is brainstorm/planning — the codebase and canon (`DESIGN.md` / `PRODUCT.md` / `VOICE.md`) win on any conflict; translate the idea into Fluncle's terms when picking it up. Written 2026-06-27 to scope a ~2-day build ahead of an imminent live set. Line numbers below are hints, not contracts — grep the named symbol if one has drifted.

Source arc: `docs/ROADMAP.md` § Later → "Live on Twitch — the on-the-decks callout across surfaces".

## The feature

When Maurice goes live on Twitch to DJ, a callout fans out across Fluncle's surfaces while the stream is on, and clears itself the moment it ends — the one loud, ephemeral beat in an otherwise quiet, cover-led product (Fluncle's in the booth, the crew gathers, then it's gone). This is the **live-set callout**, distinct from the always-on `radio.fluncle.com → Twitch 24/7` arc (that's the quiet, always-there hum; this is the loud moment).

## The unlock — reuse the healthcheck pattern, skip the scary infra

The intimidating pieces (a Cloudflare cron, a KV namespace, an EventSub webhook with verified callbacks) are all **avoidable**. Fluncle already has the exact shape this needs: the rave-02 healthcheck cron → `record_health` → `service_status` row → `/api/status`, which every surface already reads. Mirror it:

- A new on-box `--no-agent` Hermes cron (`fluncle-live`, every ~1 min) polls Twitch and POSTs live-state to a new agent-tier admin op (a clone of `record_health`).
- The flag is a **Turso row** (migrations auto-apply on deploy), not KV.
- Surfaces read it: web via the home loader; SSH almost free (it already pulls `/api/v1/status` into a typed struct); CLI via a small fetch (fast-follow).
- Twitch `Get Streams` (Helix) needs only an **app access token** (client-credentials grant) — public data, **no app review** — so credential lead time is ~5 minutes, and the token lives **on the box**, not the Worker.

No new Worker infra, no public webhook, no EventSub for v1.

## Auto-clear — the staleness guard (self-healing)

The one real failure mode is a dead cron mid-stream stranding a permanent "LIVE" banner. Fix it on the **read side**: every surface treats the flag as offline if `live_state.updatedAt` is older than ~5 min. Auto-clear is then self-healing regardless of cron health — simpler and more robust than an EventSub `stream.offline`. The cron flips on (off→on) and off (on→off) on transitions; the staleness guard is the backstop.

## What exists vs what's missing

**Exists (the presence layer is real):**

- `twitchUrl = "https://www.twitch.tv/flunclelive"` — `apps/web/src/lib/fluncle-links.ts:30`, already in the home social row (`apps/web/src/components/home/link-hub.tsx`) and the entity `sameAs` (`apps/web/src/routes/index.tsx:128`).
- The admin-write → store → public-read pattern to clone: `record_health` (`apps/web/src/lib/server/orpc/admin-health.ts:57`) writes the `service_status` row (`apps/web/src/db/schema.ts:204`); public read at `apps/web/src/routes/api/status.ts:30-85`.
- SSH already reads `/api/v1/status` into a typed `statusReport` struct (`apps/ssh/main.go:532-547`) — any field added to that payload fans out to SSH almost free.
- Telegram send is wired: `postToTelegram` + `sendMessage` (`apps/web/src/lib/server/telegram.ts:26,33`), using `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHANNEL_ID`.
- On-box Hermes cron infra (`docs/agents/hermes/cron/jobs.json` + `docs/agents/hermes/scripts/`); the healthcheck cron → `/admin/health` is the exact analog. The box holds `FLUNCLE_AGENT_TOKEN`.

**Missing (and all avoided by the box-poll + Turso design):**

- No Twitch API integration or credentials (no `TWITCH_*` in the `envKeys` allow-list, `apps/web/src/lib/server/env.ts`).
- No KV namespace (`wrangler.jsonc` binds only `r2_buckets`; `Env` is `{ VIDEOS: R2Bucket }`).
- No Cloudflare cron / `scheduled` handler (no `triggers`/`crons` in `wrangler.jsonc`; `server.ts` exports `fetch` only).

## Per-surface effort

| Surface                              | What's needed                                                                                                                                                                                        | Size               | Injection point (hint)                                                                                                                |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| Storage + admin write                | A `live_state` Turso row (`live`, `title`, `startedAt`, `tgMessageId`, `updatedAt`) + drizzle migration; an agent-tier oRPC `set_live` op cloned from `record_health`, with contract + coverage test | M                  | new table near `db/schema.ts:204`; op modeled on `lib/server/orpc/admin-health.ts:57`                                                 |
| Twitch client                        | `lib/server/twitch.ts`: client-credentials token + `GET /helix/streams?user_login=flunclelive`; empty `data[]` ⇒ offline                                                                             | S–M                | new file; creds held by the box poller                                                                                                |
| Box poll cron                        | `fluncle-live` script: poll, detect off→on / on→off transitions, POST `set_live`; operator wires via `hermes cron create`                                                                            | S (+~15m operator) | pattern: `docs/agents/hermes/cron/jobs.json` + `hermes/scripts/`                                                                      |
| Web home + feed (home _is_ the feed) | Read live in the home loader; render a quiet, dark, reduced-motion-safe `<LiveBanner>` above the masthead, linking `twitchUrl`                                                                       | M                  | loader `fetchHomeData` `routes/index.tsx:55-62,71`; render above masthead `:315`; new component beside `components/home/link-hub.tsx` |
| Telegram ping + pin                  | `postLiveToTelegram` → `sendMessage`, capture `message_id`, `pinChatMessage`; on clear `unpinChatMessage`; triggered by the cron on transitions                                                      | M                  | extend `lib/server/telegram.ts:26-49`                                                                                                 |
| SSH MOTD                             | Add a `live` object to the `/api/status` JSON, mirror in the Go `statusReport` struct, render one line                                                                                               | S                  | payload `routes/api/status.ts:64-78`; struct `apps/ssh/main.go:532`; render `renderMenu :1124` / `renderFooter :1165`                 |
| CLI `recent` header                  | The `recent` path reads `/api/tracks`, not `/api/status`, so it needs its own one-line live fetch before printing                                                                                    | S–M                | print seam in `apps/cli/src/cli.ts` (`runRecent`); read `/api/live` or `/api/status`                                                  |

## Operator lead-time items (do these first)

1. **Register a Twitch dev app** (dev.twitch.tv/console/apps) → `client_id` + `client_secret`. ~5–10 min, no review for Helix public reads. Stored where the poller runs = the box (via `op`); the Worker needs no new secret.
2. **Confirm the Telegram bot has pin rights** in the crew channel (it already posts, so likely admin; pin may need a toggle).
3. **Wire the box cron** — one `hermes cron create` for `fluncle-live` (see the `fluncle-hermes-operator` skill). Minutes, but a manual on-box step.

## The minimal 2-day cut

**Ship:** the `live_state` row + migration → `lib/server/twitch.ts` → the `set_live` op (+ contract/coverage) → the `fluncle-live` poll cron (transition-aware) → **web home banner** (the loud moment, highest reach) → **Telegram ping + pin/unpin** (the crew gather, the ROADMAP's named fan-out) → the **SSH line** (surface `live` on `/api/status` and SSH lights up almost free). Those three surfaces _are_ the feature.

**Defer (polish, fast-follow):**

- **EventSub entirely** — polling is sufficient and proven; EventSub adds a public callback route, signature verification, and a subscription handshake (real lead time for the "better," not the "needed").
- **CLI `recent` header** — lowest reach, and it needs its own fetch.
- **Pin-for-the-duration** can degrade to a plain ping if pin rights are fiddly — don't let it block the send.

Rough hours (one focused dev + AI): Twitch client ~1.5h · Turso row + `/api/status` + `set_live` op + contract/coverage ~3h · box cron + transitions + wiring doc ~2h · web home banner (component + loader + canon pass) ~3h · Telegram ping + pin/unpin + `message_id` storage ~3h · SSH line ~1h. **Core ≈ 13.5h ≈ two focused days** with testing/canon/verify buffer.

## De-risk first (30 min, before any code)

The riskiest unknown: that Helix `Get Streams` with a client-credentials app token reliably reports `flunclelive`'s live state at acceptable latency, and that registering the app needs no review. Prove the whole spine with three curls before writing code:

1. Register the Twitch app → `client_id` + `client_secret`.
2. `curl` a `client_credentials` token from `https://id.twitch.tv/oauth2/token`.
3. `curl "https://api.twitch.tv/helix/streams?user_login=flunclelive"` with the `Client-Id` + `Authorization: Bearer` headers — confirm a live channel returns a populated `data[]` and an offline one returns `data: []`.

If that one read works, the entire spine is green.

## Voice

In-fiction as "on the decks" / "live in the booth" / "rinsing a set live"; "live" as the literal Twitch state is fine, but never "transmission" / "signal" / "stream" as identity (the banned set in `VOICE.md`). Dry and warm, the crew addressed directly; the callout brags as little as the rest of the copy. Run the banner + Telegram + SSH strings through the `copywriting-fluncle` skill.
