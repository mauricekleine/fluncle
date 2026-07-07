# RFC: The Artist Relationship — entity, pages, and the cross-platform championing motion

**Status:** Final — build-ready. Operator decisions + spike evidence baked in (2026-07-06).
**For:** a fresh build session / a team of agents.
**Canon/authority:** the codebase (`apps/web/src/db/schema.ts`, `lib/server/{spotify,discogs,lastfm,observation,youtube}.ts`, `lib/log-schema.ts`, `components/admin/pipeline/*`, `docs/admin-shell.md`, `packages/registry`, `packages/contracts/src/orpc`), `AGENTS.md`, `DESIGN.md`, `VOICE.md` + `copywriting-fluncle`, the surfaces doctrine, the naming-conventions doc. Planning, not spec.
**Produced by:** an RFC Forge run — 4 grounded research threads + a taste pass (fable-5). The adversarial staff-engineer + SEO panelists were cut short by a session limit; their lanes are covered by research threads (a)/(b) and (c), which verified against the code + 2026 practice. An optional independent technical/SEO re-verification can run before build.

## The spine (the unifying idea)

There is no artist in Fluncle. An artist is a JSON string on `tracks.artists_json` (`schema.ts:18`) — no id, no identity, no home. So the keystone, built first and depended on by everything, is a **canonical artist entity keyed on the Spotify artist ID, carrying an identity graph (a `sameAs` of MusicBrainz / Wikidata / the socials).**

One honest caveat the taste pass sharpened: that identity graph has **two consumers of different natures**, and naming them correctly is what keeps the design clean:

- **The archive reads it** — the artist pages, the `MusicGroup`/`sameAs`/`@id` schema. (Epic A.)
- **The championing motion acts on it** — following the artist across platforms. This is a separate actor with its own lifecycle + external risk, not a passive reader. (Epic B.)

So this ships as **two epics on one spine.** Epic A (entity + resolution + pages + surfaces) makes the archive richer and has **zero operator gates** — it never waits on an OAuth click. Epic B (the follows + the `/admin/artists` follow queue) is Fluncle-the-account acting outward, gated on a Spotify re-auth and carrying all the ToS/quota risk. They share Unit 1 + the resolver and nothing else — so a follow-side surprise never stalls the SEO win, and the pages ship regardless.

## The standard (definition of done)

Boil the ocean: both epics shipped complete, with tests + docs, every thread tied off — "holy shit, that's done." The sequencing is _ordering a complete delivery_, not a menu to cut from. The **only** sanctioned "not now" are genuine external gates (the Spotify re-auth click; whether a given artist actually has a TikTok) — honest scoping, never an excuse. Tie-offs in reach: `artists_json` finally gets a structured home, and the artist `@id` upgrade sharpens every existing `/log` page's schema for free.

## 0. Current state — verified against code

- **Artists are names only.** `tracks.artists_json` is a JSON string array (`schema.ts:18`), parsed by `parseArtistsJson()` (`lib/server/artists.ts`, name-only). No `artists`/`track_artists`/`artist_socials` tables. Artist search is `like '%name%'` over `lower(artists_json)` (`tracks.ts:364`).
- **Spotify artist IDs are dropped at ingest.** `SpotifyTrackResponse.artists` (`spotify.ts:39-43`) types only `{name}`; the `id` Spotify always returns is uncaptured. `publishTrack` stores `JSON.stringify(track.artists)` (names) (`publish.ts:159`). The follow endpoints need the Spotify artist ID → Unit 1 closes this with a one-line type change (no extra API call at add-time).
- **The KG machinery already exists to reuse.** `discogs.ts:319-405` walks `ISRC → /ws/2/isrc/<isrc>?inc=releases+url-rels → MB recording → release url-rels` behind a 1 req/s serializer `throttleMb` (`discogs.ts:71-88`). The artist analog is one hop further: `MB recording → artist-credit → /ws/2/artist/<mbid>?inc=url-rels`. `lastfm.ts` loves the track.
- **Firecrawl is wired as `/v2/search`, synchronous, Worker-side** (`observation.ts:453`; the Worker holds `FIRECRAWL_API_KEY`, the box holds nothing). The resolution spike used `/v2/extract` (structured schema) — see §2.
- **OAuth held:** `spotify_auth` (scopes `playlist-modify-public/private` only — `spotify.ts:10`), `youtube_auth` (`youtube.force-ssl`, the `@fluncle` Brand Account), `mixcloud_auth` (non-expiring). Upsert already does `scope = excluded.scope` (`spotify.ts:463`).
- **The board** (`components/admin/pipeline/*`): a `BoardStep` has `StepKind` (`auto|human`) and `StepState` (`open|running|partial|done|stale|planned`); `STATE_CLASS` (`step-node.tsx:24-32`) already renders `done` (gold+check), `partial` (gold dashed), `planned` (grey). `lastfm` (`SHORT:"LFM"`) derives from `lastfmRan`/`lastfmLoved` (`board-model.ts:269-285`).
- **The retired `/admin/tag` queue** was the proven per-item operator loop — a worklist narrowed to the not-yet-done backlog, one keyboard-driven dialog per item, optimistic save (the tool itself is retired per `docs/audio-embedding-rfc.md`; git history has `docs/admin-tagging.md`) — the pattern the follow queue reuses.
- **UI primitives** in `packages/ui/src/components/` (`@fluncle/ui/components/*`): `dialog` (portals to `document.body` itself — no admin-plate gotcha), `select` (base-ui), `popover`, `switch`, `input` exist; **no `hover-card`** (use `Popover`).
- Migrations via `bun run --cwd apps/web db:generate`; latest is `0048_lean_drax`, so this epic's first is **0049**.

---

# EPIC A — the archive gets an artist (no operator gates)

## Unit 1 — the artist entity (the spine; build first)

Three additive tables (no existing table altered), following repo conventions (surrogate `id` = randomUUID; snake_case; ISO-text timestamps; no declared FKs; `text(...,{enum})`; `uniqueIndex`/`index` as the mixtape tables do).

**`artists`** — surrogate `id` PK + **unique `spotify_artist_id`** (nullable, to admit white-label/unsigned artists; the `mixtapes` id+logId precedent). Columns: `id`, `spotifyArtistId` (unique), `name` (canonical Spotify name, operator-editable), `slug` (**unique** — the real name kebab-cased, minted once, salt-re-roll on collision per `recordings.ts`), `spotifyUrl`, **`mbid`**, **`wikidataQid`** (the KG anchors live here as columns — they key the resolver + assemble into `sameAs`), `resolvedAt` (the single resolution stamp; null = never attempted), `createdAt`/`updatedAt`.

**`track_artists`** — the many-to-many. **Composite PK `(track_id, artist_id)`, plus `position` (1-based). NO `role` column in v1** — nothing reads it (display comes from the kept `artists_json` cache; the page shows all findings regardless of role; `byArtist` JSON-LD doesn't distinguish). Add `role` in the later slice that grows a reader, via the enum-widening convention (costs nothing later). This deletes the remix-regex inference, the ambiguity fallback, and the PK debate.

**`artist_socials`** — the identity-graph store, one row per `(artist_id, platform)` (unique index), mirroring `mixtape_social_posts`. Columns: `id`, `artistId`, `platform` (plain TEXT — the **socials only**: `spotify|youtube|mixcloud|soundcloud|instagram|tiktok|bandcamp|twitter|facebook|homepage` — the KG anchors `mbid`/`wikidata` are `artists` columns, NOT duplicated here), `url`, `source` enum `musicbrainz|firecrawl|operator`, **`status` enum `auto|candidate|confirmed`** (replaces the fake-precision `confidence` float — the model is binary: MB/operator → trusted, Firecrawl-only → `candidate` until confirmed), **`followedAt`** (a single stamp — a platform is either API-followable or manual, and `platform` says which actor; one column is the honest shape), `createdAt`/`updatedAt`.

**Capture + backfill.** Add `id: string` to `SpotifyTrackResponse.artists` (`spotify.ts:39`) so **new** adds capture artist IDs for free at ingest. **Backfill** existing rows via `fluncle admin artists backfill` (the `fluncle-bpm-backfill` precedent): re-fetch `/tracks/{trackId}` (the PK; one cheap call, existing Spotify auth + rate-limit), upsert `artists` by `spotify_artist_id` (name variants collapse to one canonical row), upsert `track_artists`. **Keep `artists_json`** as the display cache; deriving-from-entity is a separate later slice — do not couple it here.

## Unit 2.1 — resolution (MusicBrainz primary → Firecrawl gap-fill)

Per artist, resolve socials into `artist_socials`, reusing the Discogs/MB walk:

1. **MusicBrainz** (`throttleMb` 1 req/s): `ISRC → MB recording → artist-credit MBIDs → /ws/2/artist/<mbid>?inc=url-rels`; classify each relation by type/host. MB url-rels are human-curated → `status=auto` (trusted). Also captures `mbid` + the Wikidata relation → the `artists` columns. _(Spike: MB resolved 12/12 real Fluncle artists — IG 9/12, SoundCloud 9/12, Spotify 11/12, homepage 11/12; TikTok 1/12, YouTube 5/12.)_
2. **Firecrawl gap-fill — TikTok + missing YouTube only.** _(Spike: Firecrawl took Dimension 0→4 clean official handles.)_ **D7 (decide at build):** the spike validated `/v2/extract` (prompt + JSON schema + `enableWebSearch:true`) returning a clean `{instagram,tiktok,youtube,soundcloud}` object — recommended (less classify glue, spike-proven); the codebase precedent is `/v2/search` (classify results). Firecrawl-sourced rows → **`status=candidate`**.
3. **Normalize** every URL: strip UTM/query; canonicalize TikTok/IG to the `@handle` profile root (the spike's Flowidus case returned a _video_ URL); resolve YouTube `/@handle` → stable `channelId` via `channels.list?forHandle=` (1 quota unit) for a durable follow target.
4. **The trust gate is pointed at the PUBLIC page, not the follow** (the taste inversion — a wrong `sameAs` misidentifies the artist to Google + every AI engine, semi-permanently; a wrong follow is invisible + one-click reversible): **`candidate` rows are excluded from the artist page + `sameAs` + sitemap until promoted to `confirmed`.** `auto`/`confirmed` render publicly; the follow (Epic B) may act on `auto` and `confirmed`. **What promotes `candidate → confirmed`:** (a) **a one-tap operator confirm** in the `/admin/artists` queue — a glance ("is that the right artist's TikTok?"), which **piggybacks the manual follow** the operator is already making there, so it is not extra work; and (b) **optional auto-confirm on corroboration** — if the candidate handle is independently corroborated (it appears in the artist's MB-linked homepage/linktree, or the Spotify artist page's own socials, or a second Firecrawl pass returns the same URL), promote automatically. Only genuinely-uncorroborated Firecrawl-only links wait for the human glance — and per the spike most socials arrive as `auto` from MusicBrainz, so the candidate queue is small by construction (mostly TikTok gap-fills).

Runs as a new on-box `--no-agent` sweep **`fluncle-artist-sweep`** (the `context-sweep` template): drains artists with unresolved socials → agent-tier Worker op **`resolve_artist`** (the box holds no MB/Firecrawl creds; the Worker does the calls), per-artist reliability columns mirroring `backfill_discogs_*`. Register `cron.artist-sweep` in `@fluncle/registry` + the healthcheck mirror. (Epic B adds a follow _phase_ to this same sweep — §Epic B.)

## Unit 3 — artist pages (`/artist/<slug>`) + the SEO/AEO graph

- **Route `/artist/<slug>`** (singular = one `MusicGroup`; index at `/artists`). **Slug = the artist's real name** kebab-cased — NOT the galaxy-vocab slug (that's for Fluncle's own opaque objects; an artist URL must carry the real name as a ranking/entity signal). Minted once on the row.
- **Page = a dark, cover-led Instagram-style GRID of the artist's findings** (operator's call), each cell a `<Link to="/log/$logId">` wrapping `<TrackArtwork>`, reusing `spotifyAlbumImageAtSize`/`trackMedia(logId).coverUrl` (the `/log` "Close in sound" + sitemap precedent). **Held to DESIGN.md** — a Fluncle cover grid (dark, quiet, centered), not a bright streaming-app clone; anchored under a **plate masthead** (the artist name as nameplate + the voice frame + the socials row). Video findings can hover-play via `videoCrop` MT later; static covers are the MVP. Socials row = `BrandIcon`/`simple-icons` (never a Phosphor brand glyph), only `confirmed`/`auto` platforms.
- **The Fluncle-voice frame** — one or two lines in the `/about` register, framing _Fluncle's relationship to the findings_, **NEVER a fabricated bio** (VOICE.md), active-voice (Fluncle does the verb): e.g. _"I've logged seven of theirs. Here's the map."_ The `<title>`/meta stay honestly-plain third-person (the Narrator rule); the first person lives only in the frame.
- **★ The missing high-leverage link (taste #7):** the artist name must _link_ to `/artist/<slug>` — humans reach the pages from the archive, and the `@id` graph gets its human-visible internal-link twin (where the SEO equity flows). **Where it lands:** the **`/log/<id>` page** (Artist — Title there is standalone, not wrapped in a competing link), mixtape tracklists, and the artist-page header — the clean, primary surfaces. NOT naively "the compact archive rows": those are already a single `<Link>` to `/log/<id>` and an `<a>` cannot nest, so adding the artist link there means **splitting the row's click targets** (artist → `/artist`, cover+title → `/log` — the Spotify/Apple row pattern), a real markup change. Ship the `/log` + tracklist links in v1 (acceptance criteria); the row-split is a clean later slice, not a blocker.
- **JSON-LD** — add `musicGroupJsonLd(artist, findings)` to `lib/log-schema.ts`, emitted via the XSS-safe `jsonLdScript()` sink (`lib/json-ld.ts`; artist names are untrusted → mandatory). `MusicGroup` (`name`, `url`, `image` = the most-played finding's art or a generated galaxy card — no fabricated portrait; `genre:"Drum and Bass"`) + `track` → `ItemList` of `MusicRecording` (reuse the `mixtapeAlbumJsonLd` reducer, `log-schema.ts:144-173`) + **`sameAs`** (Wikidata > MusicBrainz > Spotify > the confirmed socials) + a breadcrumb.
- **★ The cheap, structural AEO unlock — the cross-page `@id` graph:** stamp `@id = <siteUrl>/artist/<slug>` on the `byArtist` `MusicGroup` node of **every `/log` page** (`log-schema.ts:34`, today id-less) AND emit the same `@id` on the artist page. One stamped URL on an already-emitted node reconciles recording→artist across the whole site for crawlers + AI answer-engines. (Update `log-schema.test.ts`.)
- **Thin-content gate:** index only at **≥3 coordinate-bearing findings** (the "≥1 editorial element" conjunct is vacuous — the voice frame auto-generates on every page; the real gate is the finding count). Below: serve `200` (deep-links + link equity) with `<meta robots="noindex, follow">` + exclude from sitemap + llms.txt. Flip automatically at render.

## Unit 4 — surfaces (registry fan-out)

Per the fluncle-surfaces runbook + verb_noun. **`api.artists`** oRPC ops `list_artists`/`get_artist` (`/api/v1/artists`, `/api/v1/artists/:slug` — oRPC, or `orpc-coverage` fails). **`cli.artists`** — `fluncle artists` (list) + `fluncle artists <slug>` (thin `publicApiGet`, mirroring `recent`/`mixtapes`). **SSH** — an `Artists` menu item + screen in `apps/ssh/main.go` (reads the public API directly) + optional `artists` boot deep-link. **`@fluncle/registry`** — a `web.artist` entry (`kind:"web_route"`, `route:"/artist"`, `weights:{ssh:"secondary",web:"secondary"}`, `probeConfig`) + `api.artists`/`cli.artists`, auto-fanning to `/status`, nav/dev-row, `llms.txt`, sitemap, the doctrine doc. Satisfy the registry invariants test. (`llms.txt` is static `public/llms.txt` — add a curated top-N-artists line or move it to a generated route; small decision.)

---

# EPIC B — the championing motion (gated on the Spotify re-auth)

## Unit 5 — the follow-writes + the `/admin/artists` queue

### 5.1 Auto-follows (where API + OAuth exist)

| Platform                            | Endpoint                                                  | OAuth                                     | Re-auth?                                                                                                    | Notes                                                                                                                                                 |
| ----------------------------------- | --------------------------------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Spotify**                         | `PUT /v1/me/following?type=artist&ids=`                   | `spotify_auth`                            | **YES — add `user-follow-modify`** (must re-request the existing playlist scopes too, or publishing breaks) | 50 ids/req; 429+Retry-After                                                                                                                           |
| **YouTube**                         | `POST /youtube/v3/subscriptions` (`resourceId.channelId`) | `youtube_auth` (`@fluncle` Brand Account) | **Likely NO** — `youtube.force-ssl` already covers it (confirm)                                             | 50 units/insert, 10k/day ≈ 200/day → pace it; `subscriptionDuplicate` = idempotent-done                                                               |
| ~~Mixcloud~~                        | —                                                         | —                                         | —                                                                                                           | **CUT to link-only** (taste): the `follow/` endpoint is undocumented since 2022, coverage is sparse, payoff ≈ zero — completionism carrying API risk. |
| IG / TikTok / SoundCloud / Mixcloud | none                                                      | —                                         | —                                                                                                           | no follow API → manual (§5.2); Last.fm stays track-love only                                                                                          |

Auto-follow acts on `status IN (auto, confirmed)`, idempotent by `followedAt IS NULL`, quota-paced ~5/tick. It's a **follow _phase_ added to `fluncle-artist-sweep`** (resolve then follow; the follow phase no-ops until the Spotify scope lands — one sweep, phase-ordered, not two crons) → agent-tier op **`follow_artist`** (Spotify + YouTube).

### 5.2 The `/admin/artists` follow queue (the manual motion — operator's call)

Follows are **per-artist**, so the manual follow lives at the artist grain, NOT as a per-track board column (which would duplicate one artist's state across all their findings). A dedicated **`/admin/artists` queue** reusing the `/admin/tag` pattern (queue + keyboard loop): a list of artists with unfollowed/unconfirmed socials, each showing deep links to the resolved profiles (IG/TikTok/SoundCloud + any `candidate` links to confirm); the operator taps out to follow, then **one-tap registers** it (sets `followedAt`) and **confirms** a `candidate` (sets `status=confirmed`, which also lets it onto the public page). Add/remove-platform inline: a `Select` (base-ui; render the platform logo manually next to `SelectValue`) + a URL `Input`.

**The board keeps only the automated aggregate:** repurpose the **LFM cell** into the automated-socials indicator (Last.fm love + Spotify/YouTube auto-follow state, batched into `fetchBoard`'s `Promise.all` via `listArtistSocialsForTracks(ids)`), `done`=all-actioned / `partial`=some / `open`=none, with a **`Popover`** hover breakdown per platform (`BrandIcon` + check). No stateful "Yours" column, no per-track dialog — that machinery is deleted in favor of the queue.

**oRPC ops** (verb_noun; register in `@fluncle/contracts` + `orpc/**`; add to **both** build-fail coverage tests): `list_artist_socials` (admin), `record_operator_follow` / `confirm_artist_social` / `add_artist_social` / `remove_artist_social` (operator: `.use(adminAuth).use(operatorGuard)`). Optimistic `setQueryData` on register.

_The daring note (taste #11): the follow is the timid form of championing — the artist **page** is the gift. The bolder motion, later + deliberately, is putting that page in front of the artist._

---

## Sequencing & effort (a complete delivery, ordered)

**Epic A (ships first, no gates):**

1. **Unit 1 — entity** (M): tables + migration `0049`, capture `artists[].id` at ingest, the backfill command. _Everything depends on this._
2. **Unit 2.1 — resolution** (M): `fluncle-artist-sweep` resolve phase + `resolve_artist` (MB + Firecrawl + normalize + the page-facing trust gate).
3. **Unit 3 — pages** (M): route + Fluncle cover grid + plate masthead + the artist-name links + `musicGroupJsonLd` + the `@id` graph + thin-content gate.
4. **Unit 4 — surfaces** (S): registry + api + CLI + SSH.

**Epic B (after A; gated on the Spotify re-auth):** 5. **Unit 5** (M): the follow phase + `follow_artist` (Spotify + YouTube), the `/admin/artists` queue + its ops, the LFM automated-socials repurpose.

Each unit ships complete with tests + docs. Epic A Units 3/4 parallelize once 1–2 land.

## Acceptance criteria (definition of done)

New findings' artists get `artists` + `track_artists` rows at add-time (Spotify IDs captured); the sweep fills `artist_socials` (normalized, `auto`/`candidate`); `candidate` socials stay off the public page until confirmed. `/artist/<slug>` renders the Fluncle cover grid + plate masthead + confirmed socials + `MusicGroup`/`sameAs`/`@id`-graph JSON-LD (XSS-safe), noindexed until ≥3 findings; **artist names on `/log` + the track row link to it**. The board's LFM cell aggregates the automated socials with a Popover breakdown; `/admin/artists` is the follow queue (deep links + one-tap register/confirm + add/remove-platform). Epic B: the follow phase auto-follows high-confidence Spotify/YouTube targets (idempotent, quota-paced) after the re-auth. `fluncle artists`, the SSH menu, `/api/v1/artists`, and the `web.artist` fan-out all resolve. **Tests:** the backfill canonicalization, resolution+normalize+the page-trust gate, follow idempotency, `musicGroupJsonLd` + the `@id` graph (+ XSS), the artist-name link, the thin-content gate, the LFM aggregate derivation, the `/admin/artists` queue ops' tiers + coverage entries, registry invariants. **Docs:** `docs/artist-relationship.md`; the fluncle-surfaces/naming updates; `track-lifecycle.md` gains the artist-entity + resolve/follow steps.

## Decisions to resolve before handoff

Ratified inline (clear, no counter-tension): surrogate `artists` key (admits white-labels); all-artists-get-a-page (noindex the thin ones); `/artist/<slug>` + `/artists` index; `track_artists` = `(track_id, artist_id)` no-role-in-v1; collab findings appear on each individual artist's grid (no combined page in v1); Mixcloud + SoundCloud link-only. **Genuinely open:**

- **D7 — Firecrawl call-shape:** `/v2/extract` structured (recommended, spike-proven) vs reuse `/v2/search`.
- **Thin-content threshold:** ≥3 coordinate-bearing findings — confirm the number.
- **`llms.txt`:** curated top-N line vs convert to a generated route.
- **Operator gates (clicks, not decisions):** the Spotify re-auth adding `user-follow-modify` (keep the playlist scopes!); confirm the YouTube `@fluncle` Brand Account scope.

## Appendix — spike evidence + provenance

- **Resolution spike (2026-07-06):** MusicBrainz 12/12 (IG 9, SoundCloud 9, Spotify 11, homepage 11; TikTok 1, YouTube 5); Firecrawl gap-filled the TikTok/YouTube holes (Dimension 0→4; IG cross-validated vs MB). Caveats designed-in: normalize deep-links → profile roots; Firecrawl "official" isn't certified → `candidate`/operator-confirm before the public page.
- **Follow feasibility:** Spotify `PUT /me/following` (needs `user-follow-modify`), YouTube `subscriptions.insert` (existing scope likely covers); IG/TikTok/SoundCloud/Mixcloud have no usable follow API → manual/link-only.
- **Forge provenance:** 4 research threads (schema / resolution+follow / pages+SEO / admin-UX) + a fable-5 taste pass, all grounded in the cited code. Key taste refinements folded in: the trust gate protects the public page not the follow; the store is a slim identity graph (no `confidence` float, one `followedAt`, KG anchors as columns, no unread `role`); the artist-name link; the two-epic split; Mixcloud-follow cut; the voice line. Operator calls folded in: the IG-style cover grid (held to DESIGN.md); the manual follow as an `/admin/artists` queue, not a board column.
