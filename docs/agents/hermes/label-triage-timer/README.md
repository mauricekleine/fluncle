# fluncle-label-triage-timer — the label-triage round on a host timer

The rave-02 host trigger for the **label-triage round**. Once a day it reads the undecided crawl-seed pile and decides whether enough NEVER-LOOKED labels have accumulated to be worth a round. When they have, it researches a bounded slice of the pile with `claude -p` and records each label's proposal for the operator to rule on at `/admin/labels`. A host systemd timer `docker exec`s the baked sweep inside the `hermes` container.

The work is BAKED at `/opt/hermes-scripts/` — [`../scripts/label-triage-sweep.sh`](../scripts/label-triage-sweep.sh) over [`../scripts/label-triage-sweep.ts`](../scripts/label-triage-sweep.ts) — riding the image and auto-updating from `main` via pin-watch (Unit A). The research method is the [fluncle-label-triage](../../../../packages/skills/fluncle-label-triage) skill, baked at `/opt/claude/skills/fluncle-label-triage/`.

The wrapper sets absolute `bun` and `fluncle` paths because a host timer can start with a minimal `PATH`, and sources the shared sweep secrets file for `CLAUDE_CODE_OAUTH_TOKEN`, `DISCOGS_USER_TOKEN` and `FIRECRAWL_API_KEY` (all op-injected by `fluncle-secrets-sync`; nothing is placed on the box by hand). Because a round writes proposals, the unit runs the payload under `database-admission-runner.sh` as one whole-lifetime lease, the same shape as the newsletter draft. It sources `cron-output.sh` and wraps the payload instead of replacing the shell process, so the `/status` freshness marker is written even when the payload fails.

## The two halves

**The gate** is one countless admin read and a sort. It counts only labels a round can research: a label with no `mb_label_id` (nothing says which same-named entity it is) and a label already carrying per-label artist rules (a settled `dnb_partial`) are excluded, exactly as the skill's pull excludes them, so neither can hold the threshold up forever.

**The round** runs only when the gate fires. It reads the operator's live boundary (enabled and disabled label names, the global artist rules), slices the worklist into batches, and runs one `claude -p` per batch under bounded concurrency. Each batch reads the skill, applies its DSP oracle ladder, calibration lists, 15 % census rule and four standing rulings, and returns one structured verdict per label. The script — never the model — records each verdict with `fluncle admin labels triage` under one round id.

The split is the whole design. **Every agent-bearing cron in this repo has had a silent outage** — a Claude token six days dead while the sweep reported green, a pinned binary rotting for thirteen days the same way. So the gate that runs every day spends nothing, the model runs only when there is work, and a round that produced nothing is loud.

## What it cannot do

- **The model holds no Fluncle credential and cannot reach the sweep secrets file.** Its process gets an allowlisted environment (the Claude token, the Discogs token, the Firecrawl key, `PATH`, locale) and its own `HOME`, the batch's temporary directory. It runs `--restricted --strict-mcp-config --permission-mode dontAsk`: user, project and local Claude settings are ignored, bypass mode is refused, the file tools (`Read`, `Glob`, `Grep`) are confined to the batch directory and the skill, and Bash is denied except `fluncle admin labels evidence …`, the one fetcher. Chained commands and command substitution around it are denied too. With an MBID argument that command reads MusicBrainz, Discogs, Beatport and Apple and never calls the Fluncle API. A live probe against a planted secrets file confirmed all of this; without `--restricted`, a bypass-mode user setting overrode `--allowedTools` and the file was read.
- **The script can only record.** Recording is `record_label_triage` → `fluncle admin labels triage` — **agent tier**. It stamps the cursor and stores a proposal. RULING on a label (`update_label`) and writing artist rules (`replace_label_artist_rules`, `rule_artist`) are **operator tier** and 403 the box's agent token at `operatorGuard`, pinned by `orpc-auth-coverage`.

So nothing this sweep does can enable a label, disable one, or write an artist rule, however wrong a batch goes.

## No silent failure

A fired round is healthy only when every batch returned a verdict for every label it was given and every verdict was recorded. Otherwise the sweep:

1. prints an `ok:false` JSON summary as its last line, so `/status` reads the run as failed (`cron.label-triage` goes degraded, then down on a second failure) and the run ledger records a non-zero exit;
2. posts one line to the ops-alert Discord webhook (`DISCORD_ALERT_WEBHOOK`) naming the round, the recorded count and the first failures;
3. exits non-zero.

The failure reasons are `zero_proposals` (the gate fired and nothing was recorded), `batch_failed` (a batch errored, timed out, left a label without a verdict, or a record call failed), `claude_auth` (the Claude token is dead; the round stops before spending another batch) and `calibration_unreadable` (the boundary read failed, so no model ran). An unreadable pile alerts the same way. `label-triage-sweep.test.ts` proves the zero-output round alerts through the webhook.

Unfinished work never waits for the threshold. After every fired round the sweep saves the labels it did not record — a failed batch's labels, and never-looked labels past the round's cap — to `carry.json` in its state dir (`~/.label-triage/`, or `LABEL_TRIAGE_STATE_DIR`). The next day's gate fires whenever any of them are still waiting, researching them first, so a partial round cannot turn into a healthy `HOLD`. A carried label that has since been triaged or ruled drops out, and a `HOLD` prunes the file so an old entry cannot fire a round once that label turns stale. The file is written atomically; a missing file means nothing is carried, and any other read or parse failure, or a failed write, fails the run and alerts. A failed round is not retried at the same day's second slot.

## The knobs

Every knob is an `Environment=` line on the unit, passed into the container by the `docker exec -e` list.

| var                               | default | what it means                                                                   |
| --------------------------------- | ------- | ------------------------------------------------------------------------------- |
| `LABEL_TRIAGE_THRESHOLD`          | 40      | how many NEVER-LOOKED labels must accumulate before a round is worth its tokens |
| `LABEL_TRIAGE_STALE_DAYS`         | 30      | how long before a label a round could not rule is looked at again               |
| `LABEL_TRIAGE_MAX_LABELS`         | 30      | the most labels one round researches                                            |
| `LABEL_TRIAGE_BATCH_SIZE`         | 10      | labels per `claude -p` call                                                     |
| `LABEL_TRIAGE_MAX_BATCHES`        | 3       | the most `claude -p` calls one round makes                                      |
| `LABEL_TRIAGE_CONCURRENCY`        | 2       | batches in flight at once                                                       |
| `LABEL_TRIAGE_BATCH_TIMEOUT_SECS` | 1800    | wall clock per batch before it is killed and counted failed                     |
| `LABEL_TRIAGE_MAX_TURNS`          | 120     | `--max-turns` per batch, the runaway cap                                        |

`LABEL_TRIAGE_CLAUDE_MODEL` (default `opus`) and `LABEL_TRIAGE_CLAUDE_EFFORT` (default `medium`) are read too, but not set on the unit. The unit's `TimeoutStartSec` covers two waves of batch timeouts plus the reads and the recording; the sweep's test fails if a knob change outgrows it.

**The threshold counts only never-looked labels, deliberately.** Counting the whole undecided pile would fire every day forever, because the stuck core never shrinks. Stale labels ride ALONG once a round fires (a conflation fixed upstream in MusicBrainz resolves only if something looks again); they never trigger a round by themselves. The worklist is never-looked first, then stalest, and a round takes at most `MAX_LABELS` of it; the rest are carried and fire the next day's round.

## What a round costs

The first three scheduled rounds of 30 labels each cost **985k tokens and $1.67**, **996k and $2.15**, and **1.1M and $2.01** list-price equivalent: about 33–37k tokens and $0.06–0.07 per label. A large DnB catalogue that needs a full census costs more (an attended batch of three such labels measured about 200k tokens and $0.30 per label), so a heavy round can reach about 6M tokens and $9. Tokens are input + output + cache, almost all cache reads. The shared Claude Max subscription pays for it; the dollar figure is a list-price equivalent, not a bill.

Beatport costs one Firecrawl scrape per label whose MusicBrainz entity links a Beatport page, cached a week; in the first round with the key, 4 of 30 labels had one.

**The pile drains faster than the cap alone suggests**, because the operator rules labels outside the box too, but it also refills: the crawler minted 200–385 never-looked labels a day in the first week of rounds. The carry-over keeps the round firing daily at `MAX_LABELS` while any are waiting. Raise `LABEL_TRIAGE_MAX_LABELS` and `LABEL_TRIAGE_MAX_BATCHES` when the carry stops shrinking.

Every run's summary carries the measured `tokens` and `usd`, so the run ledger holds the real figure for each round.

## Reading a run

The gate line, then a JSON summary:

```
LABEL TRIAGE GATE: HOLD undecided=247 excluded=31 never-looked=9 stale=0 candidates=0 — 9 never-looked labels, below the threshold of 40
{"checked":0,"gate":"hold","ok":true,"produced":0,…}
```

`HOLD` is a healthy answer. When it fires, a `LABEL TRIAGE WORKLIST:` line names the slugs this round researches, and the summary carries `roundId`, `batches`, `batchesFailed`, `produced` (proposals recorded), `missed`, `verdicts` per bucket, `tokens` and `usd`. The proposals show on `/admin/labels` under each waiting label; the ruling stays the operator's.

## Box activation is OPERATOR-GATED

Nothing auto-enables. Enable it only after the pre-flight below.

## Deploy (on rave-02, one time — operator-gated)

The image must carry `fluncle` ≥ 0.265.0 (the evidence and triage commands); pin-watch rebakes it from `main`. A full [`../install-host-timers.sh`](../install-host-timers.sh) run enables every timer it discovers, this one included, so install just this pair with `--refresh-unit` (it installs and reloads, and activates nothing):

```bash
sudo bash docs/agents/hermes/install-host-timers.sh \
  --refresh-unit fluncle-label-triage.service --refresh-unit fluncle-label-triage.timer

# Pre-flight: the gate alone, printing the verdict and changing nothing (a threshold no pile reaches).
docker exec -u hermes -e HOME=/opt/data/home -e LABEL_TRIAGE_THRESHOLD=100000 hermes \
  bash /opt/hermes-scripts/label-triage-sweep.sh

# Attended round: a lowered threshold and one small batch.
docker exec -u hermes -e HOME=/opt/data/home -e LABEL_TRIAGE_THRESHOLD=1 \
  -e LABEL_TRIAGE_MAX_LABELS=4 -e LABEL_TRIAGE_BATCH_SIZE=4 -e LABEL_TRIAGE_MAX_BATCHES=1 hermes \
  bash /opt/hermes-scripts/label-triage-sweep.sh

sudo systemctl enable --now fluncle-label-triage.timer
```

The pre-flight and attended runs write real `/status` markers and ledger rows; the attended round records real proposals.
