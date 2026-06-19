# RFC: Mixtape autopublish — distribute a checkpoint's audio + video to YouTube and Mixcloud

**Status:** Final (divergent research → /taste → 3-role adversarial panel synthesized, 2026-06-19) — completeness standard applied.
**For:** a fresh build session (or two agents in parallel) implementing distribution on top of the shipped mixtape spine (PR #22, branch `feat/mixtapes-admin-polish`).
**Canon/authority:** the codebase (`apps/web`, `apps/cli`) + `docs/fluncle-mixtapes-runbook.md` arbitrate; `AGENTS.md` for architecture rules. Planning, not spec.

> Process note: four research threads (data/flow, YouTube API+OAuth, Mixcloud API, CLI/large-file mechanics), a /taste pass, and a 3-role adversarial panel (staff engineer, platform-API correctness, product-scope+taste). The panel corrected three load-bearing errors in the draft — **the YouTube resumable session URI is NOT self-authorizing** (the data PUT needs an OAuth token), the Worker **cannot** build a ~90 MB multipart body (128 MB isolate limit), and **mint-after-upload can't bake a correct Log ID into the asset**. All three are fixed below; verifications + sources in the appendix.

## The standard (definition of done)

Scaled to what this is: a one-operator, sporadic (≤54 lifetime) publish flow. "Done" = **publishing works end-to-end from one CLI command, a failed upload never strands a Log ID, and the public spine never shows a linkless mixtape** — with unit tests on the pure logic (the mint transaction, the chapter helper) and the runbook rewritten from "manual" to the real flow. Tests + docs are acceptance criteria, not follow-ups. The only sanctioned "not now" is **SoundCloud** (its API registration is externally gated) — left as an honest manual paste, with the data model accommodating it at zero rework. Dangling threads this ties off: the runbook's Phase C/D, the Mixcloud licensing note, and the "members without cue timestamps" gap.

## 0. Summary / the reframe

- **Unifying simplification: distribution is the existing track-video flow — the Worker mints a capability, the _CLI_ moves the local bytes, the Worker records.** Fluncle already does this for track video: presign an R2 PUT, the CLI streams `Bun.file()` straight to storage (bypassing the Worker's body cap), a finalize route records the result (`apps/cli/src/commands/track.ts:115-188`). Every distribution leg is the same three beats. The capabilities differ per sink (and one panel correction reshaped them — see below), but the shape is one the codebase already runs in production.
- **The CLI is the single publish surface.** The 3.3 GB video and the audio master live on the operator's Mac; the CLI is where they are. One command — `fluncle admin mixtape distribute <logId> --video … --audio …` — does the whole publish, mirroring how track videos already ship (no dashboard upload button exists for those either). The dashboard's job is **status + retry + the recurring unlisted→public flip**, not multi-GB browser uploads. This kills the half-built-dashboard problem the draft had.
- **Mint FIRST, then upload (corrected ordering).** The cover endpoint only serves `published`/minted rows and the uploaded assets must embed the _real_ coordinate (title, description chapters, thumbnail, Mixcloud sections) — so the Log ID has to exist _before_ upload, not after. Publish therefore: gate → **mint the coordinate + title** into a non-public **`distributing`** state (cover renders; public surfaces hide it) → upload to the platforms with the committed coordinate → the **first successful link flips `distributing` → `published`** (now public). A total upload failure leaves a non-public `distributing` mixtape whose Log ID is _held_ (not stranded — it belongs to a real mixtape the operator retries); retry reuses the committed Log ID. This keeps "no linkless _public_ mixtape" true, eliminates the provisional-coordinate race entirely (so no serialization lock is needed — the atomic mint CTE is the only serialization, and there is one operator), and avoids baking a wrong coordinate into a YouTube asset.
- **Decomposition.** Phase 0 (data model + mint-first reshape + chapter helper) is the coupled core. **YouTube (Phase 1) and Mixcloud (Phase 2) are independent** — different asset, auth, and byte path — and parallelize after Phase 0. SoundCloud is independent and deferred (external gate).
- **Honest secret posture (corrected).** The YouTube data PUT requires an OAuth access token, so the clean "token never leaves the Worker" property the draft claimed is **false**. The durable secret (the refresh token) stays server-side (the Spotify-mirror `youtube_auth` table); the Worker mints a **short-lived (~1 h) access token** and hands it to the CLI alongside the session URI for the PUT. That bounded handoff is unavoidable for a client-side upload of a file the Worker can't proxy — state it plainly, don't oversell it.

## 1. Context & goals

**Why now.** The mixtape spine shipped (PR #22): drafts are the operator subset (recordedAt, duration, note, tracklist), publish mints the Log ID + title, the cover renders on the fly. The remaining manual chore is the runbook's Phase C — hand-uploading to the platforms and pasting URLs back. This automates it.

**Goals (in reach):** one CLI command distributes a mixtape's video→YouTube (unlisted) and audio→Mixcloud and records the links; the recurring human gate (YouTube unlisted→public) is one command/one button; zero public-surface rework (distribution dual-writes the existing `mixtapes.*_url` columns).

**Outside our control (honest calibration):**

- **YouTube channel verification is a hard Phase-1 precondition**, not a nicety: an unverified `@fluncle` channel caps uploads at 15 min, so a 30–60 min mix **fails at insert** (not just "no thumbnail"). Verify the channel (phone verification) before Phase 1 ships.
- **YouTube Content ID** will claim a DJ mix; it stays up, labels monetize. Expected (reach, not revenue).
- **Mixcloud regional/Premium gating** depends on the set obeying the Featured-Artist rules — a content property, not plumbing.
- **SoundCloud API access** is gated by SoundCloud; deferred.

## 2. Phase 0 — Data model + mint-first reshape (the coupled core)

### 2.1 `mixtape_social_posts` table

Mirror `social_posts` (`apps/web/src/db/schema.ts:287-302`), keyed by `(mixtape_id, platform)`:

```ts
export const mixtapeSocialPosts = sqliteTable(
  "mixtape_social_posts",
  {
    createdAt: text("created_at").notNull(),
    externalId: text("external_id"), // YouTube videoId / Mixcloud cloudcast key
    id: text("id").primaryKey(),
    mixtapeId: text("mixtape_id").notNull(),
    platform: text("platform", { enum: ["youtube", "mixcloud"] }).notNull(),
    publishedAt: text("published_at"),
    status: text("status", { enum: ["uploading", "published", "failed"] }).notNull(),
    updatedAt: text("updated_at").notNull(),
    url: text("url"),
  },
  (table) => [
    uniqueIndex("mixtape_social_posts_mixtape_platform_idx").on(table.mixtapeId, table.platform),
  ],
);
```

`platform` is plain TEXT at the DB level (the enum only narrows the type) — adding `soundcloud` later needs no migration. Functions mirror `apps/web/src/lib/server/social.ts`: `upsertMixtapeSocialPost` / `updateMixtapeSocialStatus`, same `coalesce(...)` preservation on conflict (idempotent re-runs). **Add the touch** `social.ts` does for tracks: bump `mixtapes.updated_at` on every write, so the cover's `?v=<updatedAt>` cache-buster and RSS lastmod refresh.

**Dual-write:** when a platform reaches `published`, write the public URL into BOTH `mixtape_social_posts.url` AND the matching `mixtapes.{youtube,mixcloud}_url` column. The `mixtapes.*_url` columns stay the public contract (§2.4); `mixtape_social_posts` adds the distribution state machine. (Panel verdict: dual-write beats deriving — zero surface changes.)

Migration: `bun run --cwd apps/web db:generate` (never hand-write SQL — AGENTS.md). Commit `.sql` + `drizzle/meta/00NN_snapshot.json` + the `_journal.json` entry together (next idx **18** after `0017_yummy_malice.sql`, verified).

### 2.2 The reshaped `publishMixtape`: gate → mint → distribute → first-link-publishes

Current `publishMixtape` (`apps/web/src/lib/server/mixtapes.ts:239-328`) gates + mints + canonicalizes the title in one write, requiring a manual link. The reshape:

1. **Gate (read-only).** Keep `recordedAt` + `note` + `durationMs` + `≥1 member`. **Drop `hasExternalUrl`** from the gate (distribution supplies the link). **Add a cap pre-check** `max(sequence_number)+1 <= 54` — fail before any upload starts.
2. **Mint into `distributing`.** Run the existing atomic mint CTE (`apps/web/src/lib/server/mixtapes.ts:272-298`) — but set `status = 'distributing'`, not `'published'`. This commits `sequence_number` + `log_id` + canonical title now, so the cover endpoint and the asset metadata have a _real_ coordinate. The atomic `max+1` CTE is the only serialization needed (one operator → no concurrent mint).
3. **Distribute** (the CLI, §3/§4) using the committed coordinate.
4. **First link publishes.** When the first platform reaches `published`, a finalize route flips `mixtapes.status 'distributing' → 'published'` and dual-writes the URL. Subsequent links add async; a failed leg stays `failed` in `mixtape_social_posts`, retryable, reusing the committed Log ID.

**New `mixtapes.status` value: `distributing`** (`MixtapeStatus = "draft" | "distributing" | "published"`, `apps/web/src/lib/mixtapes.ts:4`). It means _minted, assets uploading, not yet public_. **This is load-bearing, not gold-plating:** it's what makes "a published mixtape always has ≥1 link" true while still letting the cover render off a committed coordinate during upload.

**Required audit — every `status='published'` predicate** (the staff-engineer catch; enumerate and decide per call site):

- `getMixtapeByLogId` (`mixtapes.ts:351-360`) and the `MIXTAPE_SELECT` callers at `:355/:369/:393` currently return published only.
- **The cover endpoint** (`apps/web/src/routes/api/mixtape-cover.$logId.ts:63`) calls `getMixtapeByLogId` and 404s non-published rows → it **must admit `distributing`** (else the thumbnail/picture can't render during upload — the dependency the whole flow rests on).
- **Public surfaces** (`/log`, `/mixtapes`, `/api/mixtapes`, `rss[.]xml.ts`, agent-discovery) **must exclude `distributing`** (no public linkless mixtape).
- **Admin** (`/admin/mixtapes`) **must show `distributing`** (the operator watches it publish).
  Introduce two query helpers — `getMixtapeForRender(logId)` (admits `distributing`) vs `listPublicMixtapes()` (published only) — rather than scattering status literals.

**No serialization lock** (draft had one; cut). The race it guarded requires two concurrent publishes; there is one operator and the mint CTE is atomic. The draft's own "race is effectively nil" admission plus a lock was belt-on-suspenders that introduced a real deadlock risk (a crashed `distributing` mixtape blocking the operator's own retry). Gone.

**Crash safety (the corrected ordering's payoff):** because the Log ID is committed _before_ upload, an asset always embeds the _correct_ coordinate. A crash between a successful YouTube PUT and the finalize call leaves a live unlisted video with the right Log ID and a `uploading` row; retry is idempotent per `(mixtape_id, platform)` and reconciles (see §3.2 on dedupe). No wrong-coordinate-baked-into-asset failure (the draft's mint-after ordering had this; fixed).

### 2.3 Chapter/section helper — one source for YouTube chapters + Mixcloud sections

Members hydrate to `MixtapeMember = TrackListItem & { startMs? }` via `getTracksForMixtape` (`apps/web/src/lib/server/tracks.ts:273-288`), ordered by `position`, carrying `artists`, `title`, nullable `startMs`. A pure helper (`apps/web/src/lib/mixtape-chapters.ts`) emits both from one pass:

- **YouTube** lines `mm:ss Artist — Title` (`h:mm:ss` past an hour): first chapter forced to `00:00`, each subsequent ≥10 s after the prior, **≥3 total or return none** (YouTube ignores a partial set). Appended to the description after the note.
- **Mixcloud** `sections[]` = `{ artist, song, start_time }`, `start_time` in **integer seconds** (verified field shape).
- **Members without `startMs`**: filtered from both (can't place on a timeline). If <3 cued, YouTube gets no chapters (description still carries note + a plain tracklist). The CLI **logs** "N of M members have no cue" before uploading — a log line, not a UI (warn, don't block; a cue-less mix is still valid).

Unit-test hard: 00:00 forcing, the ≥10 s/≥3 rule, seconds conversion, sparse-cue fallback. It's the one piece of pure logic.

### 2.3a The description helper — note + the `fluncle://` breadcrumb (derived, never stored)

A pure helper, `mixtapeDescription(note, logId)` (`apps/web/src/lib/mixtape-chapters.ts` or a sibling), returns the dream note with the coordinate appended: `` `${note}\n\nfluncle://${logId}` ``. The `fluncle://<logId>` marker is **never stored in the `note` column** and is **external-only** — it's appended solely when building the **YouTube/Mixcloud descriptions at upload**. **Internally, `/log` shows the clean stored note** — the coordinate is already displayed there as the mixtape's identity, so no marker is needed (showing it would be redundant). The stored note stays clean; the breadcrumb rides along only on the external platforms, where the spine isn't otherwise visible. Unit-test the suffix + the blank-line separation.

### 2.4 Surfaces reading the URLs (keep working via dual-write)

`MixtapeDTO.externalUrls` (`rowToMixtape`, `apps/web/src/lib/mixtapes.ts:82-86`) feeds `/log/$logId` (the "where to listen" block + links), `lib/log-schema.ts` (`sameAs`), `lib/server/agent-discovery.ts` (llms.txt), `routes/rss[.]xml.ts`, and `/api/mixtapes`. Distribution dual-writes the URL into `mixtapes.*_url`, so all keep working with **zero changes** (modulo the `distributing` exclusion in §2.2). `/log` keeps rendering the clean stored note (no `fluncle://` marker internally — that's external-only, §2.3a).

## 3. Phase 1 — YouTube (video)

Independent of Phase 2; ships after Phase 0.

### 3.1 Our YouTube OAuth — mirror Spotify (server-side)

Postiz keeps the per-track Shorts via its own Google OAuth; the mixtape uses **our own** OAuth so the durable refresh token lives server-side and the dashboard can later flip visibility. Mirror Spotify (verified: `spotifyAuth` table at `schema.ts:65-71` — `service` PK, `refreshToken NOT NULL`, `accessToken`, `expiresAt`, `scope`):

| Spotify (exists)                                                                   | YouTube (build)                                          |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `spotify_auth` table                                                               | `youtube_auth` table, same shape                         |
| `GET /api/admin/spotify/auth/start` → signed `state` → `authUrl`                   | `GET /api/admin/youtube/auth/start` → Google consent URL |
| `/api/admin/spotify/auth/callback` exchanges code → stores refresh token           | `/api/admin/youtube/auth/callback` → same                |
| `/api/admin/spotify/auth/login` + "Log in with Spotify" (`routes/admin/login.tsx`) | `/api/admin/youtube/auth/login` + "Log in with YouTube"  |
| CLI `fluncle admin auth spotify` (`apps/cli/src/commands/auth.ts`)                 | CLI `fluncle admin auth youtube`                         |

**Scope: `youtube.upload` alone** covers `videos.insert`, setting `privacyStatus=unlisted` at insert, AND `thumbnails.set` (panel-corrected — the draft over-hedged with `youtubepartner`). Add **`youtube.force-ssl`** only because of the unlisted→public flip (`videos.update`, §3.3). Reuse `signState` (purpose `"youtube-auth"`).

### 3.2 Upload — Worker initiates + mints a token; CLI PUTs (corrected)

**Correction (panel C1):** a YouTube resumable session URI is **not** self-authorizing — the data PUT requires `Authorization: Bearer <access_token>`. So:

1. **Initiate (Worker).** `POST /api/admin/mixtapes/:id/youtube/initiate`: the Worker refreshes its stored token, then `POST https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status` with the metadata (`snippet`: title ≤100 chars, description = `mixtapeDescription(note, logId)` (note + the `fluncle://<logId>` marker, §2.3a) followed by the chapters (§2.3), `tags`, `categoryId:"10"` Music; `status`: `privacyStatus:"unlisted"`, `selfDeclaredMadeForKids:false`) and `X-Upload-Content-Type/-Length`. Returns to the CLI **both** the `Location:` session URI **and a short-lived (~1 h) access token**.
2. **PUT (CLI).** The CLI streams `Bun.file(video)` to the session URI **with `Authorization: Bearer <token>`** — same streaming shape as the R2 PUT (`track.ts:153`), run **outside the Bash sandbox** (memory: sandbox throttles sustained uploads). Handle resume: on `308` continue from the `Range` offset; on `401` (token expired mid-multi-GB-upload) call back to `/youtube/initiate?resume=1` for a fresh access token and resume at the offset; on `5xx`/`410 Gone` re-initiate the session.
3. **Finalize (CLI→Worker).** The terminal `200/201` PUT response **is the Video resource JSON, including `id`** (verified — no separate `videos.list` needed). The CLI POSTs `videoId` to `/api/admin/mixtapes/:id/youtube/finalize`; the Worker records `mixtape_social_posts(youtube, published, externalId=videoId, url=https://youtu.be/<id>)`, dual-writes `mixtapes.youtube_url`, and — if first — flips `distributing → published`. Finalize is idempotent on `(mixtape_id, platform)`; on retry after a crash-before-finalize, the CLI re-initiates (a possible duplicate unlisted video is the rare cost — note it; the operator deletes the dup, or a future enhancement queries `search.list` by title to reconcile).

### 3.3 Thumbnail, visibility, limits (corrected)

- **Thumbnail** = the cover endpoint at a size ≤2 MB (YouTube's thumbnail cap; the 1500² `size=square` PNG may exceed it — **use `size=wide` 1280×720 and verify it's ≤2 MB**, else add a `size=thumb`). Set via `thumbnails.set` after insert.
- **Unlisted → public flip** = the recurring human gate, as **one action**: a `videos.update` (privacyStatus=public) exposed as both `fluncle admin mixtape publish-youtube <logId>` AND a dashboard button (the Worker holds the refresh token, so this is server-side — no local file needed). This replaces "go flip it in YouTube Studio."
- **Limits (corrected):** 256 GB / 12 h per video (3.3 GB fine); **>15 min requires a verified channel** (the Phase-1 precondition, §1); `videos.insert` is metered in the **separate Video Uploads quota bucket (~100 uploads/day default)** as of the Dec 2025 quota change — **not** the old "~1600 of 10,000/day." A non-issue at mixtape cadence; the runbook note must use the corrected model.

## 4. Phase 2 — Mixcloud (audio)

Independent of Phase 1; ships after Phase 0.

### 4.1 CLI-direct upload, CLI-local token (corrected — no Worker proxy)

**Correction (panel C1/staff-engineer):** the Worker **cannot** build a ~90 MB multipart body — the 128 MB isolate memory limit plus `FormData`/Blob materialization would OOM, and there's zero multipart precedent in the Worker (every large-byte path avoids it). And down-encoding the _licensed primary master_ to ≤95 MB to fit a Worker cap is the tail wagging the dog. So Mixcloud upload is **CLI-direct**, exactly parallel to the YouTube PUT: the CLI holds a **CLI-local `MIXCLOUD_ACCESS_TOKEN`** (the operator's own Mixcloud credential, in the CLI env like `FLUNCLE_API_TOKEN`) and POSTs the local master directly. No Worker proxy, no 100 MB cap, **no encoding compromise** — full-quality master up to Mixcloud's 4 GB limit. The Worker still owns authority (it records `mixtape_social_posts` + the URL + the publish flip via the finalize route).

**Token:** OAuth2 authorization-code, browser-initiated once (`/oauth/authorize` → `/oauth/access_token?…&code=…` → `{access_token}`). Sent as **`?access_token=` query param, not Bearer** (Mixcloud diverges; note it). The docs only guarantee a _revocation_ path — **do not claim "never expires"**; provision once, and handle the `"An invalid access token was provided"` error by re-authing. **Provisioning helper: `fluncle admin auth mixcloud`** (mirrors `auth spotify`/`auth youtube`, but for a paste-in token since Mixcloud lives CLI-side): it checks whether `MIXCLOUD_ACCESS_TOKEN` is already set for the selected env; if not, it prints the authorize URL, prompts the operator to paste the resulting token, and writes it to the right local env file. Respect the CLI's `--env` flag (load local vs prod credentials) so the token lands in the correct dotenv. The token never touches the Worker — it's the operator's own Mixcloud credential, used from the operator's machine, exactly like `FLUNCLE_API_TOKEN`.

### 4.2 Upload request (verified field shapes)

`POST https://api.mixcloud.com/upload/?access_token=…`, `multipart/form-data`, built in the CLI (Bun `FormData` — no Worker memory constraint):

| Field                                    | Value                                                                                                                                                                                       |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mp3` (file part; literally named `mp3`) | the audio master (≤4 GB)                                                                                                                                                                    |
| `name`                                   | canonical mixtape title                                                                                                                                                                     |
| `description`                            | `mixtapeDescription(note, logId)` — note + the `fluncle://<logId>` marker (§2.3a), ≤1000 chars (the marker adds ~25)                                                                        |
| `picture` (file part)                    | the CLI fetches `https://www.fluncle.com/api/mixtape-cover/<logId>?size=square` (PNG) and attaches the Blob — **verify ≤10 MB**; the 1500² PNG may be large, fall back to `size=og` if over |
| `tags-N-tag`                             | up to 5                                                                                                                                                                                     |
| `sections-N-{artist,song,start_time}`    | from §2.3 (`start_time` integer seconds)                                                                                                                                                    |

All field names/limits **verified** against live docs (panel M3). The success response body is **not documented** (likely a `{"result":{"success":true}}` envelope — treat as unverified, confirm on first live upload) and **carries no URL/key**: construct `/fluncle/<slug-of-name>/` and **read it back** via `GET https://api.mixcloud.com/fluncle/cloudcasts/` for the canonical URL (the coordinate in the title makes slugs effectively unique, so collision-resolution isn't the concern — the read-back is just to get the authoritative key, also needed for the edit endpoint). The CLI POSTs the resolved URL to `/api/admin/mixtapes/:id/mixcloud/finalize`; the Worker records + dual-writes + flips `distributing→published` if first.

### 4.3 Licensing — a runbook note, not a linter (scope-corrected)

The Featured-Artist (SRPC) rules (verified June 2026): **≤4 per artist (≤3 consecutive); ≤3 per release (≤2 consecutive)**; **4–8 tracks from one artist makes the show Premium/subscriber-only globally** (a hard paywall, distinct from regional consecutive-rule restriction); the waiver is rightsholder-only (not available to a curator). The runbook already calls compliance "trivial for a varied D&B set." → **Don't build a linter** (gold-plating for ≤54 lifetime uploads by one operator who controls his tracklists). Add a **runbook note** stating both failure tiers (regional-unavailable vs global-Premium-gate) so the operator keeps sets varied. If a show ever gets gated, it's observable on Mixcloud and fixable by hand.

### 4.4 Update semantics

Edit is `POST https://api.mixcloud.com/upload/<KEY>/edit/?access_token=…` (not PUT) — fixes tracklist/description/picture/`unlisted`; **cannot replace audio** (delete + re-upload). Posting any `sections-*`/`tags-*` overwrites the whole set — always send complete sets. Mixcloud has **no draft state** — only listed or `unlisted`. **Publish listed directly** (it's the licensed home; there's no Content-ID surprise to review against — unlike YouTube). (Decision reversed from the draft's unlisted-then-flip — symmetry for its own sake added a call + friction.)

## 5. The surfaces — CLI publishes; dashboard reviews

Both carriers hit the same `/api/admin/mixtapes/:id/…` routes (verified: `requireAdmin` accepts a `Bearer FLUNCLE_API_TOKEN` from the CLI **or** the signed `fluncle_admin` cookie from the dashboard — `apps/web/src/lib/server/env.ts:106-120`).

- **CLI = the publish surface** (the local files live there): `fluncle admin mixtape distribute <logId> --video <mp4> --audio <m4a> [--youtube] [--mixcloud]` orchestrates mint→YouTube(initiate→PUT→finalize)→Mixcloud(POST→finalize), recording each result. Plus `fluncle admin mixtape publish-youtube <logId>` for the unlisted→public flip.
- **Dashboard `/admin/mixtapes` = review, not upload**: shows per-platform `mixtape_social_posts` status; offers **retry of a `failed` leg** for Worker-side operations and the **unlisted→public flip button** (server-side `videos.update`, the Worker has the token). It does **not** attempt browser multi-GB uploads (no precedent, no resume story). This is the coherent operator story the panel pushed: upload in one CLI command, review/flip from either surface.

## Sequencing & ownership

1. **Phase 0 (day one): data model + mint-first reshape + chapter helper + the status-predicate audit + tests.** Unblocks both platforms; independently shippable (publish still works, distribution routes follow).
2. **Phase 1 (YouTube) ∥ Phase 2 (Mixcloud)** — two agents after Phase 0. Each: OAuth/token provisioning, the route(s), the platform module (`youtube.ts` / `mixcloud.ts`), CLI wiring, dashboard status/flip, tests, runbook update.
3. **SoundCloud — deferred** (external gate); manual paste path stays; enum widens with no migration.

**Biggest de-risker:** Phase 0's mint-first transaction + the `status='published'` predicate audit. Get "mint to `distributing`, cover renders, public hides it, first link publishes, retry reuses the Log ID" right and the rest is mechanical capability-handoff. **Deploy:** the migration auto-applies in the Cloudflare build (Turso auto-migrate); no manual prod `db:migrate`.

## Decisions (resolved with the operator) + accepted design notes

All settled — no open human decisions block the build:

1. ✅ **YouTube channel verification — done.** `@fluncle` is phone-verified, so >15 min uploads + custom thumbnails work. (Was the one hard precondition.)
2. ✅ **Accepted: the YouTube access-token handoff.** The data PUT needs a Bearer token, so the Worker mints a short-lived (~1 h) access token and hands it to the CLI alongside the session URI; the durable refresh token stays server-side. Operator-approved — not a task, just the acknowledged trade-off (unavoidable for a client-side upload of a file the Worker can't proxy).
3. ✅ **Mixcloud token lives in the CLI env**, upload CLI-direct at full quality. Provisioned via the `fluncle admin auth mixcloud` paste helper (§4.1), honoring `--env`. (The draft's Worker-proxy + 192 kbps down-encode is rejected.)
4. ✅ **Audio master needs no R2.** Under CLI-direct Mixcloud the CLI uploads from local; skip the R2 copy unless an archive is wanted later (nice-to-have, not on the critical path).

(The earlier "confirm thumbnail/picture sizes" item is **not** a human decision — it's a build-time check, now in Acceptance criteria.)

## Acceptance criteria

- **Phase 0:** `mixtape_social_posts` migration applies; `publishMixtape` mints to `distributing` (unit test: the cover endpoint renders a `distributing` mixtape; public `/api/mixtapes` and `/log` exclude it); a simulated total-upload-failure leaves the mixtape `distributing` with its Log ID held and **no public exposure**; first successful finalize flips to `published`; the chapter helper passes its unit tests; `mixtapeDescription(note, logId)` appends `\n\nfluncle://<logId>` and never mutates the stored note (unit-tested); the cap pre-check rejects at 55.
- **Phase 1:** `fluncle admin auth youtube` stores a refresh token; `distribute --video` resumably uploads a multi-GB file (with the Bearer token, surviving a mid-upload `401` via re-mint) and the video appears **unlisted** with the wide thumbnail, the title, the description ending in `fluncle://<logId>`, and ≥3 chapters; `publish-youtube` flips it public; `mixtape_social_posts(youtube)` + `mixtapes.youtube_url` written; `/log` shows the link and the note stays clean (no `fluncle://` marker internally). Build-time check: the thumbnail PNG is ≤2 MB (fall back to a `size=thumb` variant if over).
- **Phase 2:** `MIXCLOUD_ACCESS_TOKEN` provisioned CLI-side via `auth mixcloud`; `distribute --mixcloud` uploads the full-quality master with `sections[]`, the square cover, and the description ending in `fluncle://<logId>`, reads back the key, records + dual-writes `mixtapes.mixcloud_url`; published listed. Build-time check: the picture PNG is ≤10 MB (fall back to `size=og` if over).
- **Cross-cutting:** retry of a `failed` leg reuses the committed Log ID; the dashboard shows status + flips YouTube public; `docs/fluncle-mixtapes-runbook.md` Phase C/D rewritten (incl. the corrected quota model + the SRPC two-tier note); `bun run --cwd apps/web typecheck && lint && build` and `bun run --cwd apps/cli typecheck` green; new server logic unit-tested.

## Risks & open questions

- **YouTube access-token expiry during a multi-GB upload** — handled by `401`→re-mint→resume-at-offset; the one real fragility in the YouTube path. The session URI itself can also `410 Gone` → re-initiate.
- **Crash between YouTube PUT success and finalize** — leaves a live unlisted video (correct coordinate) + a `uploading` row; retry may create a duplicate unlisted video needing manual cleanup (acceptable at cadence; reconcile-via-search is a future nicety).
- **`distributing` status predicate audit** — if any `status='published'` call site is missed, either the cover fails to render (too strict) or a linkless mixtape leaks public (too loose). The two-helper approach (`getMixtapeForRender` vs `listPublicMixtapes`) contains this.
- **Mixcloud token revocation** — not auto-expiring per se, but revocable; handle the invalid-token error with a re-auth prompt.
- **Mixcloud success-body shape unverified** — confirm on first live upload; the read-back gets the authoritative URL regardless.
- **Worker cannot proxy multi-GB media** (128 MB memory / 100 MB body) — both uploads are CLI-direct, so this is sidestepped, not fought.
- **YouTube Content ID** / **Mixcloud Premium-gating** / **SoundCloud** — content/external realities, surfaced honestly above.

## Appendix — verifications & sources

**Panel corrections folded in:** (C1) YouTube session URI is **not** self-authorizing — the data PUT requires `Authorization` ([resumable upload protocol](https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol)); the draft's GCS analogy was wrong. (Worker) the 128 MB isolate limit + no multipart precedent forces Mixcloud CLI-direct. (Ordering) mint-first (the cover endpoint 404s non-published rows; the asset must embed the real coordinate). (C2) `videos.insert` quota moved to a separate Video Uploads bucket (~100/day) on 4 Dec 2025 ([revision history](https://developers.google.com/youtube/v3/revision_history)). (H2) `youtube.upload` covers insert + unlisted + thumbnails.set. (H3) channel verification is a hard precondition. (H4) Mixcloud tokens are revocable, not documented-immortal. (M1) the 4–8-per-artist global-Premium tier. (M3/M4) Mixcloud field shapes + the videoId-in-PUT-response are verified correct.

**Live code verifications (worktree `feat/mixtapes-admin-polish`):** track-video three-phase R2 flow (`apps/cli/src/commands/track.ts:115-188`, `r2-presign.ts:44-85`, the video uploads/finalize routes); `requireAdmin` two carriers (`env.ts:106-120`); the signed admin cookie (`admin-auth.ts`); Spotify auth (`spotify_auth` `schema.ts:65-71`, `api/admin/spotify/auth/{start,callback,login}.ts`, CLI `commands/auth.ts`); `publishMixtape` + the mint CTE + the gate (`server/mixtapes.ts:239-328`); `MixtapeStatus` (`mixtapes.ts:4`); the cover endpoint's published-only `getMixtapeByLogId` (`api/mixtape-cover.$logId.ts:63`); `social_posts` + `social.ts` (`upsertPost`/`updateSocialStatus`); `getTracksForMixtape` (`tracks.ts:273-288`); the env allow-list (`server/env.ts`); the surfaces reading `externalUrls`; migration journal next idx 18.

**External sources (June 2026):** [YouTube resumable uploads](https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol) · [videos.insert](https://developers.google.com/youtube/v3/docs/videos/insert) · [YouTube quota revision history](https://developers.google.com/youtube/v3/revision_history) · [>15-min verification + 256 GB/12 h](https://support.google.com/youtube/answer/71673) · [custom thumbnail verification](https://support.google.com/youtube/answer/72431) · [Mixcloud API](https://www.mixcloud.com/developers/) · [Mixcloud Featured Artist Rules](https://help.mixcloud.com/hc/en-us/articles/360004031080) · [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/) · [SoundCloud API guide](https://developers.soundcloud.com/docs/api/guide) (deferred).
