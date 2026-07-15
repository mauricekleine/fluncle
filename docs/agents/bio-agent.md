# Bio Agent (the entity bio — the artist/label sibling of the auto-note)

The **entity bio** auto-authors the short Fluncle-voiced paragraph that stands on an entity's page: `/artist/<slug>` and `/label/<slug>`. Where the [auto-note](./note-agent.md) authors one editorial line about one FINDING, this authors a 2–4 sentence bio about an ARTIST or a LABEL — the entity sibling, one artifact over two kinds. It is one more deterministic-with-one-agentic-step sweep the box runs (mirroring the note pipeline), not a new runtime. The Worker owns the store + the voice gate; the box holds only its `agent`-scoped token and calls one CLI command.

An artist bio and a label bio are the SAME artifact — same queue shape, same voice gate, same fill-empty-only store, same `claude -p` authoring — so ONE box sweep ([`entity-bio-sweep.ts`](./hermes/scripts/entity-bio-sweep.ts)) serves both, dispatched by `--kind artist|label`. It runs behind TWO host timers (`fluncle-artist-bio`, `fluncle-label-bio`), so each kind drains on its own cadence and reports its own `/status` row.

## What the bio is (and is NOT)

|            | the `bio` (the entity's voiced paragraph)                                                                                                          |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **What**   | A short 2–4 sentence bio in Fluncle's voice: dry, warm 'who this is' / 'what this imprint is', in-fiction, as if introducing a name to the crew.   |
| **Source** | Written by the **box** (it holds `copywriting-fluncle`) from the gathered Firecrawl facts + the entity's identity. Never a fabricated discography. |
| **Lives**  | `artists.bio` / `labels.bio` — **PUBLIC**: it renders on `/artist/<slug>` and `/label/<slug>` and in the entity's structured data.                 |
| **Gate**   | the **bio voice gate** (`gateBioText`, below), the same shared scan as the note, with the bio's longer 2–4 sentence length ceiling.                |

## The two crons

Both are on-box HYBRID `--no-agent` sweeps — a deterministic queue + ONE `claude -p` authoring + deterministic delivery, mirroring `fluncle-note`. Source: [`hermes/scripts/entity-bio-sweep.ts`](./hermes/scripts/entity-bio-sweep.ts) driven by [`artist-bio-sweep.sh`](./hermes/scripts/artist-bio-sweep.sh) / [`label-bio-sweep.sh`](./hermes/scripts/label-bio-sweep.sh); host timers [`artist-bio-timer/`](./hermes/artist-bio-timer/) + [`label-bio-timer/`](./hermes/label-bio-timer/), installed by [`install-host-timers.sh`](./hermes/install-host-timers.sh) (which auto-discovers the `*-timer/` dirs — no installer edit).

Each tick:

1. **QUEUE** (deterministic): `fluncle admin <kind>s describe --queue --json` → entities with a certified finding but no bio yet (`bio IS NULL/'' AND a finding exists`, oldest first). A bare array of `{ id, name, slug }`. Empty → fast no-op.
2. per entity (bounded batch, `ENTITY_BIO_BATCH_CAP`, default 1):
   - **GATHER** (best-effort): a Firecrawl search for the entity's background (the bio's PRIMARY fuel) + an artist's `findingCount`.
   - **AUTHOR** (the one agentic step): resolve the `describe_artist` / `describe_label` prompt from the registry (baked default as fallback) and run `claude -p` (`claude-sonnet-4-6`, subscription auth, read-only tools) so it loads `copywriting-fluncle`.
   - **DELIVER** (deterministic): `fluncle admin <kind>s describe <slug> --bio-file <tmp> --prompt-version <v>` → the Worker voice-gates, fills-empty-only, stores.

## The grounding (and its gap)

The bio is grounded in **Firecrawl FACTS** — the entity's background, scene, release history (`fetchEntityFacts`, `lib/server/bio.ts`; the raw snippets ARE the facts). The box sweep mirrors that fetch self-contained (the cost-emit / prompt-fetch pattern, since the box cannot import the workspace), best-effort: null on no key / vendor-down, and the entity is authored from identity alone.

**The gap, stated plainly:** the box is a thin CLI client and **cannot enumerate an entity's logged finding TITLES** — no public/agent read exposes them (only an artist's `findingCount`, a number). The Worker-side `getFindingsByArtist` / `getFindingsByLabel` that the pages read are not on the wire. So on-box the `{{findings}}` block is empty and the grounding rests on the Firecrawl facts plus the truthful floor the queue guarantees (every queued entity has ≥1 certified finding, so "an artist/label I have logged" is always true). When a Worker-paced grounding seam lands — a read that hands the box the assembled findings + facts, the way context-note hands the note sweep its `context_note` — pass its titles into the sweep's `findings` variable and both crons upgrade with no other change.

**Firecrawl on the box:** the established pattern is Firecrawl runs Worker-side (the box holds no key — context-sweep, artist-sweep). The bio sweep's mirrored `fetchEntityFacts` is WIRED and lights up wherever a `FIRECRAWL_API_KEY` is in the sourced env. On the box that key is absent by default, so on-box bios ground on identity (honest, sparse, operator-replaceable). The **operator backfill** (below), run locally with a key in env, is where the facts genuinely light up.

## The cardinal safety guarantee: fill an EMPTY bio only

`describe_artist` / `describe_label` fill an entity's bio **only when it is empty**. An entity that already carries a bio — operator-written **or** previously auto-authored — is a no-op (`skipped: true`); the box **never** clobbers an existing bio. **The operator override always wins**, enforced **server-side** (the atomic `fillEmptyArtistBio` / `fillEmptyLabelBio` SQL predicate gated on `bio IS NULL/''`). A gate rejection leaves the entity queued for a future pass.

## The voice gate (a hard ship requirement)

The bio is a live, **public** Fluncle voice surface. `gateBioText` (`lib/server/bio.ts`) reuses the SAME shared scan as the note (`scanObservationScript`: banned identity words, earthly geography, the no-exclamation Dry Rule, no "we"-as-company) with the bio's own longer length bounds (40–500 chars — a 2–4 sentence paragraph, not a one-line note). A violation hard-fails the store before the bio is shown. The box authors through `copywriting-fluncle`; the Worker re-scans (defence in depth); the operator override is the final content control.

## The prompt lives in the DATABASE, not in the image

The authoring prompt is the `describe_artist` / `describe_label` entry in the **prompt registry** ([prompt-registry.md](./prompt-registry.md)). The sweep fetches it over the AGENT-tier `get_prompt` each tick, so the operator can retune it from `/admin/prompts` or the CLI with **no deploy and no rebake**. The repo keeps the baked default (`buildEntityBioPrompt` in `entity-bio-sweep.ts`, a verbatim mirror of the registry default), and a failed fetch falls back to it and logs. Every bio records the version that drafted it (`--prompt-version` → the entity's `*_bio_prompt_version`; `0` = registry default, `N` = override N, `NULL` = the baked fallback wrote it).

## Box activation is OPERATOR-GATED (repo half shipped)

The repo half ships — the sweep, the two `.sh` wrappers, the two host timers, the registry + `/status` wiring, and this doc. **Nothing auto-enables and nothing spends model or Firecrawl credits on merge**, mirroring the crawler / cluster / triage pattern. The operator enables the timers after a dry-run pre-flight (each timer's README) and, optionally, provisioning `FIRECRAWL_API_KEY` in the box secrets for on-box facts.

### The backfill (bounded corpus, one operator run)

The corpus is bounded (tens of artists + labels). `ENTITY_BIO_BATCH_CAP` makes the backfill simply the sweep run once with a high cap — run **locally in a repo checkout** (not on the box), where the operator's env can carry both the subscription token and a `FIRECRAWL_API_KEY` so the bios come out Firecrawl-grounded. Operator-run, never auto-run:

```bash
# Requires in the local env: CLAUDE_CODE_OAUTH_TOKEN (subscription auth for claude -p),
# FLUNCLE_API_TOKEN (agent-scoped), and optionally FIRECRAWL_API_KEY (rich facts).
# Drain the whole artist bio backlog in one pass:
ENTITY_BIO_BATCH_CAP=500 FLUNCLE_BIN=./path/to/fluncle \
  bun docs/agents/hermes/scripts/entity-bio-sweep.ts --kind artist

# …and the labels:
ENTITY_BIO_BATCH_CAP=500 FLUNCLE_BIN=./path/to/fluncle \
  bun docs/agents/hermes/scripts/entity-bio-sweep.ts --kind label
```

Dry-run first to eyeball the voice (nothing stored):

```bash
bun docs/agents/hermes/scripts/entity-bio-sweep.ts --kind artist --dry-run <slug-a> <slug-b>
bun docs/agents/hermes/scripts/entity-bio-sweep.ts --kind label  --dry-run <slug-a> <slug-b>
```

## Safety rails (inline so they survive even if the skill fails to load)

- One entity per tick (one `claude -p` authoring); the queue is the durable worklist. `ENTITY_BIO_BATCH_CAP` raises it for the operator backfill only.
- Fill an EMPTY bio ONLY — never overwrite an operator-written or already-set bio (enforced server-side, atomically, by a DB predicate).
- Only a CERTIFIED entity gets a bio: the queue's `EXISTS` join requires a finding with a non-null `log_id`, so an uncertified/catalogue-only entity never enters the worklist.
- The bio carries **facts grounded in the Firecrawl snippets** + what Fluncle has logged — never invent a discography, roster, date, or scene credential. If the facts are thin, say less.
- The bio is **public** the moment it lands on the entity page — the voice gate is a hard ship requirement, not a nicety.
- Subscription auth only (`CLAUDE_CODE_OAUTH_TOKEN`) — zero OpenRouter tokens, never a raw API key in the repo.
