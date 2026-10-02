# fluncle-anchor-timer — the catalogue Spotify-anchor sweep on a host timer

The rave-02 host trigger for the `--no-agent` **catalogue Spotify-anchor** sweep. `fluncle-anchor` fills the `spotify_uri`/`spotify_url` anchor on uncertified catalogue rows — a `tracks` row with no `findings` row, resolved from MusicBrainz, that may have landed with no Spotify presence. An anchored row can be recommended, minted into a playlist, and (once the operator certifies it) published.

The full design is [docs/catalogue-crawler.md](../../../catalogue-crawler.md) § the anchor. The sweep WORK is BAKED at `/opt/hermes-scripts/` — the `.sh`/`.ts` pair (source: [`../scripts/anchor-sweep.sh`](../scripts/anchor-sweep.sh) → [`../scripts/anchor-sweep.ts`](../scripts/anchor-sweep.ts)) — riding the image and auto-updating from `main` via pin-watch.

The host service now executes `anchor-sweep.sh` directly. The baked script acquires short database admission phases for the worklist and batches of up to 15 prepare or commit calls; it holds no lease while ListenBrainz, Spotify, Deezer, or Apify waits run. Each phase retries one admission yield before the tick records a paused `database_admission` marker. The unleased provider probe still makes immediate Spotify OAuth, breaker, and shared-meter control writes inside the Worker to keep the global rate rails current; these short calls do not extend a box lease across vendor latency. The next hourly firing drains any paid checkpoint before reading the derived worklist. Deploy the Worker batch contract first, let pin-watch bake the new script, then run `sudo bash docs/agents/hermes/install-host-timers.sh --refresh-unit fluncle-anchor.service` on the host to install the new `ExecStart`. The installer reloads systemd but does not start the service; inspect the next firing's admission journal for phase-scoped grants and its cron marker for a result or an explicit pause.

During an image-first rollout, the previous host unit still starts the whole-payload admission runner. Its `FLUNCLE_ADMISSION_RUNNER_PID` context makes the new sweep send its database HTTP calls directly under that inherited lease, with no nested acquisition; the vendor waits retain the old whole-sweep hold only until the refreshed host unit is installed. Once `ExecStart` points at `anchor-sweep.sh`, the context is absent and the phased path takes over. Refresh the host unit after the image bake, then check the runner journal for `phase_scoped:true` on the next firing.

## Why the sweep exists: Spotify's official app can't carry this

Filling the anchor used to run **in the Worker** against the official (dev-mode) Spotify app. That app has a tiny permanent budget, and at catalogue scale it **starved under sustained 429s** — while it is also the app the user-facing paths need (adds, publish, the Frontier playlist mints). So all catalogue anchor-filling moved **off** the official app onto **this box sweep**, driven by an **Apify** Spotify-scraper actor that has its own Spotify budget. The official app now serves only user-facing paths.

## The model: box fetches candidates, the Worker rules

The box holds no verification authority — it only fetches candidates, and even that only for the paid last resort. Per tick it runs the resolver waterfall (docs/catalogue-crawler.md § the anchor):

1. **Fetch** the anchor worklist from the Worker with the box's AGENT token (`GET /api/v1/admin/tracks/work?kind=anchor`). Each row carries a ready-made `anchorQuery` (its artists + title), so the driver never builds the query.
2. **Resolve the free rungs first, per row.** One admitted `prepares` call freezes up to 15 row inputs and returns each opaque envelope. The box asks the Worker's `candidate` operation to make the ListenBrainz and Spotify vendor calls without an admission lease, then durably checkpoints each probed row. One admitted `commits` call verifies those rows, writes any anchor or ISRC recovery, and decides paid-rung admission per row. The final verdict keeps `source` (which rung anchored) and `spotifySearchDone` (the sweep's pacer signal). The dark `anchor_spotify_search_enabled` flag remains default OFF, and the Friday-refresh window still skips the shared Spotify search rung.
3. **Apify only after a committed free-rung miss and paid admission.** For those rows, start the Apify actor asynchronously (`runs`, `searchKeywordLimit: 3`), save its run ID before waiting, poll that ID, fetch its dataset after success, **group** its flat results by `target` (the query), and **POST** each row's candidates to `anchor_track` (agent tier).

**The Worker re-runs the full verification on every rung** — exact ISRC first (case-insensitive), else the folded artist + title + ±3s-duration search triple — and writes the anchor on a hit. **No source's match is ever trusted** (ListenBrainz, the Spotify search, or Apify).

**The 60/min Spotify-search ceiling.** The dark Spotify search rungs share the ONE official app that also serves user-facing mints/publish, so the sweep paces them: `resolve_anchor` does ≤2 searches per row, and the box holds consecutive search-bearing calls ≥2s apart (`SPOTIFY_SEARCH_MIN_INTERVAL_MS`) → ≤60 searches/min. The Worker's Friday-window skip + the existing 429/Retry-After backoff are the other two guards, so a Friday mint always has headroom. A flag-OFF sweep never searches and never paces (it runs at slice-1 speed).

A handled row stamps `spotify_anchor_attempted_at`, a **14-day re-ask backoff** (`ANCHOR_REASK_AFTER_DAYS`): "not on Spotify today" is not "never on Spotify", so a parked row is re-asked — but not re-billed for two weeks. Separately it is **capped**: `spotify_anchor_attempts` bumps only when a rung capable of CONCLUDING (the Spotify search pair, or Apify) was actually asked and missed, and the worklist retires a row after `ANCHOR_MAX_ATTEMPTS` (6) such attempts, so the lifetime spend on a row that is simply not on Spotify is bounded at ~3 months of looking rather than a fortnightly re-ask forever. A ListenBrainz-only miss parks the row without spending one of those tries — ListenBrainz can win but cannot conclude, so charging it would retire a row nobody ever asked the question of. Rows whose whole artist credit is a placeholder (`Unknown Artist`, `Various Artists`, …) never enter the queue at all — no search can anchor them. The worklist is DERIVED (`spotify_uri is null`), so a stopped tick loses nothing and "run again" is "resume".

**Reading a quiet tick.** `missed` counts rows the server actually retired; `deferred` counts rows that kept their turn (the next tick reads them again); `reason: "no_capable_rung"` says the tick pulled rows while neither capable rung was armed, so nothing it did could settle a question. `fluncle admin catalogue anchor-breaker` reads the other half — the throttle breaker's pause, and whether the Spotify-search and Apify rungs are armed at all.

**It calls the oRPC HTTP endpoints directly** (the `verify-captures.ts` precedent), never a `fluncle admin …` subcommand — the box's baked CLI is a PINNED release and must not gain a new dependency.

- `FLUNCLE_ANCHOR_BATCH` (code default `15`; this unit ships **`250`** via `ExecStart`) — rows per tick, and `250` is also the hard ceiling: the contract validates `limit` at `.max(250)`, so a larger value returns `400 invalid_request`. Safe to run at the ceiling because the free rungs resolve most rows at no Apify cost. This number decides how many rows a HEALTHY tick drains and nothing else — it is NOT the lever for breaker yields (see below).
- `--limit N` — an attended backlog burn (overrides the batch for one run, still ≤250); rows are still chunked into Apify runs of `FLUNCLE_ANCHOR_APIFY_CHUNK` (default 15).

## The cost, and how to control it

Each result item is ~**$0.005**, and at `searchKeywordLimit: 3` a row is ~3 items → ~**$0.015/row**.

**The hard brake is the daily row cap, not the batch.** `anchor_apify_daily_rows` (default **300** ≈ $4.50/day) caps the rows the server will authorise for the actor per UTC day, and the server charges at the moment it authorises one — in ONE atomic statement that both increments and enforces (the `rate_limit_counters` conditional upsert), so an attended `--limit` burn overlapping the hourly timer cannot breach it. It bounds the spend whatever the batch, the backlog or the box's build. Read it with `fluncle admin catalogue anchor-apify-budget`, set it with `fluncle admin catalogue anchor-apify-budget set --rows N` (operator). It also rides `fluncle admin catalogue anchor-breaker`, because a spent day and a disarmed rung both stop paid asks. Once the cap is spent, an open gate or disabled Spotify-search flag still pulls the normal queue for free rungs, including exact-ISRC asks when enabled; the actor stays off even with `FLUNCLE_ANCHOR_DAY_FREE_RUNGS` unset. A closed quota gate or throttle with more than 15 minutes left can still report `reason: "apify_budget_spent"` and pull nothing; the rows keep their turn.

An unresolved new paid admission has a `pending` receipt and blocks a fresh prepared attempt on that row without silently expiring; a result report atomically makes it `settled`. Legacy receipts without a state retain their original two-hour expiry. The Worker returns `awaiting_paid_result` for a competing attempt, and the box defers the row without another Apify actor request or a second daily-cap charge. `apifySkippedAwaitingPaidResult` counts these rows separately from `apifySkippedAwaitingSpotify` and `apifyBudgetSkipped`; when they dominate a no-output tick, `blockedReason` names `awaiting_paid_result` for the pipeline watchdog. A replay using the same prepared envelope can still complete the original paid attempt within its two-hour window.

The box keeps each paid row's signed prepare/probe evidence, receipt coordinates, spend permission, and query in a mode-0600 checkpoint under its persistent home before commit. Initial creation refuses to replace any existing checkpoint. It records `actor_started` before the external Apify POST, then saves the returned run ID before polling and saves exact candidates before reporting. Every scheduled tick drains these checkpoints before reading a fresh worklist: an ambiguous commit replays its original signed envelope and retains its spend permission for audit, an admitted row starts the actor under its existing receipt, and a saved result is reported with the original signed paid-result token. A phase yield leaves the checkpoint for the next hourly tick. A known run ID can be polled and its dataset recovered without a second actor POST, even if Apify is now disabled; the flag stops only a new actor start. A definitive start rejection or an explicit `FAILED`, `ABORTED`, or `TIMED-OUT` run settles the pending paid receipt through `paid-result/cancel` and stamps the normal attempt backoff; only a proven unstarted actor refunds the daily row cap. A transport failure before a run ID is known or a run lookup that returns 404 after Apify retention remains blocked for investigation. The Worker can issue a fresh result token for the exact pending receipt after the original token's 24-hour lifetime, and the box uses the same operation to recover a charged commit whose signed evidence has expired. A report 404 or 409 asks the Worker to resolve the exact receipt; an active unanchored receipt remains blocked. While a paid checkpoint remains blocked, the sweep skips its row and continues free rungs on other rows with `allowPaid: false`, so no new receipt, cap charge, or actor call can start; `blockedReason` exposes the recovery fault without turning the whole tick into `ok:false`.

The direct script and timer wrapper share one nonblocking `flock` on the persistent progress directory for the entire tick, including recovery and vendor waits. A second invocation emits `blockedReason: "anchor_tick_busy"` and exits without reading or changing paid work. An unreadable checkpoint stays on disk and disables new paid admission, while other valid checkpoints still replay. The same systemic invalid-report gate covers live and recovered 400/422 results before any failure strike is recorded. A terminal invalid strike settles its exact paid receipt through `paid-result/cancel` before removing its checkpoint; cancellation refusal keeps the checkpoint for recovery.

Successful commit verdicts include `paidReceiptPending` for the exact prepared receipt. A false value lets the box remove an unpaid or settled checkpoint without another database read; a true value requires exact receipt resolution or paid token recovery. When the field is absent during a rolling Worker upgrade, the box reads `/anchor/receipt` before clearing anything.

The worklist contract has a 250-row limit and no cursor. The box overreads by its blocked checkpoint count up to that limit, so a small number of blocked rows does not hide the next free row. If 250 blocked rows occupy the entire first page, later free work remains hidden until those checkpoints are resolved.

A definitive first commit rejection such as a 409 row change happens before paid admission, so the box removes that unpaid checkpoint and lets the next tick prepare the row again. A timeout, phase yield, or server error keeps the checkpoint because the commit may have reached the paid receipt. During recovery the box attempts every saved checkpoint even when an earlier one needs operator action, so later paid results can settle before their signed token expires; new paid admission remains closed until the blocked checkpoint is reconciled.

An `actor_started` checkpoint without a run ID pages the actor's runs from newest to oldest until it crosses a 20-minute clock-skew margin, then compares each run's `INPUT.tracks` with the complete saved batch. The earliest matching run is adopted without another POST, even if an unrelated run's input cannot be read. If no run matches, the checkpoint stays blocked for a two-minute grace window, then the sweep settles the exact receipt as an unstarted attempt and requests a refund of its authorization-day cap slot. A legacy checkpoint without complete actor input, an incomplete or oversized run list, or unreadable input with no match stays blocked for investigation; it cannot prove no run. Recovery polls each saved run ID once per pass with one bounded `waitForFinish`; a still-running run stays checkpointed for the next tick. A server batch that defers a tail row keeps that row's checkpoint for the next tick while already admitted rows finish their actor work in the current tick.

Cancellation of a proven unstarted actor or a terminal failed actor stamps `spotify_anchor_attempted_at` and increments `spotify_anchor_attempts`, so the normal 14-day backoff prevents an hourly rebill. A terminal run retains its cap charge; a proven unstarted run can refund it once, subject to a server-side ceiling of ten refunded cap slots per UTC authorization day. Cancellations over that ceiling still settle and back off, while the cap charge remains. A definite actor-start rejection, including 429, cancels the affected receipts and stops new paid work for that tick. The refund uses the saved authorization timestamp, so a prepare crossing midnight cannot refund the wrong UTC day's counter.

**The window is what decides whether a day tick can conclude anything.** `FLUNCLE_ANCHOR_ISRC_WINDOW_UTC` bounds the free exact-ISRC rung, and outside it no row can get the free ask the paid rung now requires — so a windowed sweep pulls nothing outside its hours rather than re-reading the same queue head it cannot settle. The committed unit leaves the window EMPTY, which means always: the breaker already enforces the thing the window was protecting (a 429 anywhere ends the tick's asks and trips a cooldown), and an eight-hour window drained far less of the ISRC shelf than the free Deezer pre-filter refills. Set a window here if user-facing Spotify traffic ever competes with the sweep; widening the breaker is the wrong lever for that.

**And the rows that reach the actor at all are the ones the free rung could not answer.** An ISRC-bearing row is admitted to the paid rung once the FREE exact-ISRC Spotify rung actually asked about it and missed, or from 09:00 UTC onward while recent `QUOTA_EXCEEDED` evidence or a spent anchor daily call budget makes that ask unavailable (docs/catalogue-crawler.md § the anchor). Before 09:00 UTC, the quota-closed or daily-budget-spent tick reads only prior-ask work and leaves never-asked rows for the measured free window. Each quota response holds all non-essential Spotify calls until Retry-After, with a 24-hour fallback and a 26-hour cap; the next firing probes only after the hold expires. The free rung answers ~78% of the asks it is given. A short remaining throttle or a spent shared meter reads the normal queue for per-row admission; a longer throttle reads only prior asks. During throttle trips, rows that already had a free ask may reach Apify more often, always within the unchanged 300-row daily cap. The tick reports `apifyRowsSent` (rows POSTed), `apifyResults` (the unit Apify bills — divide to get the realised results-per-row), `apifySkippedAwaitingSpotify` (rows held back for the free ask) and `apifyBudgetSkipped`.

**There is no ISRC query to make cheaper.** Every query the sweep sends the actor is the free-text `anchorQuery`; `anchoredByIsrc` names the GATE rung that matched among those results, not a query shape. Asking for one result per query (`FLUNCLE_ANCHOR_KEYWORD_LIMIT=1`) would halve the gate's chances on the only queries that exist, so the count stays at 3 and the env var is the lever if that judgement ever changes.

- **When a whole tick yields (`lbYieldedOnBreaker` across the batch, `produced: 0`), the batch is the wrong lever.** The LB by-id read draws on the SHARED official Spotify app and CONSULTS the throttle breaker (5 × 429 in a 10-minute window); its cooldown is one hour, exactly this timer's cadence, so a trip by any Spotify caller costs this sweep a full tick, and a tripped breaker gates both free rungs at once. `fluncle-isrc-recovery` drives the same `resolve_anchor` op and lands ~10 minutes ahead of this unit, reaching the shared budget first. Fix the other caller's pacing or the two units' relative schedule; shrinking this batch only throttles the sweep that was already yielding.
- **Shipped pace:** `250` rows/hour ≈ **6,000 rows/day** while the backlog drains — but the per-row Apify cost only applies to rows the FREE rungs miss, so with slice 2 ON the spend is a fraction of the code-default-15 math below. Once the backlog is anchored, most ticks are cheap no-ops (a drained worklist) plus the trickle of newly-crawled rows crossing the re-ask window; drop the batch back toward 15 for steady-state if you want. (Code-default reference: 15 rows/hour ≈ **360 rows/day** ≈ **$5-6/day** on the Apify-only path.)
- **The dark Spotify search rungs (slice 2) are the ~75-85% cost cut** — but only when flipped on. With the flag OFF (default) the free rung is ListenBrainz alone and Apify carries every LB miss (the numbers above). With it ON, most LB misses resolve on the free Spotify ISRC/fuzzy search instead, so Apify shrinks to the rows even Spotify search can't place. Read the split off the summary line's `anchoredByListenbrainz` / `anchoredBySpotifyIsrc` / `anchoredBySpotifySearch` / `anchoredByIsrc` / `anchoredBySearch` counters.
- **The ISRC-recovery rung is free, and it runs from THIS box's IP.** Deezer's public search takes no token, so its quota is purely per-IP — from Cloudflare's shared edge it recovered 0 ISRCs out of 5,133 ISRC-less rows over 3 days, against 25/25 clean from the box. So the sweep makes that one search itself, for the ISRC-less rows only (the worklist marks them with a `deezerQuery`), and hands the hits to `resolve_anchor`; the Worker still verifies and writes. Two counters read it: `isrcRecoveredByDeezer` (the recovery rate — a recovered ISRC moves that row onto the high-precision exact-ISRC rungs, which is where the Apify saving comes from) and **`deezerSearchFailed`** (searches that errored or stayed quota-blocked). `deezerSearchFailed` climbing toward the row count means this box's IP has gone quota-blind — a sustained one is the signal to look, not a per-row shrug. No proxy is in the path by design.
- **`freeRungErrors` is the free rung's own tripwire.** It counts `resolve_anchor` calls that threw, unconditionally. A thrown call is not an authorisation, so those rows are `skipped` and the next tick asks again rather than being bought on a guess — which means a broken free rung now shows as a drain that stops, not as a tick that reads healthy while spending. Anything but 0 is worth a look.
- **Burn the backlog faster (attended):** `--limit N` in one run.
- **Pause the spend entirely:** stop the timer (`sudo systemctl stop fluncle-anchor.timer`). No spend flows while it is stopped; the worklist is derived, so resuming picks up exactly where it left off.

### The dark flag: flip the Spotify search rungs on for the pilot (operator)

The Spotify search rungs ship **default OFF** — a starved Friday mint is user-facing breakage, so pointing the shared official app at the catalogue is a deliberate operator act, gated by the operator-tier `set_anchor_search` op (no deploy, effective next `resolve_anchor` tick). Flip it with the **operator** token (an agent token 403s):

```bash
# ON  (start the overnight pilot)
curl -fsS -X PUT https://www.fluncle.com/api/v1/admin/catalogue/anchor/search \
  -H "Authorization: Bearer $FLUNCLE_OPERATOR_TOKEN" -H "Content-Type: application/json" \
  -d '{"enabled":true}'
# → {"ok":true,"enabled":true}

# OFF (kill switch — one flip, no deploy)
curl -fsS -X PUT https://www.fluncle.com/api/v1/admin/catalogue/anchor/search \
  -H "Authorization: Bearer $FLUNCLE_OPERATOR_TOKEN" -H "Content-Type: application/json" \
  -d '{"enabled":false}'
```

Watch the Apify dashboard + the sweep's per-rung counters over the first night; if a mint ever looks starved, flip it OFF (or it self-protects: the Friday-morning window is skipped, the 60/min ceiling + 429 backoff keep it a trickle, and the throttle breaker below pauses the rungs outright).

### The throttle breaker: what pauses the rungs when Spotify pushes back

The flag above is the operator's switch; the breaker (`apps/web/src/lib/server/spotify-anchor-breaker.ts`) is the automatic one, and it is what makes the flag safe to leave ON unattended. **5 Spotify 429s inside a rolling 10 minutes** — counted at `spotifyFetch`, so from any path, not just this sweep — pause the Spotify search rungs for **1 hour** (one tick), then it re-arms itself. Nothing else is affected: a mint, publish, and the Frontier refresh never consult it, so the breaker can only ever cost the catalogue a tick.

Two operator handles, both on the shared `settings` KV and effective on the next `resolve_anchor` tick with no deploy. Reading is agent-allowed; clearing is operator-only.

```bash
# INSPECT — why did the free Spotify rungs go quiet?
curl -fsS https://www.fluncle.com/api/v1/admin/catalogue/anchor/breaker \
  -H "Authorization: Bearer $FLUNCLE_OPERATOR_TOKEN"
# → {"ok":true,"tripped":true,"reason":"throttled","trippedAt":"…","cooldownRemainingMs":…,"throttlesInWindow":0}

# CLEAR — lift the pause early, once Spotify is confirmed healthy (it self-heals on the cooldown anyway)
curl -fsS -X POST https://www.fluncle.com/api/v1/admin/catalogue/anchor/breaker/reset \
  -H "Authorization: Bearer $FLUNCLE_OPERATOR_TOKEN" -H "Content-Type: application/json" -d '{}'
# → {"ok":true,"tripped":false,"reason":null,"trippedAt":null,"cooldownRemainingMs":0,"throttlesInWindow":0}
```

`tripped: true` on the read is the answer to "the sweep says `spotifySearchDone: false` on every row and the flag is on". A read that ERRORS is itself meaningful: the breaker is default-deny, so a `settings` store it cannot read pauses the rungs — clear it with the reset once the store is back. The threshold, the failure window, and the cooldown are three named constants at the top of the breaker module; tune them there.

## Activation (OPERATOR-GATED — the repo half ships; the box enable does not)

The repo carries the scripts, the timer units, this doc, and the `/status` registration (`cron.anchor` in `@fluncle/registry` + the `fluncle-healthcheck` prober). Enabling it on the box is one manual pass, and it needs **one new secret** — the Apify token.

1. **Add the Apify token** to the shared op-injected secrets file as `APIFY_API_TOKEN` (placeholder `op://<vault>/APIFY_API_TOKEN/credential`; the concrete vault path lives in the private companion). It joins the same `${HOME}/.fluncle-secrets.env` every sweep sources. `FLUNCLE_API_TOKEN` (the box's agent token) is already present — `anchor_track` and the worklist read are agent tier, so **no operator token**.

2. **Install + enable the timer** on the rave-02 HOST, from a repo checkout, as root:

   ```bash
   sudo install -m 0644 docs/agents/hermes/anchor-timer/fluncle-anchor.service /etc/systemd/system/
   sudo install -m 0644 docs/agents/hermes/anchor-timer/fluncle-anchor.timer   /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now fluncle-anchor.timer

   # Verify one tick now.
   sudo systemctl start fluncle-anchor.service            # one tick
   journalctl -u fluncle-anchor.service -n 40 --no-pager  # expect a { "ok": true, "anchoredByIsrc": …, … } summary line
   systemctl list-timers fluncle-anchor.timer
   ```

   (A full re-provision restores it automatically — [`../install-host-timers.sh`](../install-host-timers.sh) globs every `*-timer/` dir; the manual pass above is only for the FIRST enable on an already-running box.)

3. **Watch the spend.** The first days drain the backlog at ~$5-6/day; confirm the pace against the Apify dashboard, and use `--limit` (or the timer's cadence) to widen/narrow it.

**It is already on /status.** `cron.anchor` is registered in `@fluncle/registry` and in the `fluncle-healthcheck` prober's `AUTOMATION_CRONS`, so the moment the timer runs its first tick the `/status` row goes live. Nothing further to wire.

The committed timer runs up to **100** exact-ISRC asks per tick at **all hours** (`FLUNCLE_ANCHOR_ISRC_ASK_LIMIT=100`, empty `FLUNCLE_ANCHOR_ISRC_WINDOW_UTC`). The script fallbacks of 25 and `0-8` apply only to direct invocations without the unit environment. The Worker enforces an atomic 700-call UTC-day anchor budget across searches, ListenBrainz by-id reads, and album pages; the shared 24-call/30-second meter also fails closed for this optional work. When the global quota hold or anchor daily budget is active, the preflight selects prior-ask or quota-paid work without Spotify probes; rows that need a new Spotify ask keep their turn.

## Local tests

Run `bun test docs/agents/hermes/scripts/anchor-admission-phase.test.ts` for the phase fixtures, then `bun run test:scripts:box` for the box-script suite. Run them serially. The fixture server publishes its bound port by writing a temporary file and renaming it into place; the ready filename therefore exposes only the complete port. The startup regression pauses the writer after file creation, checks that readiness is still absent, then releases the write and runs the sweep against the published endpoint. The PID-bearing readiness files in `database-admission-runner.test.ts` use the same write-then-rename publication so readers see complete process identities.
