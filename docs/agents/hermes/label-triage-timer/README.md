# fluncle-label-triage-timer — the label-triage gate on a host timer

The rave-02 host trigger for the `--no-agent` **label-triage gate**. It reads the undecided crawl-seed pile, sorts it by the triage cursor, and reports whether enough NEVER-LOOKED labels have accumulated to be worth a research round. A host systemd timer `docker exec`s the baked sweep inside the `hermes` container once a day.

The work is BAKED at `/opt/hermes-scripts/` — [`../scripts/label-triage-sweep.sh`](../scripts/label-triage-sweep.sh) over [`../scripts/label-triage-sweep.ts`](../scripts/label-triage-sweep.ts) — riding the image and auto-updating from `main` via pin-watch (Unit A). The round this gates is the [fluncle-label-triage](../../../../packages/skills/fluncle-label-triage) skill; the design is [docs/rfcs/label-triage-sweep-rfc.md](../../../rfcs/label-triage-sweep-rfc.md).

## Why the gate is a separate, deliberately cheap thing

A triage round costs roughly 14k subagent tokens per label and runs an LLM fan-out. The gate costs one countless admin read and a sort.

That split is the whole design. **Every agent-bearing cron in this repo has had a silent outage** — a Claude token six days dead while the sweep reported green, a pinned binary rotting for thirteen days the same way. A cheap deterministic gate that runs nightly and says "not yet" is something whose health can be trusted; an expensive one that runs a model fan-out is not. So the part that must be trustworthy spends nothing, and the part allowed to be fragile is fired by it.

## What it cannot do

The gate READS. It cannot rule on a label, and neither can the round it gates:

- Recording what a round found is `record_label_triage` → `fluncle admin labels triage` — **agent tier**. It stamps the cursor and stores a proposal.
- RULING on a label is `update_label` → `fluncle admin labels update` — **operator tier**, which 403s the box's agent token at `operatorGuard`.

So a sweep holding the box's token is structurally incapable of enabling a label, disabling one, or writing an artist rule, whatever it concludes and however wrong it goes. That is enforced by the auth tier and pinned by `orpc-auth-coverage`, not by the script's good behaviour.

## The two knobs

Both are env overrides on the unit, and both are first guesses against a refill rate that is still falling — revisit once the gate has a few weeks of depth readings.

| var                       | default | what it means                                                                   |
| ------------------------- | ------- | ------------------------------------------------------------------------------- |
| `LABEL_TRIAGE_THRESHOLD`  | 40      | how many NEVER-LOOKED labels must accumulate before a round is worth its tokens |
| `LABEL_TRIAGE_STALE_DAYS` | 30      | how long before a label a round could not rule is looked at again               |

**The threshold counts only never-looked labels, deliberately.** Counting the whole undecided pile would fire every firing forever, because the stuck core never shrinks — the labels a round cannot rule are exactly the ones that stay. Stale labels ride ALONG once a round fires (they are cheap to re-read, and self-healing depends on it: a conflation fixed upstream in MusicBrainz resolves on its own only if something looks again); they just never trigger a round by themselves.

## Reading a run

One line, whatever happened:

```
LABEL TRIAGE GATE: HOLD undecided=247 never-looked=9 stale=0 candidates=0 — 9 never-looked labels, below the threshold of 40
```

`HOLD` is a healthy answer, not a quiet failure — which is why the verdict is the first token rather than something inferred from an empty output. When it fires, a `LABEL TRIAGE WORKLIST:` line names the slugs a round should read, never-looked first then stalest.

## Box activation is OPERATOR-GATED

The repo half ships (this timer + the baked sweep + docs); nothing auto-enables. Enable it only after the pre-flight below.

## Deploy (on rave-02, one time — operator-gated)

Install all timers at once with [`../install-host-timers.sh`](../install-host-timers.sh) (it auto-discovers this `*-timer/` dir — no installer edit needed), or just this one:

```bash
sudo install -m 0644 docs/agents/hermes/label-triage-timer/fluncle-label-triage.service /etc/systemd/system/
sudo install -m 0644 docs/agents/hermes/label-triage-timer/fluncle-label-triage.timer   /etc/systemd/system/
sudo systemctl daemon-reload

# Pre-flight: one read, printing the verdict and changing nothing.
docker exec -u hermes -e HOME=/opt/data/home hermes \
  bash /opt/hermes-scripts/label-triage-sweep.sh

# One real tick, then enable.
sudo systemctl start fluncle-label-triage.service            # one tick now
journalctl -u fluncle-label-triage.service -n 40 --no-pager  # expect a LABEL TRIAGE GATE: … line
sudo systemctl enable --now fluncle-label-triage.timer
```

## The remaining half

The gate names the worklist and stops. The batched research leg — one `claude -p` per batch of ten labels under bounded concurrency, writing each batch's JSON as it lands — is **not wired yet**, on purpose: a sweep that fires a five-million-token round on a miscount is worse than one that does nothing, so the gate earns that trust by reporting honestly first. Until then a round is still run in-session through the skill, and the gate tells the operator when one is due.
