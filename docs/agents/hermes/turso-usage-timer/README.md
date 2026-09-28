# fluncle-turso-usage-timer — Turso usage and overage, every 6 hours

The rave-02 host trigger for the `--no-agent` **Turso usage** sweep. Every 6 hours, `fluncle-turso-usage` reads the organisation's current-cycle usage from the Turso Platform API and posts one reading to the agent-tier `record_turso_usage` op. The Worker prices it against a versioned plan table, projects the cycle to its reset, stores it in the **telemetry database** (never the primary), and returns any overage alert that has not landed yet. The operator reads the result on the Turso panel of `/admin/costs`; reading it (`get_turso_usage`) is operator tier, so the box's agent token can only record and acknowledge. Zero LLM tokens.

Source: [`../scripts/turso-usage-sweep.sh`](../scripts/turso-usage-sweep.sh) → [`../scripts/turso-usage-sweep.ts`](../scripts/turso-usage-sweep.ts); pricing in [`apps/web/src/lib/turso-pricing.ts`](../../../../apps/web/src/lib/turso-pricing.ts); storage and alerts in [`apps/web/src/lib/server/turso-usage.ts`](../../../../apps/web/src/lib/server/turso-usage.ts).

## What it reads

All four are read-only `GET`s against `https://api.turso.tech`, authenticated with a Turso Platform API token:

| Endpoint                                         | Docs                                                                                           | Used for                                                                                      |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `/v1/organizations/{org}/usage`                  | [organizations/usage](https://docs.turso.tech/api-reference/organizations/usage)               | the cycle's rows read, rows written, storage, and bytes synced, org-wide and per database     |
| `/v1/organizations/{org}/databases`              | [databases/list](https://docs.turso.tech/api-reference/databases/list)                         | database id → name, so per-database usage is attributable                                     |
| `/v1/organizations/{org}/subscription`           | [organizations/subscription](https://docs.turso.tech/api-reference/organizations/subscription) | the plan name, the billing timeline (yearly or monthly base price), and whether overages bill |
| `/v1/organizations/{org}/invoices?type=upcoming` | [organizations/invoices](https://docs.turso.tech/api-reference/organizations/invoices)         | Turso's own draft invoice, shown beside the estimate as a cross-check (optional)              |

The usage endpoint takes no date range: it always answers for the current billing cycle. A usage, database-list, or subscription failure fails the run before anything is recorded. An invoice failure is logged and the reading is recorded without it.

## The money

The price table is `TURSO_PRICE_TABLES` in `apps/web/src/lib/turso-pricing.ts`, one versioned entry per plan, citing [turso.tech/pricing](https://turso.tech/pricing). Scaler (`scaler-2026-09`): base $24.92/month billed yearly or $29/month billed monthly ([monthly pricing](https://turso.tech/pricing?frequency=monthly)), picked by the subscription's `timeline`; an unknown timeline leaves the base (and the projected bill) unpriced; rows read $0.80 per billion past 100 billion; rows written $0.80 per million past 100 million; storage $0.50 per GB past 24 GB; embedded syncs $0.25 per GB past 24 GB (GB = 10⁹ bytes, as `turso plan show` prints). Turso's per-unit rates drop at volume, so every dollar figure is an **upper bound** at list rates; the upcoming invoice is the number Turso itself is building. A plan with no table entry is stored **unpriced**, never guessed. With overages off, Turso blocks instead of billing, so the overage is $0.

The cycle is the UTC calendar month, the same reset `turso plan show` prints. The projection adds each cumulative resource's **daily run-rate** × the time left to the reset. The run-rate is measured from the oldest reading of this cycle that is between 12 hours and 7 days old (`recent`); a cycle too young for that falls back to the cycle-to-date average (`cycle-to-date`). Storage is a level, not a flow, so it projects flat. Per-database attribution splits each resource's overage by that database's share of the resource.

## Alerts

The threshold is the `turso_usage_alert_threshold_usd` setting (default $50), set from the panel (operator tier, `set_turso_usage_threshold`). When the **projected** overage reaches the threshold, and again at twice it, the Worker claims a `(cycle, level)` row in `turso_usage_alerts`. The claim is idempotent, so each level is raised at most once per cycle, however often the sweep re-records. The record response lists every level of this cycle not yet delivered. The sweep posts one Discord message through `DISCORD_ALERT_WEBHOOK` and acknowledges the levels (`acknowledge_turso_usage_alerts`) only after the post lands. A missing webhook, a failed post, or a lost acknowledgement leaves the level pending, so the next run re-sends it, and that run reports `ok: false` (`alert_undelivered` / `alert_unacknowledged`) and exits non-zero, so the healthcheck prober, the run ledger, and the sweep-failure notifier see a delivery problem that repeats: delivery is at least once and never silent. Raising the threshold mid-cycle does not re-announce a level already delivered, and a new level (say $200 after moving to $100) raises on its own.

## Activation (OPERATOR-GATED — the repo half ships; the box enable does not)

1. **Create the token, narrowest scope.** On an operator machine logged in to the Turso CLI, mint an org-restricted Platform API token: `turso auth api-tokens mint fluncle-usage-reader --org <org-slug>`. `--org` limits the token to the one organisation. A group-scoped `--read-only` token is narrower, but organisation usage, the subscription, and invoices are org-level reads that a group-scoped token is not documented to reach, so it is not the default. Revoke with `turso auth api-tokens revoke fluncle-usage-reader`.
2. **Store it and wire it.** Put the token and the organisation slug in 1Password, then add two lines to the box's sweep template (`fluncle-secrets.env.tpl`, the host template kept in the private companion, never in this repo) using placeholder references of the form:

   ```
   TURSO_PLATFORM_API_TOKEN={{ op://<vault>/<item>/<field> }}
   TURSO_PLATFORM_ORG={{ op://<vault>/<item>/<field> }}
   ```

   Then re-run `fluncle-secrets-sync` (or wait for its timer). Until both are present the sweep reports `ok: false` with `reason: "missing_credentials"` and names what is missing.

3. **Install the timer.** `sudo bash docs/agents/hermes/install-host-timers.sh` (it discovers every `*-timer/` dir), or alone:

   ```bash
   sudo install -m 0644 docs/agents/hermes/turso-usage-timer/fluncle-turso-usage.service /etc/systemd/system/
   sudo install -m 0644 docs/agents/hermes/turso-usage-timer/fluncle-turso-usage.timer   /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now fluncle-turso-usage.timer
   sudo systemctl start fluncle-turso-usage.service               # one reading now
   journalctl -u fluncle-turso-usage.service -n 40 --no-pager     # expect { "ok": true, "overageUsd": …, "projectedOverageUsd": … }
   ```

The registry surface (`cron.turso-usage`) and the healthcheck prober's row are already registered, so the first tick is watched. The surface is `operatorOnly`: the job never renders on the public `/status` board (nor `/api/v1/status` or the MCP `get_status`), because the database bill is an operator concern; the prober still probes it, the run ledger still expects it, and its health reaches the operator through the prober's Discord flips and the `/admin/costs` panel.
