# RFC: Mixtape plumbing — stand up the internal `mixtape` object, locally

**Status:** Final (research over 4 threads → /taste pass → 4-role adversarial panel synthesized, 2026-06-18) — completeness standard applied.
**Decisions:** all scoping decisions LOCKED 2026-06-18 — full **A–D delivery in one PR**, built in A→D order, merge-gated on the first real mixtape being ready to add (see Decisions section).
**For:** a fresh build session (or a small team of agents) implementing against the separate dev Turso DB, pre-recording.
**Canon/authority:** `docs/fluncle-mixtapes-runbook.md` (the design), `PRODUCT.md` / `DESIGN.md` / `VOICE.md` (canon), and the codebase. Planning, not spec; deviations from the runbook are flagged with rationale.

> Process note: divergent research (persistence+minting, admin write, read fan-out+resolver, machine-awareness+UI), a /taste pass, and a 4-role adversarial panel (staff engineer, data/DBA, design/brand, product/scope). The panel found real, load-bearing errors in the draft — they are corrected below and their live verifications are in the appendix. The biggest correction reshaped the delivery: the draft over-scoped external-facing surfaces for a zero-instance, unpublished object, and proposed two architectural shortcuts (widening the shared resolver; a blind union in `listTracks`) that would have broken ~12 existing surfaces.

## The standard (definition of done)

Boil the ocean on the **plumbing** — every increment ships complete, with tests and docs, no thread left dangling. The completeness standard forbids _cutting_ achievable work; it explicitly permits _sequencing_ a complete delivery into ordered increments, and sanctions deferring genuine **external-dependency chains** (work whose only consumer can't exist until a recorded set is published to the public domain). This RFC delivers all four increments; it sequences them by _who can verify each locally_, so the build stays honest about what "done" means at each step. Tests + docs are acceptance criteria, not follow-ups. Dangling threads this build ties off: the client `LOG_ID_PATTERN` that today rejects `F` (a latent 404), the `Found · N` count's correctness, and track-deletion orphaning of mixtape members.

## 0. Summary / the reframe

- **The unifying simplification (survives review): the literal `F` is the only new primitive.** A finding's Log ID always carries a **digit** in the middle (orbit) slot; a mixtape always carries **`F`**. The two coordinate namespaces are **disjoint by construction** — verified: the client `LOG_ID_PATTERN = /^\d{3,4}\.\d\.\d[A-Z]$/` genuinely rejects `019.F.1A`, and a finding's middle slot is `hash % 10` (always a digit). So the mint is a separate counter path, resolution branches on a pure string test, and (critically) the namespaces never collide in any shared id space.
- **The reshape the panel forced (kept as build order, not a now-vs-later cut): order the work so each step is verifiable as it lands, and gate the merge on real content.** All four increments ship in **one PR**, built in A→D order; the PR merges once the first real mixtape is ready to add, so the feature goes live with content, not as empty scaffolding. The panel's insight survives as **sequencing**: A (the operator create→view spine) is the foundation everything hangs off; the external-facing fan-out (the `/mixtapes` index, JSON-LD/RSS/sitemap/llms.txt) is lower-risk and lands after the spine, in the same PR.
- **Decomposition by who-can-verify-locally (truly-coupled vs falsely-coupled):**
  - **Increment A — the spine (build first):** persist + mint + admin-create/edit + the **branching resolver** + the `/log/<id>` mixtape page. The operator can create a mixtape, mint `019.F.1A`, view it at `/log/019.F.1A`, resolve it via `/api/tracks/019.F.1A` and `fluncle track get`, and edit it. Complete, locally, no external dependency.
  - **Increment B — quiet feed inclusion (isolated):** the opt-in `listTracks` union + the checkpoint feed row. The riskiest single change; off the MVP critical path; touches the one high-traffic live surface, so it ships and is tested alone.
  - **Increment C — dedicated front doors:** `/mixtapes` web index, `/api/mixtapes`, `fluncle mixtapes`, MCP. Worth a front door once there's an archive to front; cheap, low-risk, post-MVP.
  - **Increment D — machine-awareness (built in this PR):** schema.org `DJMixAlbum`, RSS `<category>`, sitemap, llms.txt. Built and unit-tested here (markup shape); its real audience — crawlers of the public domain — sees it the moment the PR merges with the first mixtape live.
- **Two architectural corrections from the panel (load-bearing):**
  - **Do NOT widen `getTrackByIdOrLogId`.** It has **8 production callers** (`api/og.$logId.ts`, `api/preview.$idOrLogId.ts`, and 5 admin video/social/preview-archive routes) that read track-only fields. Add a **separate** `getMixtapeByLogId` and a thin `resolveLogPageTarget` that branches; the universal-resolver surfaces call the brancher, the track-only callers keep the narrow function. "One chokepoint" was the wrong model — it's one _resolution intent_, not one shared return type.
  - **The union must be opt-in, not blind.** `listTracks` is called by the **admin board, the admin tag queue, the Stories feed (`hasVideo`), and the newsletter discovery window (`since`/`until`)** — a mixtape must appear in **none** of them. Gate inclusion behind `listTracks({ includeMixtapes: true })`, default **off**, set only by the public feed, the unwindowed `/api/tracks`, `recent`, and the public MCP/llms reads.
- **Stack reality (verified):** raw libSQL SQL strings at runtime (Drizzle for schema+migrations only), ISO-string dates in `text`, `randomUUID()` text PKs, **no FK constraints**, **no zod** (hand-rolled validation), and a **separate remote dev Turso DB** in `apps/web/.dev.vars`. The tree is currently green (`bun run --cwd apps/web typecheck` clean) — preserve that.

## 1. Context & goals

**Why now:** the design is locked (runbook + canon). Building the internal object before recording lets Maurice assemble a mixtape from existing findings against the dev DB and watch it resolve, validating the spine while publishing stays deferred.

**In the PR (Increments A–D), verifiable locally:** persist a mixtape; mint `XXX.F.ZZ`; create/edit it from findings via the admin API + a minimal UI; resolve it everywhere it should be one identity; surface it quietly in the feed and via a `/mixtapes` front door across web/API/CLI/MCP; and emit the machine-awareness markup (schema.org/RSS/sitemap/llms.txt), unit-tested for shape. The whole thing runs against the dev DB; the machine layer's real audience (crawlers) sees it when the PR merges with the first mixtape live on production.

**Still deferred (genuinely external, honest scoping):** the actual Mixcloud/YouTube/SoundCloud uploads, clip cutting, the MusicBrainz/Wikidata facts, the announce posts (Telegram/newsletter/home), and the per-mixtape OG image. Each needs a recorded/uploaded set or an external account. The object is built so each slots in with **no rework**: nullable URL columns (set later via the admin edit), an embed _placeholder_, an OG _fallback_. Whether AI engines then cite it is an outcome outside our control (monitor, don't gate).

---

## Increment A — MVP: the spine (persist · mint · admin · resolve · view)

The foundation — build it first; everything else in the PR hangs off it. Everything here is verifiable by the operator the moment it lands.

### A1. Persistence + minting

**Schema** (`apps/web/src/db/schema.ts`), matching house conventions exactly:

- `mixtapes` — `id` (`text` PK, `randomUUID()`), `status` (**`text notNull default 'draft'` — `draft` | `published`; the spine-visibility gate; mirrors `tracks.enrichmentStatus`**), `logId` (`text .unique()` — **null until publish**), `sequenceNumber` (`integer .unique()` — **null until publish; assigned `max+1` at publish, so published "No. N" stays contiguous and abandoned drafts burn no numbers**), `title` (`text notNull`), `coverImageUrl` (`text` — name it to match the DTO field; mirror `tracks.album_image_url`→`albumImageUrl`), `durationMs` (`integer` — **Decision D5: ms, not the runbook's `durationSec`, to reuse `formatDuration`**), `note`, `mixcloudUrl`/`youtubeUrl`/`soundcloudUrl` (nullable; **≥1 required to publish**), **`addedAt` (`text` ISO — the feed sort/cursor key; null until publish, stamped at publish; see B and DBA-P0-1)**, `recordedAt` (`text` ISO — the set's date; the coordinate's sector derives from this), `publishedAt` (`text` ISO, null until publish), `createdAt` (`text notNull` ISO), `updatedAt` (`text notNull` ISO — matching `social_posts`).
- `mixtape_tracks` — ordered satellite (mirrors `social_posts`' bare-FK pattern): `mixtapeId` (`text notNull`), `trackId` (`text notNull`), `position` (`integer notNull`), with `uniqueIndex(mixtapeId, position)`, **`uniqueIndex(mixtapeId, trackId)` (forbid the same finding twice in one mixtape — DBA-P1-2)**, and `index(mixtapeId)`. No `REFERENCES` (the repo has none).
- **Member storage is a table, not JSON (Decision D1 — settled by the runbook + the reverse-query need):** the tracklist is ordered and reverse-queried (each member → `/log/<id>` page + the JSON-LD ItemList). JSON-in-TEXT here is reserved for never-queried value objects (`artists_json`, `features_json`).

**Migration:** edit `schema.ts` → `bun run --cwd apps/web db:generate` (writes `0014_*.sql` + `meta/0014_snapshot.json` + the `_journal.json` entry — commit all three with the schema edit; never hand-write SQL) → `bun run --cwd apps/web db:migrate` against the dev DB in `.dev.vars`. Two additive `CREATE TABLE`s, no SQLite rebuild hazard (verified against the `social_posts` precedent in `0010`). **Rollback (state it — there are no down-migrations in this repo):** manual `DROP TABLE mixtape_tracks; DROP TABLE mixtapes;` against the dev DB.

**Mint** (`apps/web/src/lib/server/mixtape-log-id.ts`, new):

- Export `sector` (currently module-private) from `apps/web/src/lib/server/log-id.ts`; reuse it.
- `mixtapeTail(n)`: digit `floor((n-1)/6)+1` (1–9), letter `"ABCDEF"[(n-1)%6]`; throws outside 1..54. `mixtapeLogId(date, n) = \`${sector(date)}.F.${mixtapeTail(n)}\``.
- **The mint runs at PUBLISH, atomically via `db.batch` (not at create).** The draft row already exists, so publishing reads `select coalesce(max(sequence_number),0)+1 from mixtapes` and, in one **`db.batch([...], "write")`** transaction, `UPDATE`s the row to set `sequence_number`, `log_id` (= `mixtapeLogId(recordedAt, n)`), `status='published'`, `published_at`, and `added_at`. The batch serializes read+update on the single remote connection and removes the race (no `SELECT … FOR UPDATE` on `@libsql/client/web`; the repo's first transaction — call it out), sidestepping the cap-vs-conflict ambiguity at N=54. The `sequence_number`/`log_id` UNIQUE constraints are the backstop. (Corrects the draft's false "mirrors `resolveLogId`" claim — that's a non-atomic content-hash path with no conflict-catch.)
- **Fully separate from `resolveLogId`** — no shared collision space (the `F`).

**Close the latent 404 (Unit-spanning, owned here):** add `isMixtapeLogId` (`/^\d{3,4}\.F\.\d[A-F]$/`) beside `isLogId` in `apps/web/src/lib/log-id.ts`, and widen `isLogPageParam` (`apps/web/src/lib/log-page-param.ts`, a thin wrapper over `isLogId`) to accept it — else `/log/019.F.1A` 404s at `beforeLoad`.

### A2. Read layer: the DTO + the branching resolver (NOT a widened chokepoint)

- **DTO:** add an explicit `type: "finding" | "mixtape"` discriminator to both objects (don't shape-sniff). `MixtapeDTO = { type:"mixtape"; logId; title; artists:["Fluncle"]; addedAt; durationMs; members: TrackListItem[]; note?; externalUrls:{ mixcloud?; youtube?; soundcloud? }; coverImageUrl?; recordedAt?; updatedAt? }`. (Decision D2: **members are existing findings** — each carries a real `logId` for the breadcrumb. Non-finding members deferred.)
- **`getMixtapeByLogId(logId)`** (new, in a new `apps/web/src/lib/server/mixtapes.ts`): the mixtape read + its ordered members (each mapped via the existing `toTrackListItem`). **Render must tolerate a missing member** (a track deleted out from under it) — skip it, don't crash the list or the ItemList (DBA-P1-2).
- **`resolveLogPageTarget(idOrLogId)`** (new thin brancher): `if (isMixtapeLogId(idOrLogId)) return { kind:"mixtape", mixtape: await getMixtapeByLogId(...) }` else `{ kind:"track", track: await getTrackByIdOrLogId(...) }`. **`getTrackByIdOrLogId` stays narrow (`TrackListItem | undefined`) — do NOT widen it** (it has 8 track-only callers: `api/og.$logId.ts`, `api/preview.$idOrLogId.ts`, and the admin `*.video*`/`*.social*`/`*.preview-archive` routes, all of which read `videoUrl`/`previewUrl`/`vibeX` etc.). Only the three _universal-resolver_ surfaces call the brancher: the `/log` loader, `/api/tracks/<idOrLogId>`, and CLI `track get`.
- **Wiring the three resolver surfaces:**
  - `log.$logId.tsx`: `LogPageData` gains a `{ status:"found-mixtape"; mixtape }` variant; the loader calls the brancher.
  - `routes/api/tracks.$idOrLogId.ts`: returns the mixtape DTO when the coordinate is `F`-marked.
  - CLI `track get`: widen `TrackGetResult` to a discriminated union AND **specify the `runTrackGet` mixtape branch** in the formatter (`cli.ts`) — a mixtape has no `trackId`/`enrichmentStatus`, so the finding formatter would print `undefined` (staff-eng P1-6).

- **Draft visibility (the spine gate):** every PUBLIC read path filters `status='published'` — the `/log` + `/api/tracks` resolver, the feed union (B), the front doors (C), and the machine layer (D). A draft has no `logId` yet and is invisible publicly (the resolver 404s an unknown/draft coordinate). Admin reads (`/admin/mixtapes`, the admin API) show all statuses; the operator previews a draft's `/log` composition inside the admin UI from the draft data.

### A3. Admin write path

- **Auth (no new mechanism):** every route opens with `requireAdmin(request)` (`env.ts`); every admin server function re-checks `isAdminRequest()` (the RPC is directly callable). The two-carrier identity (CLI Bearer / signed cookie) + `ADMIN_ALLOWED_EMAILS` allow-list already cover it.
- **Module** `apps/web/src/lib/server/mixtapes.ts`: `createMixtape`, `updateMixtape`, `setMixtapeMembers`. Validation hand-rolled in the `submissions.ts` style (`requireText`, `optionalText(value,max)`, caps) — **no zod**; lift the shared helpers into `lib/server/validate.ts`.
- **Routes** (each `requireAdmin`): `POST /api/admin/mixtapes` (create a **draft** — insert `status='draft'`, **no mint, no Log ID yet**; members optional) · `PATCH /api/admin/mixtapes/:id` (allow-list metadata incl. the external URLs, à la `updateTrack`) · `PUT /api/admin/mixtapes/:id/members` (replace-whole-list reorder; validate non-empty, members resolvable by `logId` (operator-visible) or `trackId`, no dupes) · **`POST /api/admin/mixtapes/:id/publish` (the spine gate)** — validate **≥1 of mixcloud/youtube/soundcloud is a non-empty, well-formed URL (presence + shape only, NO reachability check — a throwaway link works for local dev)**, else 409; then run A1's publish mint (`db.batch`: `sequence_number`, `log_id`, `status='published'`, `published_at`, `added_at`). Optional `POST …/unpublish` (back to draft) for symmetry. Once published, `logId`/`sequenceNumber` are immutable → 409.
- **Track-deletion (DBA-P1-2):** find any track-delete path; if one exists, extend it to block deleting a track that's a mixtape member, or cascade-clean `mixtape_tracks`. If none exists, note that and rely on the tolerant render.
- **UI** — a separate `apps/web/src/routes/admin/mixtapes.tsx` (NOT the board — a mixtape has no Enrich/Tag/YouTube/TikTok stages; correct IA, panel-endorsed). Wrap in `AdminShell`, add a link to `admin-nav.tsx`. Reuse `Dialog`/`Input`/`Textarea`/`Label`/`Button`/`Badge`/`Card`/`ScrollArea`; writes via plain `fetch()` + optimistic `queryClient.setQueryData` (copy `saveNote`). A **draft badge** and a **Publish** button (disabled until ≥1 external link), plus a live preview of the `/log` checkpoint composition rendered from the draft data (the public `/log` 404s a draft). **Member picker (Decision D7, zero-dep):** a searchable list of findings with Add buttons, selected members as an ordered list with up/down buttons. **Harden it (design-P2-8):** the client filter must search the _whole archive_, not a single fetched page — either fetch enough findings to cover the real archive or back the search server-side; a half-loaded picker can't find a track past the page boundary.

### A4. The `/log/<id>` mixtape page — compose a checkpoint, not a finding-with-fields-swapped

Reuse the `.log-plate` grammar (One Pane — no new glass), but **re-compose the contents so it reads as the object the canon describes** ("to outsiders just a mixtape, to insiders a glimpse into Fluncle's subconscious"). The draft's title→prose→fields→tracklist order is identical to a finding and carries none of the double-read (design-P1-5). Instead:

- **Checkpoint masthead marker** — the nameplate signals the kind (e.g. a quiet "Mixtape No. 1" / checkpoint marker), not just the findings nameplate; the `019.F.1A` coordinate + `fluncle://` line stay.
- **The dream note is the lead** (`log-definition-prose` register) — on a mixtape the note IS the insider read; it's note-forward, not a sub-title afterthought.
- **The member tracklist is the centerpiece** — the breadcrumb made visible (the long-term memory made of short-term ones): each member's `Artist — Title` + its coordinate, every row a `<Link to="/log/$logId">`. The on-page mirror of D's JSON-LD ItemList.
- **A compact `Recorded / Runtime / N findings` field row** (not the hero) — `formatDuration(durationMs)`; **verify it renders "58 min" at album length, not "58:00"** (DESIGN's canon example is "12 findings · 58 min"; design-P2-7).
- **Embed slot = the existing `empty-scanlines` grammar**, not a bordered empty media box (which reads as broken) — a scanlined "audio lands at publish" slot until an external URL exists (design-P2-6).
- Extend `log-decode` to mention the `F` marker.
- **Voice:** every new string here (masthead marker, embed copy, decode line) goes through the `copywriting-fluncle` skill (design-P2-7).

### A — Acceptance criteria

- Migration `0014_*` + snapshot + journal committed together; applies clean to the dev DB; both tables exist with all three unique indexes.
- Mint unit tests: `mixtapeTail` (1→`1A`, 6→`1F`, 7→`2A`, 54→`9F`, 55 throws); first mint = `019.F.1A`; the `db.batch` mint is atomic (a test that two sequential mints get 1A then 1B).
- `isMixtapeLogId` accepts `019.F.1A`/rejects findings; `isLogPageParam` accepts both; a test proving `/log/019.F.1A` no longer 404s at `beforeLoad`.
- `getTrackByIdOrLogId` signature is **unchanged** (a test/grep that none of its 8 callers broke); the brancher returns the mixtape DTO for an `F` coordinate.
- Operator can, against the dev DB behind auth (401 without): create a mixtape from ≥2 findings as a **draft** — hidden from every public surface (feed, `/mixtapes`, and the public resolver 404s it) → add ≥1 external link → **publish** (409 without a link) → it mints `019.F.1A` and goes live: `/log/019.F.1A` renders the checkpoint composition with working member `/log` links, and `/api/tracks/019.F.1A` + `fluncle track get 019.F.1A` resolve it. Edit metadata + reorder members updates it; the draft previews inside admin; a missing member (deleted track) is skipped, not a crash.
- `bun run --cwd apps/web typecheck` + `build` green; new strings voice-checked.

---

## Increment B — quiet feed inclusion (isolated, opt-in)

Ships after A, alone, because it touches the high-traffic live feed and is the riskiest single change.

- **Opt-in union in `listTracks` (corrects the draft's blind union).** Add `listTracks({ includeMixtapes?: boolean })`, default **off**. Only the public feed (`routes/index.tsx`), the unwindowed `/api/tracks`, CLI `recent`, and the public MCP/llms reads pass `true`. The admin board, tag queue, Stories feed (`hasVideo`), and newsletter window (`since`/`until`) stay findings-only — verified caller list in the appendix. When on: `UNION ALL` over `tracks` + (`mixtapes` **where `status='published'`**), the **mixtape arm aliases `added_at` AS the sort key and `log_id` AS `track_id`** (the cursor's id slot), null-padding all disjoint columns **including the two `social_posts` correlated-subquery slots** (those live only in the `tracks` arm — they can't reference `tracks.track_id` across the UNION). Map by a `kind`-dispatched mapper to `FeedItem = TrackListItem | MixtapeDTO`.
- **Pagination is exact (verified) because the id space is disjoint.** `(added_at, id)` is a total order across the union — a mixtape `log_id` (`019.F.1A`) and a base-62 `track_id` never coincide — so `decodeTrackCursor` round-trips (it only asserts `typeof trackId === "string"`) and no row is skipped/duplicated, **provided `ORDER BY` and the cursor comparator use the identical aliased expression.** Residual: on an exact `added_at` tie between a mixtape and a track, the interleave order is deterministic-but-arbitrary (lexicographic on disjoint strings) — cosmetic, not a skip/dup; comment it. (This resolves the DBA's P0-2 alarm: total order ⇒ correctness holds; only tie-aesthetics are arbitrary.)
- **`Found · N` invariant (make it explicit + tested).** The count is _already_ safe by construction — `listTracks` computes `totalCount` from a **separate** `select count(*) from tracks ${countWhere}`, not from the row set. **Hard rule: never union the count query; it stays `count(*) from tracks`.** This keeps both the stamp (`index.tsx`) and `trackNumberBase = totalCount || tracks.length` correct. Add a regression test: minting a mixtape and loading the feed leaves `totalCount` (and the row numbering) unchanged.
- **Per-surface narrowing the union does NOT do for free (corrects "inherits for free"):**
  - **Home feed `index.tsx`:** the `MusicPlaylist` JSON-LD maps rows to `MusicRecording { url: spotifyUrl }` and the row loop uses `key={track.trackId}` — both break on a mixtape (`undefined`). Add a `type` branch in the head (skip/recast mixtapes) and key on a stable id.
  - **`llms-full`/`markdownHome` (`agent-discovery.ts`):** they call `listTracks` and push `track.spotifyUrl` — narrow on `type` or they emit `undefined`. (These pass `includeMixtapes:true`; give mixtapes a distinct render line.)
- **The checkpoint row renders THROUGH `TrackRow`, not a sibling that re-declares markup (corrects the draft, honors DESIGN "variant, not a new component").** `TrackRow` already forks on data (`logId` present/absent, story/no-story, `TrackChips` → null). Feed it the discriminated `FeedItem`; when `type==="mixtape"` it renders the `{n} findings · {formatDuration}` meta line in place of the chip row, the cover as inert artwork, and the same Log ID link (the `F` is just data). If a wrapper file is wanted it must _import_ `TrackRow`'s internals, never re-declare `<li className="track-row">`.
- **The "darker pane" is a tint, not a pane (One Pane / Legible Sky).** `.track-row` background is `transparent` (the plate is the glass); a per-row pane would be glass-on-glass. Use a `.track-row-checkpoint` modifier applying a low-opacity warm-dark **tint to the row**, reading as "a deeper region of the same plate." Hold the title + Stardust meta line to AA **over the sun region** of the backdrop, verified in a driven browser past hydration (the project's "verify interactive states visually" standard), not by inspection.

### B — Acceptance criteria

A mixtape appears in the public feed / `recent` / unwindowed `/api/tracks` ordered by `added_at`; a test pages past it without skip/dup. It does **NOT** appear on the admin board, the tag queue, the Stories feed, or a windowed `/api/tracks`. `Found · N` and row numbering unchanged (tested). The checkpoint row passes AA over the sun region. `llms-full`/home-JSON-LD emit no `undefined`.

---

## Increment C — dedicated front doors

Post-MVP, low-risk, ships when an archive is worth fronting.

- `apps/web/src/routes/mixtapes.index.tsx` (`/mixtapes`) — clone `log.index.tsx`'s plate/list grammar; rows link to `/log/<id>`; empty state via `copywriting-fluncle` (the findings pattern is "No findings logged yet. Quiet sector tonight." — match the shape/warmth, mixtape family). No new Shadcn primitive.
- `apps/web/src/routes/api/mixtapes.ts` (`/api/mixtapes`) — GET `listMixtapes()`; cursor optional at cap 54. No `/api/mixtapes/<id>` (the universal resolver covers it).
- `apps/cli/src/commands/mixtapes.ts` — mirror `recent.ts`; register in `cli.ts` `addListenCommands`.
- **MCP (Decision D6):** rely on the B union to include mixtapes in `get_recent_tracks` (the `type` discriminator lets agents disambiguate); add a dedicated `get_mixtapes` only if a mixtapes-only listing is wanted — and **mirror any tool change in `apps/web/src/lib/webmcp.ts`** (the file comment warns of silent divergence).

### C — Acceptance criteria

`/mixtapes`, `/api/mixtapes`, `fluncle mixtapes` each list mixtapes; MCP includes them with `type:"mixtape"`; `webmcp.ts` mirrored if a tool changed.

---

## Increment D — machine-awareness (built in this PR, live at merge)

Built and unit-tested in the PR (markup shape); its real consumer is a crawler of the **public production domain**, which sees it the moment the PR merges with the first mixtape live. Spec:

- **JSON-LD** — `mixtapeAlbumJsonLd(mixtape)` in `apps/web/src/lib/log-schema.ts` (sibling of `musicRecordingJsonLd`): `@type:"MusicAlbum"`, `albumProductionType:"https://schema.org/DJMixAlbum"` (**Decision D4, settled by the runbook + verified valid**; `MixtapeAlbum` the close alternative), `byArtist` Fluncle (`@id`→`/about`), the **dual `identifier` PropertyValue** retrieval-token pattern (bare + `fluncle://`, reused), `description` = the visible dream note, `track` an ordered `ItemList` of `MusicRecording`s whose `url` is each member's `/log/<id>`. `og:type` → `music.album`. Test by mirroring `-about-schema.test.ts` + a unit test on the helper.
- **RSS (`rss[.]xml.ts`) — its OWN raw SQL, not `listTracks` (corrects "inherits for free").** Add a union/second query for mixtapes into the 25-newest feed; emit `<category domain="https://www.fluncle.com/ns/object-type">mixtape</category>` (verified RSS 2.0); a mixtape `<link>`/`<guid>` points at `/log/<id>` (it has no `spotify_url`/`track_id` — both null today). Extract a discriminated `feedItem()` helper.
- **Sitemap (`sitemap[.]xml.ts` + `lib/sitemap.ts`) — its OWN raw SQL.** Add `/mixtapes` to the static entries; UNION the `mixtapes` `log_id`/`lastmod` into the existing `SitemapLogPage[]` (content-agnostic — zero change to `buildSitemapXml`).
- **llms.txt (`public/llms.txt`, static)** — add a **Mixtapes** section (two-object-types + `F`-marker awareness) **written through `copywriting-fluncle`**. `llms-full.txt` mixtape block optional.

### D — Acceptance criteria (markup shape, in the PR; real-world payoff at merge)

Valid `MusicAlbum`/`DJMixAlbum` JSON-LD with member `/log` URLs in the ItemList (schema test); RSS carries the `<category>` and a `/log` link; sitemap lists `/mixtapes` + each mixtape `/log/<id>`; `llms.txt` Mixtapes section (voice-checked).

---

## Sequencing & ownership

- **All four increments ship in one PR, built in A→D order; merge is gated on the first real mixtape being ready to add.** Build order within the PR:
- **Critical path: A1 (persist+mint) → A2 (DTO+brancher) → A3 (admin write — the only producer of a mixtape) → A4 (the `/log` page).** A3 is on the critical path, not parallel with read surfaces nobody can populate.
- **Then, independently:** B (union+row, isolated against the live feed), C (front doors), D (with the publish build).
- **Parallelism inside A:** A1 unblocks everything; A2 and A4 can proceed once the DTO shape is frozen; A3 needs A1's mint + A2's DTO.
- **The one thing that de-risks the most:** freeze the **`MixtapeDTO` + the `type` discriminator** before anything else in A2 — it's the shared contract across the operator, human, and (later) crawler surfaces.
- **Deploy discipline:** all dev-DB-local (`.dev.vars`); no prod step in scope. `typecheck` + `build` after each increment; `bun run check` at the end.

## Decisions — LOCKED (2026-06-18)

All scoping decisions are resolved; a builder executes, does not re-decide.

1. **D-MVP — RESOLVED: full A–D delivery in one PR.** All four increments build in a single PR, in A→D order (each verifiable as it lands). The PR is **merge-gated on the first real mixtape** being ready to add — it goes live with content, not empty. (Supersedes the draft's "A now, rest later"; the increments are the build/review order within the PR, not separate shipments.)
2. **D-draft — RESOLVED: draft → publish lifecycle (a mixtape is never a substance-less spine row).** New mixtapes are created `status='draft'`, **invisible on every public surface** (admin-only); the operator assembles the tracklist + adds links, then **publishes**, which requires **≥1 external link (presence + shape, no reachability check — a throwaway link works for local dev)** and is the moment the Log ID + "No. N" are minted (at publish, so published numbers stay contiguous) and the mixtape enters the spine. A bonus: with drafts hidden, **merging the PR with nothing published is safe** — _publish_ is the real go-live, on your schedule.
3. **D2 — RESOLVED: members are existing findings.** Each member carries a real `logId` for the breadcrumb; non-finding members are out of scope.
4. **D5 — RESOLVED: store `durationMs`.** Reuse `formatDuration`; a deliberate, confirmed deviation from the runbook's `durationSec`.
5. **D-count — RESOLVED: the count query stays `count(*) from tracks`, never unioned.** This keeps the home `Found · N` badge and the admin board's "N findings" header from inflating when a mixtape exists (a mixtape is not a find). Already safe by construction (a separate count query); the rule is "don't break it." Regression-tested.
6. **D1 / D4 — settled by canon:** a separate `mixtapes` table; `albumProductionType: DJMixAlbum`.
7. **D6 / D7 — builder's call at implementation** (low-stakes, reversible): MCP — union-inclusion suffices, add `get_mixtapes` only if wanted (+ mirror `webmcp.ts`); member-picker — zero-dep searchable list + up/down buttons.

No open decisions remain; the RFC is execution-ready.

## Acceptance criteria

Per-increment criteria are listed under A/B/C/D above. Global: `bun run check` + `typecheck` + `build` green; the runbook's "Open questions / build tasks" updated to reflect what shipped; the tree stays green at every increment boundary.

## Risks & open questions

- **The B union is the highest-risk change** — it touches the live feed and four must-stay-findings-only surfaces. The opt-in flag is the guardrail; the acceptance test must assert the four exclusions. Mitigated further by shipping it _alone_, after A.
- **The resolver-widening trap** — a builder following the draft's "one chokepoint" instinct would widen `getTrackByIdOrLogId` and break 8 track-only callers. The separate `getMixtapeByLogId` + brancher is the guardrail; the acceptance test asserts the signature is unchanged.
- **Mint atomicity** — `db.batch` is the repo's first transaction; if a builder reverts to check-then-insert "to match `resolveLogId`," the race returns. The criteria pin `db.batch`.
- **Track deletion orphaning** — the only orphaning vector; covered by the tolerant render + the delete-path extension. If a delete path is found, it must be handled, not assumed absent.
- **`formatDuration` form** — if it yields "58:00" not "58 min" at album length, the checkpoint meta line drifts from canon; verify (D5 rides on it).
- **Voice coverage** — every new string (not just llms.txt) routes through `copywriting-fluncle`; easy to miss the embed/decode/empty/admin strings.
- **External outcomes (Increment D)** — whether crawlers/AI engines cite the mixtape is outside our control; monitor, don't gate.

## Appendix — verifications & sources

- **Panel live verifications (read/confirmed against source):**
  - `LOG_ID_PATTERN = /^\d{3,4}\.\d\.\d[A-Z]$/` (`lib/log-id.ts:6`) rejects `019.F.1A`; 404s at `log.$logId.tsx` `beforeLoad` via `isLogPageParam`→`isLogId`. **Confirmed by 2 reviewers.**
  - `listTracks` callers that must stay findings-only: `story-feed.ts` (`hasVideo`), `mcp.ts`, `agent-discovery.ts` (×2), `routes/index.tsx` (×2), `log.index.tsx`, **`routes/admin/index.tsx` (the board)**, `routes/api/stories.ts` (`hasVideo`), `routes/api/tracks.ts` (`since`/`until` newsletter window), `routes/api/admin/tracks.ts`. **(design adversary)**
  - `getTrackByIdOrLogId` has 8 callers reading track-only fields: `api/og.$logId.ts`, `api/preview.$idOrLogId.ts`, and 5 admin `*.video*`/`*.social*`/`*.preview-archive` routes. **(staff engineer)** — hence do not widen it.
  - `listTracks` computes `totalCount` via a **separate** `count(*) from tracks` query (`tracks.ts:385`), feeding `Found · N` (`index.tsx:264`) and `trackNumberBase` (`index.tsx:245`) → safe iff the count is never unioned. **(design + DBA)**
  - RSS (`rss[.]xml.ts`) and sitemap (`sitemap[.]xml.ts`) do their **own raw SQL**, never call `listTracks` → "inherits for free" is false; they need explicit edits. **(staff engineer)**
  - `@libsql/client/web` supports `db.batch`/`db.transaction`; the repo uses **only** standalone `db.execute` → mint's `db.batch` is the first transaction. `resolveLogId` is non-atomic check-then-insert with no conflict-catch. **(staff engineer + DBA)**
  - `decodeTrackCursor` only asserts `typeof trackId === "string"` → an overloaded `log_id` round-trips; disjoint id spaces give a total order ⇒ pagination exact (tie ordering cosmetic). **(staff engineer + DBA)**
  - Schema conventions (ISO-text dates, `randomUUID` PK, no FK, `social_posts` satellite, `.unique()`), Drizzle-schema-only + raw libSQL runtime, no zod, `requireAdmin`/`isAdminRequest`, `sector` module-private, next migration `0014`, no down-migrations, tree currently green. **(all four)**
- **schema.org (verified June 2026):** `albumProductionType` → `MusicAlbumProductionType`; both `DJMixAlbum` and `MixtapeAlbum` are valid members. Sources: schema.org/MusicAlbumProductionType, /albumProductionType, /MusicAlbum; DJ-mix definition Wikidata Q2619673.
- **Taste pass:** flagged the union as over-engineered for a zero-instance object and the decomposition as conflating the resolver (needed) with the union (deferrable) — both folded into the A/B split above.
