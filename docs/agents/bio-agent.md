# Bio Agent (the entity bio — the artist/label/album sibling of the auto-note)

The **entity bio** auto-authors the short paragraph that stands on an entity's page: `/artist/<slug>`, `/label/<slug>`, and `/album/<slug>`. It is an OBJECTIVE, factual, Wikipedia-style dossier — who this artist/label is or what this record is, where they are from, what they are known for — written in Fluncle's dry register but in the THIRD person, not as a first-person in-fiction take. Where the [auto-note](./note-agent.md) authors one editorial line about one FINDING in the observation voice, this authors a 2–4 sentence factual bio about an ARTIST, a LABEL, or an ALBUM — the entity sibling, one artifact over three kinds. It is one more deterministic-with-one-agentic-step sweep the box runs (mirroring the note pipeline), not a new runtime. The Worker owns the store + the voice gate; the box holds only its `agent`-scoped token and calls one CLI command.

**The register deliberately DEPARTS from the observation's no-geography rule.** The observation and the auto-note replace the earthly map with the cosmos and ban countries, cities, and nationalities. The bio does the opposite on purpose: it is a reference dossier, so naming a real origin or base ("a producer from Belgium", "a label run out of London") is CORRECT. The bio prompts state the departure explicitly, and the voice gate (below) allows geography for the bio while keeping the other bans.

An artist bio, a label bio, and an album bio are the SAME artifact — same queue shape, same voice gate, same fill-empty-only store, same `claude -p` authoring — so ONE box sweep ([`entity-bio-sweep.ts`](./hermes/scripts/entity-bio-sweep.ts)) serves all three, dispatched by `--kind artist|label|album`. It runs behind THREE host timers (`fluncle-artist-bio`, `fluncle-label-bio`, `fluncle-album-bio`), so each kind drains on its own cadence and reports its own `/status` row.

## What the bio is (and is NOT)

|            | the `bio` (the entity's factual paragraph)                                                                                                                                                            |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **What**   | A short 2–4 sentence OBJECTIVE, factual, Wikipedia-style bio in Fluncle's dry register: third person 'who this is' / 'what this imprint is', real-world facts (including origin/base) stated plainly. |
| **Source** | Written by the **box** (it holds `copywriting-fluncle`) grounded ONLY in the Worker-gathered Firecrawl facts + the logged finding titles the `draft-bio` read supplies. Never a fabricated fact.      |
| **Lives**  | `artists.bio` / `labels.bio` / `albums.bio` — **PUBLIC**: it renders on `/artist/<slug>`, `/label/<slug>` and `/album/<slug>` and in the entity's structured data.                                    |
| **Gate**   | the **bio voice gate** (`gateBioText`, below), the note's shared scan with geography ALLOWED, at the bio's longer 2–4 sentence length ceiling.                                                        |

## The three crons

All three are on-box HYBRID `--no-agent` sweeps — a deterministic queue + ONE `claude -p` authoring + deterministic delivery, mirroring `fluncle-note`. Source: [`hermes/scripts/entity-bio-sweep.ts`](./hermes/scripts/entity-bio-sweep.ts) driven by [`artist-bio-sweep.sh`](./hermes/scripts/artist-bio-sweep.sh) / [`label-bio-sweep.sh`](./hermes/scripts/label-bio-sweep.sh) / [`album-bio-sweep.sh`](./hermes/scripts/album-bio-sweep.sh); host timers [`artist-bio-timer/`](./hermes/artist-bio-timer/) + [`label-bio-timer/`](./hermes/label-bio-timer/) + [`album-bio-timer/`](./hermes/album-bio-timer/), installed by [`install-host-timers.sh`](./hermes/install-host-timers.sh) (which auto-discovers the `*-timer/` dirs — no installer edit).

Each tick:

1. **QUEUE** (deterministic): `fluncle admin <kind>s describe --queue --json` → bio-empty entities whose page is INDEXABLE, oldest first. A bare array of `{ id, name, slug }`. Empty → fast no-op. "Indexable" is the SAME two-way floor the entity pages render on: `bio IS NULL/''` AND (a certified finding exists **OR** the renderable-track count clears the page's thin-content floor — `ARTIST_INDEX_MIN_FINDINGS` / `LABEL_INDEX_MIN_TRACKS` / `ALBUM_INDEX_MIN_TRACKS`, all 3, counted exactly as the sitemap reads count: certified findings + catalogue anti-join tracks). A crawl-minted, findings-free catalogue entity with an indexable page earns a bio when it clears the renderable-track floor. The floor is the cost bound: it keeps the wide crawl's thousands of one-track stubs out of the Firecrawl + `claude -p` path.
2. per entity (bounded batch, `ENTITY_BIO_BATCH_CAP`, default 1):
   - **DRAFT** (deterministic, Worker-paced): `fluncle admin <kind>s draft-bio <slug> --json` → the `draft_artist_bio` / `draft_label_bio` / `draft_album_bio` READ. The **Worker** runs the Firecrawl gather (with its key) + pulls the logged finding **titles** (with its DB) and assembles the registered `describe_artist` / `describe_label` / `describe_album` prompt, returning `{ found, name, findingCount, prompt, promptVersion, hasFacts }`. A `found:false` (unresolved slug) or a failed call → skip (stays queued).
   - **AUTHOR** (the one agentic step): run `claude -p` (`claude-sonnet-4-6`, subscription auth, read-only tools) on the Worker-supplied `prompt` so it loads `copywriting-fluncle`.
   - **DELIVER** (deterministic): `fluncle admin <kind>s describe <slug> --bio-file <tmp> --prompt-version <v>` → the Worker voice-gates, fills-empty-only, stores.

## Worker-paced grounding

The bio is grounded in **Firecrawl FACTS** (the entity's background, scene, release history — the raw snippets ARE the facts) **plus the titles of the tracks Fluncle has actually logged**. The box is a thin CLI client and holds **neither** a `FIRECRAWL_API_KEY` (by convention — the Worker owns it; `context-sweep.ts`) **nor** a read that exposes an entity's finding TITLES (only a `findingCount`). So on its own the box cannot ground a bio at all.

The `draft_artist_bio` / `draft_label_bio` READ closes both gaps at once — the **exact parity the context-note sweep already has**, where the box triggers a Worker read for its grounding and then authors. On this READ the Worker runs Firecrawl with **its** key (`fetchEntityFacts`, `lib/server/bio.ts`), pulls the logged finding titles from **its** DB (`getFindingsByArtist` / `getFindingsByLabel` / `getFindingsByAlbum`), assembles the registered prompt (`buildEntityBioPrompt`), and hands the box a ready-to-author prompt + its provenance version. On-box and manual bio runs use the same Worker-grounded path. The read publishes nothing and returns only public facts (web snippets + finding titles), never a secret.

**Because the bio is FACTUAL, no facts means REFUSE — not improvise.** A first-person observation could always fall back on the sound alone; a factual dossier cannot invent a biography from a bare name. This refusal has two rails. **First**, `isAuthorableDraft` requires Firecrawl facts or at least one finding title before invoking `claude -p`. An entity with neither is skipped and remains bio-less. **Second**, even when there is _some_ grounding, the Worker's `hasFacts:false` arm tells the author to write **at most one plain, certain sentence from the findings, or nothing**, and the gate's 40-char floor (`BIO_MIN_CHARS`) turns a too-thin stub into a clean NO-WRITE (`bio_too_short`, 422) — the entity stays queued, no hallucinated CV ever lands. The floor is load-bearing for exactly this reason — do not lower it.

The `draft-bio` read gathers facts Worker-side, so the box requires no `FIRECRAWL_API_KEY`.

## The cardinal safety guarantee: fill an EMPTY bio only

`describe_artist` / `describe_label` fill an entity's bio **only when it is empty**. An entity that already carries a bio — operator-written **or** previously auto-authored — is a no-op (`skipped: true`); the box **never** clobbers an existing bio. **The operator override always wins**, enforced **server-side** (the atomic `fillEmptyArtistBio` / `fillEmptyLabelBio` SQL predicate gated on `bio IS NULL/''`). A gate rejection leaves the entity queued for another pass — up to its attempt budget (below), never forever.

## The voice gate (a hard ship requirement)

The bio is a live, **public** Fluncle surface. `gateBioText` (`lib/server/bio.ts`) reuses the SAME shared scan as the note (`scanObservationScript`) but in the factual-dossier register: it passes `{ allowGeography: true }`, so it keeps the banned-identity-word, no-exclamation Dry Rule, and no-"we"-as-company bans but NOT the geography ban (a Wikipedia-style bio names a real country/city plainly). It carries the bio's own longer length bounds (40–500 chars — a 2–4 sentence paragraph, not a one-line note). A violation hard-fails the store before the bio is shown. The box authors through `copywriting-fluncle`; the Worker re-scans (defence in depth); the operator override is the final content control.

### The name exemption: the gate polices what FLUNCLE wrote

The scan runs over the bio **with the entity's own name masked out** (`maskEntityName` — implemented beside the shared scan in `lib/server/observation.ts`, re-exported by `lib/server/bio.ts`; every voiced family now uses it) — exact, case-insensitive occurrences of the full name, nothing else. An entity's name is not Fluncle's prose: "Future Signal", "Invaderz Transmissions", and "Jungle Sound: The Bassline Strikes Back!" are real-world names, and a bio about them must be able to name them.

The scan applies `BANNED_WORDS`, the Dry Rule, the "we" ban, and both length bounds after masking exact occurrences of the entity's full name. Two properties follow, and both are pinned by tests:

- **The word is not amnestied, only the name.** A bio may name "Future Signal" and still fails if it uses "signal" as a generic word anywhere else in the paragraph.
- **Masking the full name removes the punctuation inside it**, which is how an album titled with a `!` clears the Dry Rule without the Dry Rule being weakened for anything Fluncle actually wrote.

The match is **word-bounded**, with the boundaries conditional on the name's own edges (`(?<!\w)` only when it starts with a word character, `(?!\w)` only when it ends with one). Without that, a short name is a substring wildcard: the artist "Sign" would mask the middle out of "signal" and "Mission:" would eat the tail of "transmission:", quietly amnestying the exact words the first property promises to keep policing. The conditional edges are what let a title ending in `!` still mask.

A **partial** reference is still judged: a bio about "Future Signal" that says only "Signal" is rejected. That is deliberate — conservative, and the rewrite can use the full name.

**The one unavoidable cost:** when an entity's **whole name IS a banned word**, that word is amnestied in its bio entirely — there is no way to tell "the artist Signal" from the noun in "a signal", because they are the same token. Production carries at least three such entities (`/artist/signal`, `/album/anomaly`, `/album/content`). It is the accepted cost of letting those pages have a bio at all; the alternative is that they cannot be written.

### The attempt budget: three authorings, ever

Each entity receives at most three authoring attempts: the initial draft plus two rewrites.

- **Each rejection is fed back into the next pass** as the exact reason to fix (`buildRewriteBlock` in the sweep, the logbook sweep's shape), so a rewrite is aimed rather than blind.
- **The third draft LANDS.** The last attempt delivers `--final-attempt`, and the Worker (`acceptFinalDraftBio`) stores the draft even if the voice scan refuses it. Final-attempt acceptance is a backstop; the name exemption lets ordinary subject-name matches clear the normal voice gate.
- **The acceptance raises a queue row.** The bypass stamps the entity — `bio_gate_bypassed_at` plus the accepted reasons in `bio_voice_violations`, written in the SAME statement as the bio — which puts a **`bio-review`** row on the `/admin` attention queue (see [the review](#the-review-every-bypassed-bio-raises) below). It also still announces itself in every channel it always did: the Worker logs `describe_<kind>: FINAL-ATTEMPT ACCEPTANCE` and returns `gateBypassed: true` + the accepted `voiceViolations`, the CLI prints them, and the sweep logs `FINAL-ATTEMPT ACCEPTANCE … REVIEW THIS <KIND>` and counts them as `bypassedGate` in its summary line. The acceptance bypasses the voice SCAN only: an absent, too-short, or too-long draft is still refused.
- **Only a gate REJECTION spends the budget.** A rejection is deterministic evidence that this draft was bad. A transport or model failure — a `claude -p` that exits non-zero, returns `is_error`, or returns nothing — is no evidence about the draft at all, because there is no draft; the entity keeps its whole budget and is retried next tick. Otherwise three flaky calls could write an entity off permanently, and a flaky THIRD call would leave it with no draft to accept and no retry. Those failures instead log a line the `/status` sweep-strain detector scores, so a sweep grinding on a broken model surfaces as `degraded`.
- **The count persists across ticks** in a small on-box TSV at `$HOME/.entity-bio-sweep/attempts` (`<kind>:<slug><TAB>attempts<TAB>lastEpoch`), the shape of the render conductor's poison ledger and covered by the nightly box-state backup. It is written the moment a rejection lands, so a tick that dies later cannot un-spend it. The entry is dropped the moment a bio lands.
- **The sweep's log WORDING is part of the contract.** Since the strain detector reads each sweep's captured stderr, these lines are scored: a rejected draft that is about to be rewritten reads as a step (a sweep that rewrites and then succeeds must not read as degraded), while an exhaustion, a transport failure, and a failed ledger write carry the distress vocabulary. The rule is written out above `describeOne` in the sweep and pinned by tests that score the real lines with the real detector.
- **An exhausted entity is skipped without consuming the batch cap**, so it can never block the queue behind it — and it costs nothing at all (no draft fetch, no model call). It reports as `exhausted` in the summary. To re-arm one after the gate or the prompt changes, delete its line from that file.

### What the final-attempt acceptance publishes

On the third attempt, a bio that **failed** the automated voice gate is stored and published. It is not quarantined and not held for approval — it renders identically to a bio that passed. Only the voice SCAN is bypassed; an absent, too-short, or too-long draft is still refused and the entity reports as `exhausted` instead. It **is** marked in the database, and that mark is what raises the review below.

**Where such a bio is publicly readable.** The page copy is the obvious half:

| Surface                                                                | Form                                                                                                                                                                         |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/artist/<slug>`, `/label/<slug>`, `/album/<slug>` page body           | full text                                                                                                                                                                    |
| `<meta name="description">` + `og:description` + `twitter:description` | truncated to ≤160 chars at a sentence boundary (`lib/meta-description.ts`)                                                                                                   |
| The `GraphLink` hover card (`components/graph-link.tsx`)               | full text in the DOM, clamped to 4 lines by CSS only — and it appears **away from the entity's own page**: the homepage feed, log pages, the hub indexes, `/recommendations` |

The **machine-readable discovery layer** is the half that surprises people, because none of it is page copy and all of it carries the paragraph in full:

| Surface                                                                                    | Form                                                                                                           |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| JSON-LD `description` — `MusicGroup` / `Organization` / `MusicAlbum` (`lib/log-schema.ts`) | **full text, untruncated** — the same page that truncates its meta description emits the whole bio to crawlers |
| The public MCP server `/mcp`, `get_artist` / `get_label`                                   | **full text, unauthenticated** — handed to arbitrary third-party agents                                        |
| ChatDnB `/chat` artist + label cards                                                       | **full text**                                                                                                  |
| `GET /api/v1/labels/{slug}`, `/api/v1/albums/{slug}`, `/api/v1/graph/{kind}/{slug}`        | full text, public JSON                                                                                         |
| `fluncle labels <slug> --json`, `fluncle albums <slug> --json`                             | full text                                                                                                      |

It does **not** reach `llms.txt`, the sitemap, any RSS/Atom/JSON/podcast/ICS feed, oEmbed, the OG images, `GET /api/v1/artists/{slug}` (that contract carries no `bio` field — an asymmetry with labels and albums), WebMCP, mobile, the SSH terminal, DNS, Raycast, or the extension.

Final-attempt acceptance is an operator-controlled policy. To disable it, follow the `SEVERABLE` recipe in `bio.ts`; rejected third drafts then take the existing `exhausted` outcome.

### The review every bypassed bio raises

The acceptance stands. What used to be missing was a **reader**: it announced itself only in a cron's stderr and on the write response, so the documented way to find one was to remember to grep — and nobody did. Every surface in the two tables above could therefore be carrying copy the gate refused, with nothing surfacing it.

So the bypass now writes state, and the state is a queue row. It is deliberately the **`label-review` mechanism** rather than a second review channel:

- **Where it lives.** `bio_gate_bypassed_at` (when) + `bio_voice_violations` (the gate's own reasons, JSON) on `artists` / `labels` / `albums`, written in the same statement as the bio. That is the exact shape of `labels.seed_state = 'undecided'`, and it makes the flag **self-clearing**: a later bio that CLEARS the gate writes NULL into both, so no clean paragraph can inherit a stale flag.
- **What it raises.** One `bio-review` row per entity on the `/admin` attention queue, carrying the entity (kind + slug), the gate's reasons, and when it happened, oldest acceptance first. It rides the low-priority curation tier — the copy has already shipped, so it is a review, never a race — and it never carries a deadline. Each kind's arm of the read is capped at `BIO_REVIEW_QUEUE_LIMIT` (25) and served by a PARTIAL index over the lit rows only, so the source cannot drown the queue and costs nothing when it is empty.
- **The two rulings** (`resolve_bio_review`, `POST /admin/bio-reviews/{kind}/{slug}/resolve`, **operator tier** — the agent that authored the bio may not rule on its own work):
  - **Bio stands** (`keep`) — the gate was over-strict. Clears the flag; the page is untouched.
  - **Send it back** (`rewrite`) — the gate was right. Clears the flag **and empties the bio** (with its prompt provenance, and `bio_status` back to `pending`), which returns the entity to the sweep's `describe --queue` worklist with a **fresh three-attempt budget**. Nothing on the box needs re-arming: the on-box attempt ledger already dropped the entity's line when the bio landed.
  - Both are guarded in SQL by `bio_gate_bypassed_at is not null`, so a replayed or racing ruling can never empty a bio nobody flagged — it matches no row and answers 404.
- **How many are waiting.** The row count on `/admin`, or `fluncle admin queue` (the `bio gate` source), or the Raycast menu bar. The sweep's own `bypassedGate` summary counter is unchanged and still rides the run ledger; it counts acceptances **per tick**, while the queue counts the ones still unruled.

## The prompt lives in the DATABASE, not in the image

The authoring prompt is the `describe_artist` / `describe_label` entry in the **prompt registry** ([prompt-registry.md](./prompt-registry.md)). The Worker resolves and renders the registry entry, so the operator can retune it from `/admin/prompts` or the CLI with **no deploy and no rebake**; the box consumes that rendered prompt and carries no independent prompt copy. Every bio records the version that drafted it (the Worker returns `promptVersion`, stamped via `--prompt-version` onto the entity's `*_bio_prompt_version`; `0` = registry default, `N` = override N).

## Operator activation

The sweep, wrappers, host timers, registry, and `/status` wiring are repo-managed. The operator enables each timer after its README's dry-run preflight.

### The backfill (bounded corpus, one operator run)

The corpus is bounded (tens of artists + labels). `ENTITY_BIO_BATCH_CAP` makes the backfill simply the sweep run once with a high cap. The backfill uses the Worker `draft-bio` read and requires no local `FIRECRAWL_API_KEY`. It is just a high-cap run of the same sweep (run locally so the subscription token authors `claude -p`). Operator-run, never auto-run:

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
