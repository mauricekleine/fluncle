# Naming Conventions (proposal)

Status: **PROPOSAL — not yet ratified.** This doc audits Fluncle's public verb/noun vocabulary across every public surface, surfaces the inconsistencies, and proposes a convention so that one operation has one predictable name everywhere. Nothing here is implemented; no renames have happened. Maurice picks the final pattern, then we land it surface by surface.

The scope is the _names a human or agent types or reads_: CLI commands and flags, HTTP API route paths and OpenAPI `operationId`s, MCP/WebMCP tool names, the SSH terminal's deep-link commands and menu, and the admin board's user-facing action verbs. It is not about internal function names, database columns, or component names — except where those leak into a public name.

This convention is subordinate to the voice canon. Where consistency would fight Fluncle's voice (`packages/skills/copywriting-fluncle`, `VOICE.md`), the voice wins and the convention bends. See [§5 Voice boundary](#5-voice-boundary).

## 1. The surfaces, as they stand today

### 1.1 CLI (`apps/cli`)

The `fluncle` tree, grouped as the root help presents it (Listen / Share / Meta), plus the hidden `track` group and the hidden `admin` tree.

| Group               | Command                                                                                            | Shape                                                        | Notes                                                                                                                                  |
| ------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| (root)              | `recent` (alias `list`)                                                                            | bare verb-ish noun                                           | "the latest bangers"                                                                                                                   |
| (root)              | `mixtapes`                                                                                         | bare plural noun                                             | lists Fluncle's checkpoint sets                                                                                                        |
| (root)              | `open [target]`                                                                                    | verb + positional target (`playlist`, `telegram`)            |                                                                                                                                        |
| (root)              | `random`                                                                                           | bare noun/adjective                                          | "the archive throws one back"                                                                                                          |
| (root)              | `subscribe [email]`                                                                                | verb + positional                                            |                                                                                                                                        |
| (root)              | `submit [search-or-url]`                                                                           | verb + positional                                            |                                                                                                                                        |
| (root)              | `about`, `version`                                                                                 | bare nouns                                                   | meta                                                                                                                                   |
| `track` (hidden)    | `track get [idOrLogId]`                                                                            | **noun → verb**                                              | public lookup                                                                                                                          |
| `admin`             | `add [spotifyUrl]`                                                                                 | bare verb                                                    | publish a track                                                                                                                        |
| `admin`             | `queue`                                                                                            | bare noun (implies "show queue")                             |                                                                                                                                        |
| `admin`             | `enrich-queue`                                                                                     | **dash compound** noun                                       |                                                                                                                                        |
| `admin`             | `enrich-sweep`                                                                                     | **dash compound** verb-noun                                  |                                                                                                                                        |
| `admin`             | `vehicles`                                                                                         | bare plural noun                                             |                                                                                                                                        |
| `admin track`       | `update`, `video`, `draft`, `social`, `preview-archive`, `observe`                                 | **noun → verb/noun-as-verb mix**                             | `update`/`observe` are verbs; `video`/`draft`/`social` are nouns standing in for an implied verb; `preview-archive` is a dash compound |
| `admin mixtapes`    | `create`, `update`, `members`, `publish`, `delete`, `list`, `get`, `distribute`, `publish-youtube` | **noun → verb** mostly; `publish-youtube` is a dash compound |                                                                                                                                        |
| `admin submissions` | (bare) / `review`, `reject`, `approve`                                                             | **noun → verb**                                              | bare `submissions` lists                                                                                                               |
| `admin auth`        | `spotify`, `youtube`, `mixcloud`, `lastfm`                                                         | **noun → provider-noun**                                     | the verb ("authorize") is implied by the group                                                                                         |
| `admin backfill`    | `previews`, `lastfm`, `discogs`                                                                    | **noun → noun**                                              | the verb ("backfill") is implied by the group                                                                                          |

Flags are consistently `--kebab-case` (`--dry-run`, `--scheduled-for`, `--video-url`, `--footage-silent`). That part is already clean.

### 1.2 HTTP API (`apps/web/src/routes/api/v1/**`)

Every route is served canonically under `/api/v1/*`, with the bare `/api/*` path kept as a permanent back-compat alias (same handler object, not a redirect — see `apps/web/src/routes/api/-alias.ts`). REST verbs are the HTTP method; the path is the resource.

Public + private (`/me`) operations, with their OpenAPI `operationId`:

| Method + path                            | operationId                                               | Shape                                                        |
| ---------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------ |
| `GET /tracks`                            | `listTracks`                                              | verb+Noun, camelCase                                         |
| `GET /tracks/random`                     | `getRandomTrack`                                          | verb+Noun                                                    |
| `GET /tracks/{idOrLogId}`                | (not in spec)                                             |                                                              |
| `GET /search`                            | `searchTracks`                                            | verb+Noun                                                    |
| `POST /submissions`                      | `submitTrack`                                             | **operationId noun ≠ path noun** (`submissions` vs `Track`)  |
| `POST /newsletter`                       | `subscribeNewsletter`                                     | verb+Noun                                                    |
| `GET /me`                                | `getCurrentPrivateUser`                                   | the `Private` infix marks the cookie-auth tier               |
| `GET /me/csrf`                           | `getPrivateMutationToken`                                 | **operationId noun ≠ path noun** (`csrf` vs `MutationToken`) |
| `GET/PUT /me/galaxy-progress`            | `getPrivateGalaxyProgress` / `mergePrivateGalaxyProgress` | PUT verb is `merge`, not `update`                            |
| `GET/POST /me/saved-findings`            | `listPrivateSavedFindings` / `savePrivateFinding`         | **noun is `findings`, not `tracks`**                         |
| `DELETE /me/saved-findings/{trackId}`    | (not in spec)                                             | path param is `trackId`, resource is `findings`              |
| `GET /me/submissions`                    | `listPrivateSubmissions`                                  |                                                              |
| `POST /me/export`, `GET /me/export/{id}` | `exportPrivateAccountData`                                |                                                              |
| `POST /me/delete`                        | `deletePrivateAccount`                                    | **`POST` on a `/delete` path**, not `DELETE /me`             |
| `PATCH /me/profile`                      | (not in spec)                                             |                                                              |
| `GET /health`                            | `getHealth`                                               |                                                              |

Admin operations (cookie-or-bearer, **not in the public OpenAPI spec**), expressed as method + path:

| Operation                                           | Method + path                                                                                              |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Update a track (BPM/key/features/status/video/note) | `PATCH /admin/tracks/{trackId}`                                                                            |
| Upload a video bundle                               | `POST /admin/tracks/{trackId}/video` (+ `…/video/uploads`, `…/video/finalize`)                             |
| Show per-platform social status                     | `GET /admin/tracks/{trackId}/social`                                                                       |
| Update one platform's status                        | `PATCH /admin/tracks/{trackId}/social/{platform}`                                                          |
| Push a draft to a platform                          | `POST /admin/tracks/{trackId}/social/{platform}/draft`                                                     |
| Record an observation                               | `POST /admin/tracks/{trackId}/observe` (**verb segment on a REST path**)                                   |
| Archive a preview                                   | `POST /admin/tracks/{trackId}/preview-archive` (**dash compound verb segment**)                            |
| List/create mixtapes                                | `GET/POST /admin/mixtapes`                                                                                 |
| Update/delete a mixtape                             | `PATCH/DELETE /admin/mixtapes/{mixtapeId}`                                                                 |
| Publish a mixtape                                   | `POST /admin/mixtapes/{mixtapeId}/publish` (**verb segment**)                                              |
| Set mixtape members                                 | `POST /admin/mixtapes/{mixtapeId}/members`                                                                 |
| YouTube / Mixcloud distribution                     | `…/youtube/initiate`, `…/youtube/finalize`, `…/youtube/publish`, `…/mixcloud/finalize` (**verb segments**) |
| Enrich sweep                                        | `POST /admin/enrich-sweep` (**dash compound verb-noun**)                                                   |
| Backfill                                            | `POST /admin/backfill/lastfm`, `…/backfill/discogs`                                                        |

So the API is mostly clean REST (method = verb, path = resource), with a recurring exception: **action sub-resources** (`/observe`, `/publish`, `/draft`, `/preview-archive`, `/youtube/finalize`, `/enrich-sweep`) where a verb is pushed into the path because the operation isn't a plain CRUD on a resource. There is no convention for which verb-segments are allowed or how they're cased (`enrich-sweep` and `preview-archive` are kebab; `observe`, `publish`, `finalize` are single words).

### 1.3 MCP / WebMCP tools

`apps/web/src/lib/server/mcp.ts` (server) and `apps/web/src/lib/webmcp.ts` (browser) expose the **same five tool names**, and they match each other exactly — the one place cross-surface naming is already coherent:

| Tool name              | Title                       | API equivalent                             | CLI equivalent  |
| ---------------------- | --------------------------- | ------------------------------------------ | --------------- |
| `get_recent_tracks`    | Recent findings             | `listTracks`                               | `recent`        |
| `get_random_track`     | Random finding              | `getRandomTrack`                           | `random`        |
| `search_tracks`        | Search tracks               | `searchTracks`                             | (no public CLI) |
| `submit_track`         | Submit a track              | `submitTrack` (`POST /submissions`)        | `submit`        |
| `subscribe_newsletter` | Subscribe to the newsletter | `subscribeNewsletter` (`POST /newsletter`) | `subscribe`     |

Casing is `snake_case`. Note `get_recent_tracks` includes mixtapes in its result, so the name under-describes the payload.

### 1.4 SSH (`apps/ssh`)

Two naming surfaces: the **deep-link command argument** (`ssh rave.fluncle.com <arg>`) and the **menu items**.

Deep links (`parseBootCommand`): `latest`, `random`, or a bare Log ID coordinate (e.g. `004.7.2I`, `019.F.1A`). Lowercase, single words.

Menu item labels (`menuItems()`): `Enter the Galaxy`, `Latest bangers`, `Mixtape archive`, `Random banger`, `Submit a track`, `Subscribe`, `Install CLI`, `About`, `Quit`. Title Case, in-fiction nouns.

Note the deep-link `latest` maps to the CLI's `recent`, the API's `listTracks`, and the MCP's `get_recent_tracks` — **four names for one read.**

### 1.5 Admin board (user-facing verbs)

The web admin board (`apps/web/src/components/admin/*`, `apps/web/src/routes/admin/*`) labels actions in plain operator English, which is a different register again:

- Enrich: `Run enrichment` / `Retry enrichment` / `Re-run enrichment` / `Enrich`
- Tag: `Save placement` / `Save & next` / `Tag`
- Publish: `Post to {platform}` / `Re-post` / `Push draft to inbox` / `Re-push draft` / `Push` / `Mark live` / `Mark failed` / `Drafted` / `Live`
- Note: `Save note` / `Save & next`
- Mixtape: `Add to a mixtape` / `New draft mixtape` / `New mixtape draft` / `Discard draft` / `Make YouTube public`

The same publish action is `Push draft to inbox` (board) / `admin track draft` (CLI) / `POST …/social/{platform}/draft` (API). The same enrich action is `Run enrichment` (board) / `admin enrich-sweep` (CLI) / `POST /admin/enrich-sweep` (API). The board verbs are fine as voice (they're crew-facing copy), but they're not derivable from the CLI/API name and vice versa.

## 2. The headline inconsistencies

1. **One operation, four-plus names.** "List the latest findings" is `recent` (CLI) / `latest` (SSH) / `listTracks` (API) / `get_recent_tracks` (MCP). No rule maps one to the others, so an agent author or a new contributor has to learn each surface's name independently.
2. **CLI group pluralization is arbitrary.** `mixtapes`, `submissions` (plural) vs `track`, `auth`, `backfill` (singular). The public `track get` group is singular while the public `mixtapes` group is plural.
3. **CLI verb/noun ordering is mixed.** `track get`, `mixtapes publish`, `submissions approve` are **noun → verb** (REST-ish). But `add`, `submit`, `subscribe`, `open` are bare verbs at the root, and `queue`, `vehicles`, `previews` are bare nouns that imply a verb. `video`, `draft`, `social` are nouns standing in for an implied verb under `admin track`.
4. **Dash-compound ad-hoc names.** `enrich-queue`, `enrich-sweep`, `preview-archive`, `publish-youtube` (CLI) and `enrich-sweep`, `preview-archive` (API path segments) coin compound names where a `group verb` or `verb noun` shape would do. The `auth-lastfm.ts` / `admin-tracks.ts` _files_ use dashes while their _commands_ are nested (`auth lastfm`, the `queue` family) — file naming and command naming disagree.
5. **operationId noun ≠ path noun.** `POST /submissions` → `submitTrack`; `GET /me/csrf` → `getPrivateMutationToken`. The documented operation name doesn't match the URL a reader sees.
6. **Same entity, different noun per surface.** A certified track is `track`/`tracks` in the CLI, API, and MCP names, but `finding`/`findings`/`banger` in user-facing copy — and `/me/saved-findings` puts `findings` into a machine path while its param is `trackId`. The two vocabularies (machine noun `track`, voice noun `finding`) are both legitimate (see §5), but the boundary between them is currently drawn by accident, not by rule.
7. **Verb-on-REST-path with no policy.** `/observe`, `/publish`, `/draft`, `/preview-archive`, `/youtube/finalize`, `/enrich-sweep`, `/me/delete` all push a verb into the path. Sometimes that's right (non-CRUD actions); but there's no stated rule for when a verb-segment is allowed or how it's cased, and `POST /me/delete` exists alongside `DELETE …` elsewhere.
8. **Coverage gaps in the public spec.** `/mixtapes`, `/stories`, `GET /tracks/{idOrLogId}`, `DELETE /me/saved-findings/{trackId}`, and `PATCH /me/profile` are live routes with **no OpenAPI `operationId`**, so an agent reading the spec can't name or discover them.

## 3. Candidate conventions

All three share the same spine: **one canonical operation name per operation**, written `verb_noun` in a registry, from which each surface's name is _derived by a fixed rule_. They differ in how aggressively they restructure the CLI and how they handle the machine-noun/voice-noun split.

The canonical verb set is small and closed: `list`, `get`, `search`, `submit`, `subscribe`, `create`, `update`, `delete`, `publish`, plus a named-action set for non-CRUD operations (`enrich`, `observe`, `render`, `draft`, `distribute`, `backfill`, `authorize`). The canonical noun is the **machine noun** (`track`, `mixtape`, `submission`, `newsletter`, `preview`, …), singular.

### Convention A — "REST everywhere" (noun → verb, plural resources)

The CLI mirrors the API's resource model: every command is `noun verb`, resources are plural, the HTTP method/path is the source of truth, and the MCP/CLI names are mechanically derived from `operationId`.

Mapping rule: canonical op `list_tracks` ⇒ API `GET /tracks` + `listTracks`; MCP `list_tracks`; CLI `tracks list`; SSH deep-link `tracks` (or its in-fiction alias kept as an alias).

| Operation             | Today (CLI / API / MCP / SSH)                                   | Convention A                                                                                                      |
| --------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| list recent           | `recent` / `listTracks` / `get_recent_tracks` / `latest`        | CLI `tracks list`; API `GET /tracks` `listTracks`; MCP `list_tracks`; SSH `tracks` (alias `latest`)               |
| random                | `random` / `getRandomTrack` / `get_random_track` / `random`     | CLI `tracks random`; `getRandomTrack`; `get_random_track`; SSH `random`                                           |
| get one               | `track get` / — / — / `<coord>`                                 | CLI `tracks get`; API `GET /tracks/{id}` `getTrack`; MCP `get_track`                                              |
| submit                | `submit` / `submitTrack` (`POST /submissions`) / `submit_track` | CLI `tracks submit`; path becomes `POST /tracks/submissions` or op renamed `createSubmission`; MCP `submit_track` |
| admin publish a track | `admin add` / —                                                 | CLI `admin tracks publish`                                                                                        |
| enrich sweep          | `admin enrich-sweep` / `POST /admin/enrich-sweep`               | CLI `admin tracks enrich --all`; API `POST /admin/tracks/enrich`                                                  |
| push draft            | `admin track draft` / `…/social/{platform}/draft`               | CLI `admin tracks draft`; API unchanged                                                                           |
| mixtape publish       | `admin mixtapes publish` / `…/publish`                          | unchanged (already conformant)                                                                                    |

Tradeoffs. **+** One mental model (REST) for CLI, API, MCP. **+** Mechanical `operationId → cli/mcp` derivation; the registry is the only thing to maintain. **+** Plays well with the existing `/api` REST design — least churn on the server. **−** Heavy CLI churn: every root verb (`recent`, `random`, `submit`, `subscribe`, `open`) becomes `noun verb`, which reads stiffer and breaks muscle memory and docs/screenshots. **−** Fights the SSH/voice register, where `latest` and `Random banger` are the point; you'd keep those as aliases, reintroducing a second name.

### Convention B — "Verb-first CLI, REST API, derived MCP" (recommended)

Keep the CLI's verb-first ergonomics for the _public_ surface (it reads like speech: `fluncle submit …`, `fluncle random`), make the _admin_ CLI consistently `group noun-verb`, keep the API as REST, and define the **derivation rule** so MCP and `operationId`s are generated, not hand-named. The canonical registry is `verb_noun`; each surface has a fixed projection:

- **MCP/WebMCP tool** = `verb_noun` (snake_case), verbatim from the registry. (Already true for the 5 public tools.)
- **OpenAPI `operationId`** = `verbNoun` (camelCase) — the same words, re-cased. So `list_tracks` ⇒ `listTracks`, and `submit_track` ⇒ path `POST /submissions` keeps `operationId: submitTrack` (the op name, not the path noun, is canonical — and the mismatch is _documented as intentional_ because the resource and the action noun legitimately differ).
- **API path** = REST resource; method = verb. Non-CRUD actions are a **named action sub-resource**: `POST /{resource}/{id}/{action}` where `{action}` is a single lowercase word from the closed action set (`observe`, `publish`, `draft`, `distribute`, `finalize`). Multi-word actions are avoided — `enrich-sweep` ⇒ `POST /admin/tracks/enrich`, `preview-archive` ⇒ `POST /admin/tracks/{id}/preview`.
- **Public CLI** = bare verb at root (`submit`, `subscribe`, `random`, `recent`, `open`), because that's the spoken register and the existing contract. Each maps to a registry op via an explicit alias note in the registry (`recent → list_tracks`, `submit → submit_track`).
- **Admin CLI** = `group noun-verb`, plural groups, e.g. `admin tracks update`, `admin tracks enrich`, `admin tracks draft`, `admin mixtapes publish`, `admin submissions approve`. The `track` group becomes `tracks`; `enrich-queue`/`enrich-sweep` become `tracks enrich-queue` show + `tracks enrich --all`; `preview-archive` becomes `tracks preview`.
- **SSH** = keep in-fiction labels and deep links (`latest`, `Random banger`), but each is registered as an explicit alias of its canonical op so the mapping is written down, not implicit.

| Operation       | Today                                                    | Convention B                                                                                             |
| --------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| list recent     | `recent` / `listTracks` / `get_recent_tracks` / `latest` | CLI `recent` (root, kept); MCP **`list_tracks`** (rename); `listTracks`; SSH `latest` (registered alias) |
| random          | `random` / `getRandomTrack` / `get_random_track`         | unchanged (already conformant under the rule)                                                            |
| get one         | `track get` / (gap) / (gap)                              | CLI `track get` (or `tracks get`); add API `GET /tracks/{id}` `getTrack` + MCP `get_track`               |
| submit          | `submit` / `submitTrack` / `submit_track`                | unchanged; mismatch documented as intentional                                                            |
| admin publish   | `admin add`                                              | CLI `admin tracks publish` (rename `add`); API `POST /admin/tracks` `publishTrack`                       |
| enrich sweep    | `admin enrich-sweep` / `POST /admin/enrich-sweep`        | CLI `admin tracks enrich --all`; API `POST /admin/tracks/enrich`                                         |
| preview archive | `admin track preview-archive` / `…/preview-archive`      | CLI `admin tracks preview`; API `…/{id}/preview`                                                         |
| observe         | `admin track observe` / `…/observe`                      | unchanged (conformant)                                                                                   |
| auth lastfm     | `admin auth lastfm`                                      | unchanged (conformant)                                                                                   |

Tradeoffs. **+** Keeps the public CLI's spoken voice (`fluncle random`, `fluncle submit`) — no churn on the surface users touch most. **+** MCP↔API↔registry derivation is mechanical for everything machine-facing. **+** Only the admin CLI and a handful of dash-compounds churn, which are operator-only and low-blast-radius. **+** Names the machine-noun/voice-noun boundary explicitly (§5) instead of leaving it accidental. **−** Two CLI registers (verb-first public, noun-verb admin) — a learnable seam, but a seam. **−** Renaming `get_recent_tracks → list_tracks` and `admin add → admin tracks publish` are breaking changes for existing agents/scripts; needs aliases + a deprecation window.

### Convention C — "Two vocabularies, one bridge" (voice-forward)

Lean into Fluncle's voice: the _noun_ is `finding` (not `track`) on every human-facing surface and in the public API/MCP, and `track` is retired from public names except where Spotify forces it. The registry maps a voice op (`log_finding`, `recover_finding`) to each surface.

| Operation     | Convention C                                                                        |
| ------------- | ----------------------------------------------------------------------------------- |
| list recent   | CLI `recent`; MCP `list_findings`; API `GET /findings` `listFindings`; SSH `latest` |
| random        | MCP `get_random_finding`; API `GET /findings/random`                                |
| submit        | MCP `submit_finding`; API `POST /findings/submissions`                              |
| admin publish | CLI `admin findings log`; API `POST /admin/findings` `logFinding`                   |

Tradeoffs. **+** Maximally on-brand; one noun (`finding`) everywhere, matching the voice canon's primary family. **+** Removes the `track` vs `finding` split by deleting one side. **−** Largest blast radius: every public path, every `operationId`, every MCP tool, `saved-findings`'s sibling `tracks`, and the `/tracks/{idOrLogId}` lookups all rename. **−** Loses the precise machine meaning of `track` (a thing with a Spotify id, BPM, key — not every `finding` semantic context wants the brand noun). **−** Risks exactly what the voice canon's Narrator rule warns against — letting brand vocabulary into machine-facing strings that have "no crew in the room."

## 4. Recommendation

**Convention B.** It fixes the real defects — arbitrary CLI pluralization, dash-compound coinage, undocumented routes, and the missing one-name-per-operation rule — while protecting the two things that are already good: the spoken public CLI verbs and the existing five-tool MCP parity. It restructures only operator-facing surfaces (admin CLI, a few API action segments) where churn is cheap, and it keeps `track` as the precise machine noun while _naming_ the voice-noun boundary rather than erasing one side (Convention C) or flattening the voice into REST (Convention A).

Concretely, ratifying B means landing, in order, lowest-risk first:

1. **Write the registry.** A single `verb_noun` op list (in this doc or a small JSON next to the OpenAPI spec) with each surface's projection and aliases. Source of truth.
2. **Close the spec gaps** (no rename): add `operationId`s for `GET /tracks/{idOrLogId}`, `DELETE /me/saved-findings/{trackId}`, `PATCH /me/profile`, and document `/mixtapes` + `/stories`.
3. **Normalize the admin CLI** to `group noun-verb`, plural groups, behind aliases (`track → tracks`, `add → tracks publish`, `enrich-sweep → tracks enrich --all`, `preview-archive → tracks preview`). Keep old names as hidden aliases for one release.
4. **Rename the under-describing MCP tool** `get_recent_tracks → list_tracks` (it returns mixtapes too), keeping the old name as an alias in `tools/list` for a deprecation window; mirror in `webmcp.ts`.
5. **Collapse multi-word API action segments** (`enrich-sweep`, `preview-archive`) to single-word actions on a resource path, keeping the old paths as aliases via the existing `-alias.ts` plumbing.

None of this is in scope here — this doc is the proposal. Each step is its own change with its own tests and its own voice pass.

## 5. Voice boundary

The voice canon (`VOICE.md`, `packages/skills/copywriting-fluncle/references/voice.md`) governs **human, crew-facing copy**. Naming consistency must not overwrite it. The boundary, stated as a rule:

- **Machine-facing names** (CLI command/flag identifiers, API paths, `operationId`s, MCP tool names) use the plain machine noun `track` and a closed verb set. These have "no crew in the room" — the Narrator rule says keep them honestly-plain. This is where the convention applies in full.
- **Human-facing copy** on any surface (CLI help text and output prose, SSH menu labels and detail screens, admin board action labels, empty states, confirmations) uses the voice nouns — `finding`, `banger`, `recovered`, `certify`, `Fluncle's Findings` — under the Garnish Rule (Earth verbs, cosmic trim; the cosmos modifies, never replaces the verb in functional controls). The convention does **not** force these toward the machine noun.
- The seam runs **per token, not per surface.** The CLI has both: the command identifier `recent` is machine-facing (lives in the registry), while its description "The latest bangers, newest first" is voice. The SSH deep-link `latest` is a machine token (a registered alias of `list_tracks`); the menu label `Latest bangers` is voice. Keeping them in the registry as aliases is what makes the mapping explicit instead of accidental.

So the convention's job at the boundary is narrow: make every _machine_ name derivable from one registry, and record each _voice_ alias (`recent`, `latest`, `Random banger`) against its canonical op so nobody has to reverse-engineer which screen calls which endpoint.

## 6. How to name a new feature (checklist)

When you add a public operation — a CLI command, an API route, an MCP tool, an SSH deep link, or an admin action — name it once, then derive:

1. **Pick the canonical op:** `verb_noun`, where `verb` is in the closed set (`list`, `get`, `search`, `submit`, `subscribe`, `create`, `update`, `delete`, `publish`, or a named non-CRUD action like `enrich`/`observe`/`draft`/`distribute`/`finalize`) and `noun` is the singular machine noun (`track`, `mixtape`, `submission`, `newsletter`, `preview`). Add it to the registry.
2. **Derive the names, don't invent them:**
   - MCP/WebMCP tool = the op verbatim, `snake_case` (`enrich_track`). Mirror server `mcp.ts` and browser `webmcp.ts` together.
   - OpenAPI `operationId` = the op, `camelCase` (`enrichTrack`).
   - API = REST: `{METHOD} /{resource}` for CRUD; `{POST} /{resource}/{id}/{action}` with a **single-word** action for non-CRUD. No dash-compound path segments.
   - Public CLI = bare verb at root if it's a spoken public action (`submit`); else `group noun-verb` under `admin` with **plural** groups (`admin tracks enrich`).
   - SSH deep link / menu label = whatever the voice wants — but **register it as an alias** of the canonical op.
3. **Check pluralization:** CLI groups are plural (`tracks`, `mixtapes`, `submissions`). Singular only for a true singleton (`me`, `auth`).
4. **No new dash-compound command/op names.** If you reach for `foo-bar`, it's usually `group` + `foo bar` (CLI) or a resource + action (API). Reserve kebab-case for flags and multi-word path _resources_ that are genuinely one noun.
5. **Keep the machine noun out of voice copy and the voice noun out of machine names** (§5). The identifier is `track`; the help text and labels can say `finding`/`banger`.
6. **Document it the moment it ships:** every public API route gets an `operationId` and lands in the OpenAPI spec; every MCP tool gets a `title`; every CLI command gets a one-line voice description. A route with no `operationId` is invisible to agents — treat that as a bug.
7. **Run a voice pass** (`copywriting-fluncle`) on the human-facing strings, separately from the machine name.
