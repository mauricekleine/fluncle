# Bio Agent (the entity bio — the artist/label/album sibling of the auto-note)

The **entity bio** auto-authors the short paragraph that stands on an entity's page: `/artist/<slug>`, `/label/<slug>`, and `/album/<slug>`. It is an OBJECTIVE, factual, Wikipedia-style dossier — who this artist/label is or what this record is, where they are from, what they are known for — written in Fluncle's dry register but in the THIRD person, not as a first-person in-fiction take. Where the [auto-note](./note-agent.md) authors one editorial line about one FINDING in the observation voice, this authors a 2–4 sentence factual bio about an ARTIST, a LABEL, or an ALBUM — the entity sibling, one artifact over three kinds. It is one more deterministic-with-one-agentic-step sweep the box runs (mirroring the note pipeline), not a new runtime. The Worker owns the store + the voice gate; the box holds only its `agent`-scoped token and calls one CLI command.

**The register deliberately DEPARTS from the observation's no-geography rule.** The observation and the auto-note replace the earthly map with the cosmos and ban countries, cities, and nationalities. The bio does the opposite on purpose: it is a reference dossier, so naming a real origin or base ("a producer from Belgium", "a label run out of London") is CORRECT. The bio prompts state the departure explicitly, and the voice gate (below) allows geography for the bio while keeping the other bans.

An artist bio, a label bio, and an album bio are the SAME artifact — same queue shape, same voice gate, same fill-empty-only store, same `claude -p` authoring — so ONE box sweep ([`entity-bio-sweep.ts`](./hermes/scripts/entity-bio-sweep.ts)) serves all three, dispatched by `--kind artist|label|album`. It runs behind THREE host timers (`fluncle-artist-bio`, `fluncle-label-bio`, `fluncle-album-bio`), so each kind drains on its own cadence and reports its own `/status` row.

## What the bio is (and is NOT)

|            | the `bio` (the entity's factual paragraph)                                                                                                                                                            |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **What**   | A short 2–4 sentence OBJECTIVE, factual, Wikipedia-style bio in Fluncle's dry register: third person 'who this is' / 'what this imprint is', real-world facts (including origin/base) stated plainly. |
| **Source** | Written by the **box** (it holds `copywriting-fluncle`) grounded ONLY in the Worker-gathered Firecrawl facts + the logged finding titles the `draft-bio` read supplies. Never a fabricated fact.      |
| **Lives**  | `artists.bio` / `labels.bio` — **PUBLIC**: it renders on `/artist/<slug>` and `/label/<slug>` and in the entity's structured data.                                                                    |
| **Gate**   | the **bio voice gate** (`gateBioText`, below), the note's shared scan with geography ALLOWED, at the bio's longer 2–4 sentence length ceiling.                                                        |

## The two crons

Both are on-box HYBRID `--no-agent` sweeps — a deterministic queue + ONE `claude -p` authoring + deterministic delivery, mirroring `fluncle-note`. Source: [`hermes/scripts/entity-bio-sweep.ts`](./hermes/scripts/entity-bio-sweep.ts) driven by [`artist-bio-sweep.sh`](./hermes/scripts/artist-bio-sweep.sh) / [`label-bio-sweep.sh`](./hermes/scripts/label-bio-sweep.sh); host timers [`artist-bio-timer/`](./hermes/artist-bio-timer/) + [`label-bio-timer/`](./hermes/label-bio-timer/), installed by [`install-host-timers.sh`](./hermes/install-host-timers.sh) (which auto-discovers the `*-timer/` dirs — no installer edit).

Each tick:

1. **QUEUE** (deterministic): `fluncle admin <kind>s describe --queue --json` → entities with a certified finding but no bio yet (`bio IS NULL/'' AND a finding exists`, oldest first). A bare array of `{ id, name, slug }`. Empty → fast no-op.
2. per entity (bounded batch, `ENTITY_BIO_BATCH_CAP`, default 1):
   - **DRAFT** (deterministic, Worker-paced): `fluncle admin <kind>s draft-bio <slug> --json` → the `draft_artist_bio` / `draft_label_bio` READ. The **Worker** runs the Firecrawl gather (with its key) + pulls the logged finding **titles** (with its DB) and assembles the registered `describe_artist` / `describe_label` prompt, returning `{ found, name, findingCount, prompt, promptVersion, hasFacts }`. A `found:false` (unresolved slug) or a failed call → skip (stays queued).
   - **AUTHOR** (the one agentic step): run `claude -p` (`claude-sonnet-4-6`, subscription auth, read-only tools) on the Worker-supplied `prompt` so it loads `copywriting-fluncle`.
   - **DELIVER** (deterministic): `fluncle admin <kind>s describe <slug> --bio-file <tmp> --prompt-version <v>` → the Worker voice-gates, fills-empty-only, stores.

## The grounding is Worker-paced (the gap is CLOSED)

The bio is grounded in **Firecrawl FACTS** (the entity's background, scene, release history — the raw snippets ARE the facts) **plus the titles of the tracks Fluncle has actually logged**. The box is a thin CLI client and holds **neither** a `FIRECRAWL_API_KEY` (by convention — the Worker owns it; `context-sweep.ts`) **nor** a read that exposes an entity's finding TITLES (only a `findingCount`). So on its own the box cannot ground a bio at all.

The `draft_artist_bio` / `draft_label_bio` READ closes both gaps at once — the **exact parity the context-note sweep already has**, where the box triggers a Worker read for its grounding and then authors. On this READ the Worker runs Firecrawl with **its** key (`fetchEntityFacts`, `lib/server/bio.ts`), pulls the logged finding titles from **its** DB (`getFindingsByArtist` / `getFindingsByLabel` / `getFindingsByAlbum`), assembles the registered prompt (`buildEntityBioPrompt`), and hands the box a ready-to-author prompt + its provenance version. The consequence that matters: **the on-box crons now produce GROUNDED bios**, not only the manual backfill. The read publishes nothing and returns only public facts (web snippets + finding titles), never a secret.

**Because the bio is FACTUAL, no facts means REFUSE — not improvise.** A first-person observation could always fall back on the sound alone; a factual dossier cannot invent a biography from a bare name. The Worker's `hasFacts:false` case renders the prompt's no-facts arm, which tells the author to write **at most one plain, certain sentence from the findings, or nothing**. The gate's 40-char floor (`BIO_MIN_CHARS`) then turns that refusal into a clean NO-WRITE: a stub too short to be a real bio fails `bio_too_short` (422), the entity stays queued, and no hallucinated CV ever lands. The floor is load-bearing for exactly this reason — do not lower it.

**No Firecrawl key on the box.** Because the gather runs Worker-side in the `draft-bio` read, the box needs no `FIRECRAWL_API_KEY` — the earlier box-mirrored `fetchEntityFacts` is gone. On-box bios come out Firecrawl-grounded, exactly like the manual backfill.

## The cardinal safety guarantee: fill an EMPTY bio only

`describe_artist` / `describe_label` fill an entity's bio **only when it is empty**. An entity that already carries a bio — operator-written **or** previously auto-authored — is a no-op (`skipped: true`); the box **never** clobbers an existing bio. **The operator override always wins**, enforced **server-side** (the atomic `fillEmptyArtistBio` / `fillEmptyLabelBio` SQL predicate gated on `bio IS NULL/''`). A gate rejection leaves the entity queued for a future pass.

## The voice gate (a hard ship requirement)

The bio is a live, **public** Fluncle surface. `gateBioText` (`lib/server/bio.ts`) reuses the SAME shared scan as the note (`scanObservationScript`) but in the factual-dossier register: it passes `{ allowGeography: true }`, so it keeps the banned-identity-word, no-exclamation Dry Rule, and no-"we"-as-company bans but NOT the geography ban (a Wikipedia-style bio names a real country/city plainly). It carries the bio's own longer length bounds (40–500 chars — a 2–4 sentence paragraph, not a one-line note). A violation hard-fails the store before the bio is shown. The box authors through `copywriting-fluncle`; the Worker re-scans (defence in depth); the operator override is the final content control.

## The prompt lives in the DATABASE, not in the image

The authoring prompt is the `describe_artist` / `describe_label` entry in the **prompt registry** ([prompt-registry.md](./prompt-registry.md)). The **Worker** resolves and renders it inside the `draft-bio` read (`buildEntityBioPrompt` → `renderRegisteredPrompt`), so the operator can retune it from `/admin/prompts` or the CLI with **no deploy and no rebake**, and the box no longer carries any baked copy of the bio prompt (nothing on-box can drift from the registry). Every bio records the version that drafted it (the Worker returns `promptVersion`, stamped via `--prompt-version` onto the entity's `*_bio_prompt_version`; `0` = registry default, `N` = override N).

## Box activation is OPERATOR-GATED (repo half shipped)

The repo half ships — the sweep, the two `.sh` wrappers, the two host timers, the registry + `/status` wiring, and this doc. **Nothing auto-enables and nothing spends model credits on merge**, mirroring the crawler / cluster / triage pattern. The operator enables the timers after a dry-run pre-flight (each timer's README). The box needs no Firecrawl key — the gather runs Worker-side.

### The backfill (bounded corpus, one operator run)

The corpus is bounded (tens of artists + labels). `ENTITY_BIO_BATCH_CAP` makes the backfill simply the sweep run once with a high cap. It now goes through the **same Worker `draft-bio` read** as the box crons, so it no longer needs a local `FIRECRAWL_API_KEY` — the Worker gathers the facts. It is just a high-cap run of the same sweep (run locally so the subscription token authors `claude -p`). Operator-run, never auto-run:

```bash
# Requires in the local env: CLAUDE_CODE_OAUTH_TOKEN (subscription auth for claude -p) and
# FLUNCLE_API_TOKEN (agent-scoped — the draft-bio + describe reads/writes). The Firecrawl
# gather runs Worker-side, so NO local Firecrawl key is needed.
# Drain the whole artist bio backlog in one pass:
ENTITY_BIO_BATCH_CAP=500 FLUNCLE_BIN=./path/to/fluncle \
  bun docs/agents/hermes/scripts/entity-bio-sweep.ts --kind artist

# …the labels:
ENTITY_BIO_BATCH_CAP=500 FLUNCLE_BIN=./path/to/fluncle \
  bun docs/agents/hermes/scripts/entity-bio-sweep.ts --kind label

# …and the albums:
ENTITY_BIO_BATCH_CAP=500 FLUNCLE_BIN=./path/to/fluncle \
  bun docs/agents/hermes/scripts/entity-bio-sweep.ts --kind album
```

Dry-run first to eyeball the voice (nothing stored):

```bash
bun docs/agents/hermes/scripts/entity-bio-sweep.ts --kind artist --dry-run <slug-a> <slug-b>
bun docs/agents/hermes/scripts/entity-bio-sweep.ts --kind label  --dry-run <slug-a> <slug-b>
bun docs/agents/hermes/scripts/entity-bio-sweep.ts --kind album  --dry-run <slug-a> <slug-b>
```

## Safety rails (inline so they survive even if the skill fails to load)

- One entity per tick (one `claude -p` authoring); the queue is the durable worklist. `ENTITY_BIO_BATCH_CAP` raises it for the operator backfill only.
- Fill an EMPTY bio ONLY — never overwrite an operator-written or already-set bio (enforced server-side, atomically, by a DB predicate).
- Only a CERTIFIED entity gets a bio: the queue's `EXISTS` join requires a finding with a non-null `log_id`, so an uncertified/catalogue-only entity never enters the worklist.
- The bio carries **facts grounded in the Firecrawl snippets** + what Fluncle has logged — never invent a discography, roster, date, or scene credential. If the facts are thin, say less.
- The bio is **public** the moment it lands on the entity page — the voice gate is a hard ship requirement, not a nicety.
- Subscription auth only (`CLAUDE_CODE_OAUTH_TOKEN`) — zero OpenRouter tokens, never a raw API key in the repo.
