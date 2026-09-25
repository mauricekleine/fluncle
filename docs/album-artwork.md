# Album & artist artwork — the owned cover master

How Fluncle serves cover art. The rule is **own a bounded display derivative, never hotlink and never store the original.** Every album and every artist gets ONE ≤1200²-capped cover master in Fluncle's own R2, served at any display size through Cloudflare Images. This is the RFC-U3b half of the artwork story; the video render's full-res, render-time-only path is [docs/video-variants.md](./video-variants.md) territory. It is the album/artist cousin of the label logo ([docs/label-entity.md](./label-entity.md)).

## The master model

- **One derivative per entity**, stored world-readable at `albums/<slug>.<ext>` / `artists/<slug>.<ext>` in the existing `fluncle-videos` bucket (behind found.fluncle.com) — no new bucket, the label-logo precedent.
- **Capped at 1200² on the longest side.** Every source is REQUESTED at a ≤1200 rendition (the substitution/thumbnail IS the downscale — no local resize), and a byte-level dimension read (`readImageSize` in `cover-masters.ts`) REJECTS anything larger before the R2 put. The two together make "no un-downscaled original in R2" structural, not aspirational.
- **The 3000² original is never stored or served.** The video render still fetches Apple's full-res at render time, in-memory, never persisted (U3a's `artworkMaxUrl`). Stored 1200 for the web, ephemeral 3000 for the films.

### The REF-05 line

REF-05 keeps third-party full-resolution copyrighted media out of the world-served bucket. Store only the ≤1200² display derivative; fetch full-resolution Apple artwork ephemerally for video rendering.

## The source ladder (best source wins)

The `backfill_cover_masters` sweep (`apps/web/src/lib/server/cover-masters.ts`) resolves each entity up its ladder, stamping `image_source`:

**Album:**

1. **`apple`** — Apple's STORED artwork template (`albums.artwork_url_template`, written by U1), substituted to ≤1200 and native-clamped by `appleArtworkUrl`. No live Apple API call; no local resize.
2. **`coverart`** — Cover Art Archive by MB release. The crawler stores a `coverartarchive.org/release/<mbid>/front-500` URL on catalogue rows; the sweep requests `front-1200` (CAA's own ≤1200 thumbnail).
3. **`spotify`** — the stored `tracks.album_image_url` (i.scdn.co) at its largest 640 prefix. The floor.

**Artist:**

1. **`spotify`** — the stored `artists.image_url` (Spotify's largest profile image, ≤640). The floor and, today, the only rung. An Apple artist-artwork template is the future higher-res source decision A leaves room for; it would slot in above.

An entity with no usable source is terminal `image_state='none'` and falls through to the raw URL — nothing regresses.

## Serving (Cloudflare Images)

Account portraits use a separate `avatars/<session-user-id>.<ext>` key in the public R2 bucket. The binary upload route derives the owner from the session, requires a same-origin request and a valid CSRF token, and checks MIME type, byte size, and intrinsic dimensions before writing. The served image URL carries a version query so an overwrite cannot show a stale face; removing a portrait clears the database URL while the object may be overwritten by a later upload.

Owned masters are served through **Cloudflare Images URL transforms** (`/cdn-cgi/image/…` — a SEPARATE zone toggle from the video `/cdn-cgi/media` one; decision B, source restricted to this zone). The URL shape (verified against the [Cloudflare Images docs](https://developers.cloudflare.com/images/optimization/features/), URL interface — `<ZONE>/cdn-cgi/image/<OPTIONS>/<SOURCE>`):

```
https://found.fluncle.com/cdn-cgi/image/width=640,format=auto/https://found.fluncle.com/albums/<slug>.jpg?v=<image_updated_at>
```

- **The fixed ladder is 64 / 300 / 640 / 1200** (`OWNED_COVER_WIDTH` in `media.ts`). `ownedCoverUrl` builds the base at 640; `albumCoverAtSize(url, size)` rewrites the `width=` to `small`/`tile`/`medium`/`large`/`xl` at each surface — and it also still resizes a Spotify URL, so every existing call site upgrades for free.
- **A pending Cover Art Archive fallback uses CAA's own thumbnail ladder.** `albumCoverAtSize` maps its release-front URL to 250px for small and hub tiles, 500px for medium covers, and 1200px for xl; large preserves the stored URL used by the lead and full-size artwork. The owned master remains preferred; Cloudflare Images transforms accept only our own zone, so CAA's 250px thumbnail is the smallest available fallback.
- **A failed cover falls back to the eclipse artwork.** `TrackArtwork` checks the image element on mount because a third-party image can fail before React hydrates and its `onError` handler attaches. It compares the browser's absolute `currentSrc` with an absolute form of the requested URL, and retries when that URL changes.
- **The DTO prefers the owned master server-side.** `bestAlbumCoverUrl` / `bestArtistAvatarUrl` return the CF Images URL once the sweep resolved one, else the Spotify chain (the label `logoKey ?? image_url` precedent). The finding DTO (`toLeanTrackListItem`) emits it as `albumImageUrl`, so **web, mobile, and the video pipeline all upgrade at once** — no consumer changes.
- **The `?v` bust.** A replaced master bumps `image_updated_at`; the `?v=<epoch>` rides the source URL, so Cloudflare re-keys every rendition. A transform cache survives a zone purge (the video-variants lesson), so the `?v` is the ONLY reliable rendition eviction.

## The sweep (agent-tier, Worker-paced)

`backfill_cover_masters` (agent tier, the `backfill_label_images` precedent) drains a bounded `pending` worklist per kind, slug-cursored, with per-entity reliability on the row (`image_state` / `image_attempted_at` / `image_failures`). The on-box `fluncle-cover-masters` host timer (60m) runs both kinds per tick. Repo half ships; box enable is operator-gated — see [docs/agents/hermes/cover-masters-timer/README.md](./agents/hermes/cover-masters-timer/README.md).

```bash
fluncle admin backfills cover-masters --kind album  --dry-run   # eligible ALBUM worklist; no writes
fluncle admin backfills cover-masters --kind artist --dry-run   # eligible ARTIST worklist; no writes
```

### The operator heal (`--retry-none`)

A terminal `image_state='none'` is a permanent give-up: the entity had no usable source when the sweep last walked its ladder, so it hotlinks the stored third-party raw URL forever — and when that third party goes down (the Cover Art Archive / archive.org 503 outage class), the public page renders a broken cover. `--retry-none` is the one-command heal for the case where a source EXISTS now but did not then (a fresh Apple `artwork_url_template`, or a recovered Cover Art Archive): it FIRST re-queues a bounded, slug-ordered batch of the kind's terminal `none` rows back to `pending` (kind-scoped `UPDATE ... SET image_state='pending', image_failures=0, image_attempted_at=NULL` — a `resolved` or `pending` row is never touched), then runs the normal bounded pass in the SAME call so a manual burn re-walks the ladder and mints the owned master immediately. `--dry-run --retry-none` reports which slugs WOULD re-queue without writing; the re-queued count rides back on `requeued`/`requeuedCount`.

```bash
fluncle admin backfills cover-masters --kind album --retry-none --dry-run   # what WOULD re-queue
fluncle admin backfills cover-masters --kind album --retry-none             # heal: re-queue + re-walk
```

## Operator verification

The Cloudflare Images zone toggle (decision B) is ON, but confirm a transform actually serves in prod after the first masters resolve (any resolved `albums/<slug>.<ext>` key):

```bash
# 1. The bare master resolves (R2 behind found.fluncle.com):
curl -sI 'https://found.fluncle.com/albums/<slug>.jpg' | head -1        # → 200

# 2. The Cloudflare Images transform serves a resized, format-negotiated rendition:
curl -sI 'https://found.fluncle.com/cdn-cgi/image/width=300,format=auto/https://found.fluncle.com/albums/<slug>.jpg' \
  | grep -iE '^(HTTP|content-type|cf-)'
# → HTTP 200, content-type image/webp (or image/avif), NOT a 404/redirect.
```

A 404 or a pass-through of the original `content-type` (never `image/webp`) means the zone toggle is off or the source is not on the allowed zone — the DTO still works (it falls back to the Spotify chain), but the owned masters are not being served until it is fixed.
