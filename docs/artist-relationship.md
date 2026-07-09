# The artist relationship

Fluncle keeps a canonical **artist entity** (`artists`, keyed on the Spotify artist id) with a `track_artists` many-to-many and an identity graph (`artist_socials`). The archive gets an artist entity, resolution, the `/artist/<slug>` pages, and the SEO/AEO graph.

This doc covers the **identity graph** — how `artist_socials` is resolved, reviewed, and rendered into the public artist page + `sameAs` JSON-LD. The entity + tables it builds on are Unit 1.

> **The follow/champion motion was retired (2026-07-09).** Fluncle-the-account no longer follows the artists it features. The Spotify `user-follow-modify` write, the YouTube subscribe, the on-box `cron.artist-follow` sweep, the `followed_at`/`muted_at` state, and the follow/unfollow/mute/unmute ops were all removed — Spotify would not approve the app's artist-follow endpoint and the YouTube follows were too flaky to keep. What remains is the identity graph below: resolve → review → confirm → the public page.

## The data model

`artist_socials` is the identity-graph store — one row per `(artist_id, platform)`:

- `platform` — the socials only (`spotify | youtube | soundcloud | instagram | tiktok | mixcloud | bandcamp | beatport | twitter | facebook | homepage`). Beatport is a link-only store platform (the key DnB store/profile) — it was promoted out of the MB aggregator denylist to a first-class social. The KG anchors (`mbid`, `wikidata_qid`) live as `artists` columns, not here.
- `status` — `auto` (MusicBrainz/operator, trusted) · `candidate` (Firecrawl-only, awaits a human glance) · `confirmed` (a candidate promoted). Only `auto`/`confirmed` render on the public artist page + `sameAs`.
- `source` — `musicbrainz | firecrawl | operator`.

There is no follow/champion state on the row — the graph is purely who the artist is, not what Fluncle did about it.

## Resolution (`resolve_artist`, agent tier)

The box's `fluncle-artist-sweep` cron reads the resolve worklist (`list_unresolved_artists`) and calls `resolve_artist` per row: a MusicBrainz url-rels walk (→ `status=auto`, trusted) plus a Firecrawl gap-fill (→ `status=candidate`, operator-confirm before public). The gap-fill backfills **every missing social platform except `homepage` and `spotify`** (`instagram, tiktok, youtube, soundcloud, bandcamp, twitter, facebook, mixcloud, beatport`) — `homepage` is excluded because MB already covers it, and `spotify` is always known (it's the identity key). Everything Firecrawl returns lands as `status=candidate`, so the wider net stays behind the operator-review gate. `wikidata` classified during the MB walk is routed to the `wikidataQid` KG anchor on `artists`, not into `socials`.

The gap-fill spends the fewest Firecrawl credits by going cheapest-source-first: **(1)** scrape any **link hub** MB already carried — a `linktr.ee`/homepage — with one `/v2/scrape` JSON call (one page → every social it lists); the MB walk captures these hubs as scrape seeds rather than discarding them. **(2)** No MB hub → `/v2/search` for the artist's hub, then scrape it. **(3)** Still missing → a **disambiguated per-platform `/v2/search`** (`"<artist>" drum and bass <platform>` — the whole roster is DnB, which disambiguates hard against same-name acts in other genres), taking the first host-matching result that reduces to a profile root, guarded by a name-relatedness check on the platforms whose handle is the first path segment (so a bare-platform search can't attach a label/namesake account). The key insight: `/v2/scrape` and `/v2/search` act on **the URL you hand them** — the retired `/v2/extract` was fed the Spotify SPA (which lists no socials) and never polled its async job, so it returned nothing for every artist.

The MB walk finds the artist's MBID by **name search cross-referenced with the artist's Spotify URL** — the primary resolver: it queries `/ws/2/artist?query=artist:"<name>"`, deep-fetches each top candidate's `inc=url-rels`, and accepts the candidate whose MB Spotify url-rel's artist id equals the artist's stored `spotify_artist_id` (an exact identity match, accepted even over a higher-scored candidate). A candidate whose Spotify rel is present but DIFFERS is a namesake and is rejected. Only when NO candidate exposes any Spotify rel to cross-check does the walk fall back to a strong MB `score` (≥ 90) plus an exact normalized name match; otherwise the artist stays unresolved rather than resolve to a namesake (a wrong social link on a public artist page is worse than a missing one). The earlier ISRC→recording→artist-credit MBID lookup was **retired** — DnB ISRCs are frequently absent from MB's index and the walk landed on empty/wrong MBIDs, so most artists resolved to zero socials.

The worklist is **self-healing**: `list_unresolved_artists` returns artists with `resolved_at IS NULL` PLUS artists resolved to zero socials whose stamp is older than 30 days, so a transient MB failure (a 503 window, a namesake not yet disambiguated, an artist MB has since gained a Spotify rel for) re-tries at most once per window instead of sticking on 0 socials forever. Artists that already have socials are never re-queued. For an IMMEDIATE flush of a freshly-stamped empty backlog (which the 30-day window wouldn't touch yet), the operator runs `bun run apps/web/scripts/requeue-empty-artists.ts --confirm` (dry-run without `--confirm`), which clears `resolved_at` for every artist with zero `artist_socials` rows.

## The `/admin/artists` review queue (the manual motion)

`/admin/artists` is the stable MANAGE surface for every artist Fluncle features — one card per artist, name-sorted. The **review model** (ratified 2026-07-08): "needs a look" means Fluncle FOUND links the operator hasn't seen yet. **"Looks good"** (`review_artist`) stamps the whole list seen AND promotes any surviving `candidate` links to `confirmed` (reviewing the list IS the trust gate that lets a link onto the public page + `sameAs`); a link discovered LATER re-arms the flag (`artistNeedsLook`, off `reviewed_at` vs each link's `created_at`). Add/remove a platform inline behind the **Manage links** dialog: a Shadcn `Select` (the platform logo next to `SelectValue`) + a URL `Input` → `add_artist_social` / `remove_artist_social` (an operator-entered link lands `source=operator`, `status=confirmed`). The WORK surfaces as an `/admin` attention row (source `artist-review`) that deep-links here with `?artist=<id>`, auto-expanding that artist.

### The board's automated-socials cell

The findings board's old **LFM** cell is repurposed into an **automated-socials** aggregate showing the Last.fm love (`done` once the backfill RAN). A `HoverCard` reveals the breakdown. There is no per-track artist column — the identity graph is per-artist, owned by the `/admin/artists` queue.

## The ops (verb_noun; `packages/contracts/src/orpc/admin-artists.ts`)

| op                      | tier                       | path                                             |
| ----------------------- | -------------------------- | ------------------------------------------------ |
| `list_artist_socials`   | admin (agent-allowed read) | `GET /admin/artists/socials`                     |
| `confirm_artist_social` | operator                   | `POST /admin/artists/socials/{socialId}/confirm` |
| `add_artist_social`     | operator                   | `POST /admin/artists/{artistId}/socials`         |
| `remove_artist_social`  | operator                   | `DELETE /admin/artists/socials/{socialId}`       |
| `review_artist`         | operator                   | `POST /admin/artists/{artistId}/review`          |

All are enforced by the build-fail coverage tests (`orpc-admin-coverage` / `orpc-auth-coverage`) and the `orpc-naming` verb set. The server layer lives in `apps/web/src/lib/server/artists.ts` (queue + CRUD + review); resolution in `artist-resolution.ts`.
