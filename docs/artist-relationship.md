# The artist relationship

Fluncle keeps a canonical **artist entity** (`artists`, keyed on the Spotify artist id) with a `track_artists` many-to-many and an identity graph (`artist_socials`). The full plan is [docs/rfcs/artist-relationship-rfc.md](./rfcs/artist-relationship-rfc.md); the RFC splits into two epics on one spine:

- **Epic A — the archive gets an artist.** The entity, resolution, the `/artist/<slug>` pages, and the SEO/AEO graph. No operator gates.
- **Epic B — the championing motion.** Fluncle-the-account acting outward: following the artists it features across platforms, plus the `/admin/artists` follow queue. Gated on a Spotify re-auth (the `user-follow-modify` scope, already deployed + re-authed).

This doc covers **Epic B (Unit 5) — the championing motion**. The entity + tables it builds on are Unit 1.

## The data model

`artist_socials` is the identity-graph store — one row per `(artist_id, platform)`:

- `platform` — the socials only (`spotify | youtube | soundcloud | instagram | tiktok | mixcloud | bandcamp | twitter | facebook | homepage`). The KG anchors (`mbid`, `wikidata_qid`) live as `artists` columns, not here.
- `status` — `auto` (MusicBrainz/operator, trusted) · `candidate` (Firecrawl-only, awaits a human glance) · `confirmed` (a candidate promoted). Only `auto`/`confirmed` render on the public artist page and are follow targets.
- `source` — `musicbrainz | firecrawl | operator`.
- `followed_at` — a single stamp: a platform is either API-followable or manual, and `platform` says which actor. Non-null means Fluncle has followed (or the operator registered a manual follow).

## The follow-writes (`follow_artist`, agent tier)

The championing motion's **automated** half. Only two platforms have a usable follow API:

- **Spotify** — `PUT /me/following?type=artist` (the `spotify_auth` grant carries `user-follow-modify`).
- **YouTube** — `subscriptions.insert` (the `@fluncle` Brand Account's `youtube.force-ssl` scope covers it). A stored `/@handle` URL is resolved to a stable `channelId` (`channels.list?forHandle=`) first; a `subscriptionDuplicate` error is the idempotent-done case.

**Mixcloud is cut to link-only** (its follow endpoint is undocumented since 2022); IG / TikTok / SoundCloud have no follow API — those are the manual queue.

`follow_artist` (`POST /admin/artists/follow`, agent tier) follows a bounded batch: `platform IN (spotify, youtube)`, `status IN (auto, confirmed)`, `followed_at IS NULL` (idempotent), oldest first, capped so a tick stays inside the platforms' quotas. On success it stamps `followed_at`; a per-target failure never aborts the batch. It returns `remaining` so the CLI/sweep can loop until the queue drains. `dryRun` reports what would be followed without calling the platforms or writing.

### The sweep

`fluncle admin artists follow` (the CLI) drains the batch, looping on `remaining`. The on-box **`fluncle-artist-follow`** Hermes cron (`docs/agents/hermes/scripts/artist-follow-sweep.{sh,ts}`, cloned from `context-sweep`) triggers it — the box holds no Spotify/YouTube tokens; the Worker does the calls. Registered in `@fluncle/registry` as `cron.artist-follow` (every 6h). Zero LLM tokens on the box.

## The `/admin/artists` follow queue (the manual motion)

Follows are per-artist, so the manual motion lives at the artist grain (not a per-track board column). `/admin/artists` reuses the retired `/admin/tag` shape: a worklist of artists with actionable work — a `candidate` to confirm, or a followable social not yet followed — one card per artist, deep links out to each profile. The operator taps out to follow, then **one-tap registers** it (`record_operator_follow` → stamps `followed_at`) and **confirms** a candidate (`confirm_artist_social` → `candidate → confirmed`, which also lets it onto the public page). Add/remove a platform inline: a Shadcn `Select` (the platform logo rendered next to `SelectValue`) + a URL `Input` → `add_artist_social` / `remove_artist_social` (an operator-entered link lands `source=operator`, `status=confirmed`).

### The board's automated-socials cell

The findings board's old **LFM** cell is repurposed into an **automated-socials** aggregate: the Last.fm love **+** the artist's Spotify/YouTube auto-follow state. `done` = every hands-off action taken, `partial` = some, `open` = none. A `Popover` (hover/focus) breaks it down per platform with a done check. The per-finding follow state is batched into the board's `fetchBoard` via `listArtistFollowsForTracks(ids)`. There is no per-track "Yours" follow column — follows are per-artist, owned by the queue.

## The ops (verb_noun; `packages/contracts/src/orpc/admin-artists.ts`)

| op                       | tier                       | path                                             |
| ------------------------ | -------------------------- | ------------------------------------------------ |
| `list_artist_socials`    | admin (agent-allowed read) | `GET /admin/artists/socials`                     |
| `follow_artist`          | agent (`adminAuth`)        | `POST /admin/artists/follow`                     |
| `record_operator_follow` | operator                   | `POST /admin/artists/socials/{socialId}/follow`  |
| `confirm_artist_social`  | operator                   | `POST /admin/artists/socials/{socialId}/confirm` |
| `add_artist_social`      | operator                   | `POST /admin/artists/{artistId}/socials`         |
| `remove_artist_social`   | operator                   | `DELETE /admin/artists/socials/{socialId}`       |

All six are enforced by the build-fail coverage tests (`orpc-admin-coverage` / `orpc-auth-coverage`) and the `orpc-naming` verb set. The server layer lives in `apps/web/src/lib/server/artists.ts` (queue + CRUD + the follow batch); the low-level follows in `spotify.ts` (`followSpotifyArtist`) and `youtube.ts` (`resolveYouTubeChannelId` + `subscribeToYouTubeChannel`).
