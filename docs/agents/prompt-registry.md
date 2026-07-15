# The Prompt Registry (what Fluncle tells the models, in the database)

Every prompt Fluncle feeds a model at runtime lives in the **registry** — a baked-in default in the repo, with an optional **versioned override in the database** on top. The operator edits a prompt from `/admin/prompts` or the `fluncle admin prompts` CLI, and it is live on the next tick. **No deploy. No box rebake.**

## Why

A prompt is the most iterative object in the system and it had the heaviest change loop: a code edit, a review, a deploy, and — for the five that run on the box — a rebake of the image. That loop is wrong for a thing whose whole nature is _reword it, watch what it does, reword it again_, and it is the loop we will run hardest when we go after homogenisation (the neighbour block in the finding-note prompt is the front line, and it is going to get tuned a lot).

## A prompt IS code, so the safety rails are the feature

A bad live edit **silently degrades every artifact it touches** until a human notices. Nothing about this feature is safe unless four things are true, so all four are load-bearing:

1. **Versioning, a visible diff, and a one-action rollback.** The operator must be able to see what changed, when, and put it back.
2. **A sweep can never break because a prompt row is missing.** The repo keeps the default; the database only ever _overrides_ it. Every failure falls back and logs.
3. **The voice gates stay.** An editable prompt is not a licence to bypass the gate that keeps Fluncle sounding like Fluncle. The Worker re-scans every authored artifact exactly as it did before — the gates never read a prompt and cannot be edited from `/admin`.
4. **Provenance on the artifact.** Every artifact records the prompt version that drafted it, so _"the notes got worse last week"_ is a question with an answer.

## The three tiers, and the version each reports

The version is not decoration — it is stamped onto the artifact, so it has to mean something precise.

| version | source     | what it means                                                                                                              |
| ------- | ---------- | -------------------------------------------------------------------------------------------------------------------------- |
| `N ≥ 1` | `override` | the operator's live edit — `prompt_versions.version` = N                                                                   |
| `0`     | `default`  | no override on file; the repo's baked default is running. A real, citable value — not "unknown"                            |
| `null`  | (fallback) | **the caller never reached the registry at all.** The on-box sweep could not read the API and used its own inlined builder |

`null` is the honest record of an outage. A note authored while the Worker was unreachable is legible as such forever, rather than silently attributed to a version that did not write it.

## Why a table and not the `settings` KV

The `settings` KV (`clip_drip_paused`, `publish_advance_paused`, the capture budget) is the right home for a **scalar** whose only history is _what is it now_. A prompt is none of that — it is a versioned **document**:

- A single mutable `value` cell carries **no history**, so there is nothing to diff against and nothing to roll back to.
- It carries **no version integer**, so the `*_prompt_version` provenance columns would have nothing to point at.

So: `prompt_versions`, **one row per edit, append-only**. A row is never mutated and never deleted; the active prompt for a slug is simply its highest `version`. That makes every operation a forward move with an audit trail:

- **edit** → insert version N+1
- **roll back to version K** → insert version N+1 carrying version K's body
- **reset** → insert version N+1 carrying the repo's baked default

**A rollback is therefore an append, not a rewind.** The thing you rolled back _from_ stays readable, and the rollback is itself undoable. There is deliberately no `restore_prompt` op — modelling a rollback as its own destructive-sounding verb would imply the history rewinds. It does not.

## The architecture is decided by the box

**The box runs a pinned CLI release and a baked script image.** A new `fluncle` verb does not exist on the box until a release _and_ a pin bump — which is the exact deploy loop this feature exists to abolish. So a sweep reaches its prompt the only way it can reach anything new: **over the API, with the `agent`-scoped token it already holds.**

```
  the operator                     the Worker                        the box (rave-02)
 ┌────────────────┐          ┌───────────────────────┐          ┌──────────────────────┐
 │ /admin/prompts │─POST────▶│ update_prompt         │          │ note-sweep.ts        │
 │ fluncle admin  │  (op)    │   → prompt_versions   │          │ observe-sweep.ts     │
 │   prompts …    │          │                       │          │ logbook-sweep.ts     │
 └────────────────┘          │ get_prompt  (AGENT)   │◀──GET────│ triage-sweep.ts      │
                             │   → override, else    │  each     │ newsletter-sweep.ts  │
                             │     the baked default │  tick     │                      │
                             │                       │          │  fetch fails?        │
                             │ context_distil  ─┐    │          │  → its own inlined   │
                             │ search_filter   ─┴─in-│          │    builder, v=null   │
                             │      process          │          └──────────────────────┘
                             └───────────────────────┘
```

- **`get_prompt`** (`GET /admin/prompts/{slug}`) is **AGENT tier** — the `record_cost` / `record_health` precedent. Lean by design: the resolved body and the version to stamp. It cannot 404 on a registered slug, and it cannot fail: a slug with no override resolves to the repo's baked default at version 0.
- **`list_prompts`** (`GET /admin/prompts`) and **`update_prompt`** (`POST /admin/prompts/{slug}`) are **OPERATOR tier**. An agent may read the prompt it runs; it may never rewrite it. Editing what Fluncle _says_ is publish-class.

The box side is `docs/agents/hermes/scripts/prompt-fetch.ts` — the shared best-effort reader, modelled on `cost-emit.ts` (the precedent for a box script that talks to the API directly). It **cannot throw**: no token, a non-2xx, a network error, a timeout, an empty body — every path returns `null`, and `null` means one thing to every caller: **fall back to the builder baked into the sweep and author exactly as it did before this feature existed.**

That inlined builder is not dead code. It is the floor, and it is what makes "the prompt store is down" a boring event instead of a stopped pipeline.

## The template

Two constructs, and nothing else — because a prompt template is edited by a human at 1am and every feature is a way to break a sweep.

```
{{name}}              the variable's value, or "" when it is absent/empty
{{#if name}}…{{/if}}  the block, only when `name` is a non-empty string
```

There are **no loops** (a list arrives pre-joined as one string variable) and **no `else`** (a two-armed branch is expressed as two flags — see `contextNote` / `noContextNote`). The renderer is **total**: every input renders to a string, an unknown variable renders empty, and nothing throws. An operator's typo in the editor must never be able to stop a sweep.

The whole prose is in the template, deliberately. A template that only exposed the data slots would let the operator change the facts and nothing that matters.

## The inventory

Nine prompts author a Fluncle artifact in production. All nine are in the registry.

| slug                 | what it writes                                 | runs   | provenance column                     |
| -------------------- | ---------------------------------------------- | ------ | ------------------------------------- |
| `note_author`        | a finding's public editorial note (`/log`)     | box    | `findings.note_prompt_version`        |
| `observation_script` | a finding's spoken recovered-audio observation | box    | `findings.observation_prompt_version` |
| `logbook_entry`      | one sector-day of the Logbook travelogue       | box    | `logbook_entries.prompt_version`      |
| `triage_verdict`     | the advisory one-liner on a crew submission    | box    | `submissions.triage_prompt_version`   |
| `newsletter_edition` | the Friday edition (JSON)                      | box    | `editions.prompt_version`             |
| `context_distil`     | the internal `context_note` (the factual fuel) | Worker | `findings.context_prompt_version`     |
| `search_filter`      | a search query → a JSON filter object          | Worker | — (nothing is persisted)              |
| `describe_artist`    | an artist's voiced public bio                  | box    | `artists.bio_prompt_version`          |
| `describe_label`     | a record label's voiced public bio             | box    | `labels.bio_prompt_version`           |

`describe_artist` / `describe_label` are the **entity-bio engine** — the entity sibling of `note_author` (that authors ONE finding's line; these describe a whole artist/label). Each carries a grounding rail: the bio states only what the gathered Firecrawl facts support AND what Fluncle has actually LOGGED, never a fabricated discography, roster, or scene credential.

`search_filter` is a **parser**, not a voice, and it persists no artifact — so it carries no provenance column. It is in the registry anyway, and it is the _safest_ to make editable: its output is Zod-validated, so a bad edit degrades search to the full-text tier rather than corrupting anything. Search quality is exactly the kind of thing you want to tune without a deploy.

### What stays baked in the repo, and why

The registry owns the prompts that **author a Fluncle artifact in production**. These are prompts too, and they deliberately stay in the repo:

- **The nightly codebase-audit briefs** (`docs/agents/hermes/scripts/audit/prompts/*.md`, plus `_reviewer.md`) — they must version **with the code they audit**. A brief pointing at a file that moved is a broken brief, and no deploy-free edit can fix that. They are already plain files in a git checkout the box self-freshens, so they change with a push and no rebake.
- **The video render-queue brief** (`packages/skills/fluncle-video/automation/render-queue.prompt.md`) — same reasoning: it versions with the video kit it drives.
- **The MCP prompts** (`lib/server/mcp.ts`) — these are prompts Fluncle **serves to other people's agents**. They are a published API surface; changing one is an API change and belongs behind review.
- **The ChatDnB system prompt** (`FLUNCLE_CHAT_SYSTEM_PROMPT` in `lib/server/chat.ts`) — the admin-gated chat station authors no persisted artifact (nothing to stamp a provenance version onto), and its grounding rules are pinned by tests, so it versions with the code.
- **The Hermes gateway persona** (`docs/agents/hermes/SOUL.md`), **the sprite image prompts**, **the dev-time reviewer agents** (`.claude/agents/*.md`) — different runtimes, none of them on the artifact path.

## Provenance

Every artifact records the version that drafted it, written **in the same statement as the artifact itself** — so the version can never describe a different note than the one it wrote.

```sql
-- every note authored under prompt v7
select log_id, note from findings where note_prompt_version = 7;

-- everything written during an outage (the sweep's baked fallback wrote it)
select log_id from findings where note is not null and note_prompt_version is null;
```

`NULL` means no registry prompt wrote it — an **operator-typed** note, or a sweep that fell back. Both are honest readings, and neither is a version it never saw.

## The operator loop

```bash
fluncle admin prompts list                       # where each one runs, and what is live
fluncle admin prompts get note_author            # the body running right now
fluncle admin prompts diff note_author           # the live body vs the repo's default
fluncle admin prompts history note_author        # every version: when, who, and the why
fluncle admin prompts update note_author --body-file tuned.txt --note "shortened the neighbour block"
fluncle admin prompts rollback note_author 3     # put v3's body back, as a new version
fluncle admin prompts reset note_author          # put the repo's baked default back
```

The same loop lives at **`/admin/prompts`**: the list, the editor with a live diff against the running body, the full history with a per-version diff, a one-action **Roll back** behind a confirm that names what it does, and **Reset to the repo default** demoted behind the `⋮`.

**Always write the note.** It is what makes the history readable a month later — and a month later is exactly when you will be asking.
