# Logbook Agent (Fluncle's Logbook — the voyage as a continuous travelogue)

**Fluncle's Logbook** is the voyage written down: one first-person travelogue **entry per SECTOR-DAY** — what the day was like, where the trip went, and how each banger landed as Fluncle arrived at its coordinate. Every day that had at least one finding gets an entry, authored nightly by a box sweep. It is long-form AEO fuel and the [story canon](../../LORE.md) made continuous: where a finding's `/log` page is a single waypoint and the [auto-note](./note-agent.md) is its one editorial line, the Logbook is the through-line that connects a day's findings into a lived stretch of the journey.

It is one more deterministic-with-one-agentic-step sweep the box runs, not a new runtime — the [note](./note-agent.md) / [observation](./observation-agent.md) shape exactly. The Worker owns the store + the voice gate; the agent holds only its `FLUNCLE_API_TOKEN` (plus the `claude -p` subscription token) and calls the CLI.

## The sector-day model + the surfaces

A **sector-day** is the canonical days-since-epoch number from `sectorDay()` (`apps/web/src/lib/log-id-shared.ts`) — the same `036` that leads a Log ID like `036.7.2I`. One entry per sector-day, keyed by the integer `sector` (the `logbook_entries` table PK, migration `drizzle/0058`).

- **`/logbook`** — the reverse-chronological index of every authored entry (newest sector first), a quiet archival plate with a `Blog` JSON-LD block.
- **`/logbook/<sector>`** — one day's full entry (e.g. `/logbook/036`), markdown rendered, the day's findings inlined as photos, prev/next nav across existing entries, per-entry `Article` JSON-LD + OG. Server-rendered, clean heading structure, dark-only, cover-led, WCAG AA.

The public pages read the store directly (server functions), like `/log`; the agent never touches the pages.

## The token contract (the canonical home)

The body is markdown-lite: blank-line-separated paragraphs, `##`/`###` headings, `**bold**` / `*italic*` inline emphasis, and — the load-bearing bit — the **FIGURE TOKEN**.

A line that is **exactly** `[[<logId>]]` (a finding's coordinate on its own line, e.g. `[[036.7.2I]]`, or a mixtape's `[[019.F.1A]]`) is not prose: it marks where that finding's **poster image is inlined as a real "photo"** of Fluncle's day. The renderer swaps the token for:

- the finding's poster at `https://found.fluncle.com/<logId>/poster.jpg` (the `trackMedia().posterUrl` convention),
- captioned **`Artist — Title · <logId>`**,
- the whole figure linking to `/log/<logId>`.

Rules that hold:

- Only a **whole-line** token becomes a figure. An inline `[[036.7.2I]]` inside a sentence stays literal text (it never yanks a photo mid-paragraph).
- An **unknown / removed** coordinate (a finding since deleted, or an off-day reference) still renders — the poster URL derives from the coordinate and the caption falls back to the bare Log ID — so a stale token degrades gracefully instead of breaking the page.
- The parser only ever emits TEXT (plain strings + a validated logId), never raw HTML, so every segment renders as a React text node — no injection sink.

The parser lives in `apps/web/src/lib/logbook.ts` (`parseLogbookBody`, `resolveLogbookFigure`) and is covered by `apps/web/src/lib/logbook.test.ts`.

## The ops

Everything nests under `/admin/logbook` (contract-only oRPC — no TanStack route files). Convention B `verb_noun`:

| op                     | route                           | tier                       | what                                                                                                                                         |
| ---------------------- | ------------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_logbook_gaps`    | `GET /admin/logbook/gaps`       | **admin** (agent-allowed)  | The sweep's self-healing window + material: past sector-days with findings but no entry, oldest first, each bundled with its findings' fuel. |
| `create_logbook_entry` | `POST /admin/logbook/{sector}`  | **admin** (agent)          | Author a sector's entry — **fill-empty-only**. Voice-gates title + body.                                                                     |
| `update_logbook_entry` | `PATCH /admin/logbook/{sector}` | **operator** (agent → 403) | Create-or-overwrite; stamps the entry operator-authored (sacred).                                                                            |

The CLI relays them: `fluncle admin logbook gaps` / `create <sector> --title … --body-file …` / `update <sector> …`.

## The cardinal safety guarantee: fill an EMPTY sector only

`create_logbook_entry` writes a sector's entry **only when that sector has none**. A sector that already carries an entry — operator-edited **or** previously auto-authored — is a no-op (`skipped: true`); the agent **never** clobbers an existing entry. **The operator override always wins**, and this is enforced **server-side** by the `sector` PK insert (`on conflict do nothing`, then a re-read returns the standing winner — race-safe), and **covered by a test** (`logbook.server.test.ts`: the guard short-circuits before gating, so an existing entry is untouched regardless of the input). `update_logbook_entry` is the deliberate operator path that CAN replace an entry, stamping `generated_by = 'operator'` so the agent create thereafter treats it as sacred forever.

## The voice gate (a hard ship requirement)

The entry is a live, **public**, **written** Fluncle-voice surface — it lands straight on `/logbook`. Its gate is the SAME defence-in-depth shape as the written note's, sharing one banned-word source of truth (`scanObservationScript` in `observation.ts`): **zero** banned identity words (`signal`, `transmission`, …), zero `!` (the Dry Rule), no earthly geography (the cosmos replaces the map), no "we"-as-company. The scan runs over the **prose with the `[[logId]]` figure tokens stripped**, so a coordinate never trips it. Length: the body prose (tokens stripped) has an 80-char floor and the whole body a 12 000-char ceiling; the title caps at 140. A violation hard-fails the store before the entry is ever shown (`no_title`/400, `no_body`/400, `body_too_short`/422, `title_too_long`/422, `body_too_long`/422, `voice_gate`/422, `invalid_sector`/400).

## The self-healing window

`list_logbook_gaps` computes, deterministically, every **past** sector-day (`sector < todaySector` — the in-progress day is excluded so an entry is written only once the day is COMPLETE) that has **≥1 published finding** and **no entry**, **oldest first**, bounded per call. Each gap carries the day's findings — `title` / `artists` / `logId` / `posterUrl` plus the public `note` and the internal fuel (`context_note`, the observation transcript) — so ONE call gives the sweep both its worklist AND its material. Because the window is recomputed from live data each run, it naturally **backfills history** on first runs (it just walks the oldest gaps forward) and self-heals a missed night.

## The voice rails (the authoring doctrine)

The `claude -p` step authors through the `copywriting-fluncle` skill; the prompt restates the hard, gate-enforced rails so the output lands gate-safe and the figures sit right:

- First-person traveler's **journal** — what the day was like, where the trip went, how each banger landed. Said-not-written, as if texting the crew after a long day out; dry confidence (the music brags, the copy doesn't).
- Say **"I"**. The crew are "them" / "the crew" — never "we" as a company.
- **Never** earthly geography (no countries, cities, regions, nationalities); the cosmos replaces the map — translate any origin into a far sector or drop it.
- No exclamation marks, no hype (the Dry Rule).
- Place each finding's `[[<logId>]]` figure token **on its own line** where its photo should sit, and weave the prose around the photos so the entry reads as an illustrated journal.
- **Ground every claim** in the day's findings (their note / context_note / observation transcript); never invent a track, artist, date, label, stat, or coordinate — use only the logIds the gap listed.

**Images are text-only:** the box `claude -p` sweeps run with `Read,Glob,Grep` and no multimodal input, so each poster is passed to the model as a URL in the prompt, NOT as an image the model sees. The model places the token; the PAGE renders the real poster. Revisit if the box gains image input.

## The box cron + host timer (LIVE spec; activation OPERATOR-GATED)

`fluncle-logbook` is the on-box `--no-agent` HYBRID sweep — deterministic gap read + gather, ONE `claude -p` authoring per day, deterministic delivery — mirroring `fluncle-note`. It runs once a day at **00:40 Amsterdam** (shortly after local midnight, so the day that just ended is complete). Source: [`hermes/scripts/logbook-sweep.{sh,ts}`](./hermes/scripts/); the host systemd timer + the full activation + backfill runbook is [`hermes/logbook-timer/README.md`](./hermes/logbook-timer/README.md). It exposes `LOGBOOK_CLAUDE_MODEL` (default `claude-sonnet-4-6`) + `LOGBOOK_CLAUDE_EFFORT` env hooks, and its `/status` freshness row is `cron.logbook` (registered in `@fluncle/registry` + the `fluncle-healthcheck` prober). The repo half is complete; standing the box timer up is an operator step (a new cron — nothing is retired).

## Safety rails (inline so they survive even if the skill fails to load)

- ONE day per run (one `claude -p` authoring per tick); the gap list is the durable worklist, drained oldest-first across ticks.
- Fill an EMPTY sector ONLY — never overwrite an operator- or already-authored entry (enforced server-side by the PK insert).
- The entry carries **facts grounded in the day's findings** — never quote or closely paraphrase lyrics, never invent a claim or a coordinate.
- The entry is **public** the moment it lands on `/logbook` — the voice gate is a hard ship requirement, not a nicety.

## The prompt lives in the DATABASE, not in the image

The authoring prompt is the `logbook_entry` entry in the **prompt registry** ([docs/agents/prompt-registry.md](./prompt-registry.md)). The sweep fetches it over the AGENT-tier `get_prompt` each tick, so the operator retunes it from `/admin/prompts` or the `fluncle admin prompts` CLI with **no deploy and no box rebake**.

The repo still keeps the baked default (`buildAuthoringPrompt` in `logbook-sweep.ts`), and a failed fetch falls back to it and logs — a prompt store that blinks can never stop the sweep. Every entry records the version that drafted it in `logbook_entries.prompt_version` (`0` = the repo's default, `N` = override N, `NULL` = the baked fallback wrote it).
