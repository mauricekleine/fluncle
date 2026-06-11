# Admin tagging — the vibe map

A fast, admin-gated web tool for placing each finding in **vibe-space**: where a banger sits by energy and mood, relative to the others. The placement groups findings into the four galaxies of Fluncle's Galaxy, and (later) becomes the training data that lets the enrichment agent auto-place new finds. See also [track-lifecycle.md](./track-lifecycle.md).

It deliberately does **not** use drum & bass sub-genres. There's no finite, agreed sub-genre list, and "is this techstep?" is an argument; "is this floatier than that one?" is answerable. Placement is relative, which is what makes review fast and consistent.

## The vibe space

Two axes, stored as a coordinate per track (`vibe_x`, `vibe_y`, roughly `-1..1`):

- **X — mood:** Light ← → Dark
- **Y — energy:** Floaty ↓ ↑ Driving

The four quadrants are the four galaxies (the galaxy is _derived_ from the coordinate's sign — `vibeQuadrant()` in `vibe-map.tsx`), each with its own colour:

```
            ▲ DRIVING
     SOLAR    │   NEBULAR        Solar   = driving + light  (gold)
  dancefloor  │   neuro · dark   Nebular = driving + dark   (crimson)
 LIGHT ───────┼─────── DARK ▶    Lunar   = floaty + light   (blue)
     LUNAR    │   DEEP           Deep    = floaty + dark     (violet)
  liquid      │   dubwise
            ▼ FLOATY
```

(_Solar / Nebular / Lunar / Deep_ are working names — final naming is a VOICE pass.)

## How it works

- **Route:** `/admin/tag` (gated). Login at `/admin/login`, sign out at `/api/admin/logout`.
- **Queue:** oldest-first tracks where `vibe_x` is null (unplaced). A toggle flips to placed tracks (newest-first) to review or move them.
- **Place:** pick a track, then click or drag its marker onto the map. Already-placed findings show as faint coloured dots so you place **relative** to them (hover a dot for its title).
- **Save & next:** writes `(vibe_x, vibe_y)` via the existing `PATCH /api/admin/tracks/:id` and advances. Save is disabled until you've placed the marker.

## Logging in

Auth is **one identity, two carriers**: the CLI/agent send `FLUNCLE_API_TOKEN` as a `Bearer` header; the browser carries a signed grant **cookie** (`{ role: "admin" }` HMAC'd with the same token — the token is the signing key, never the cookie value). `requireAdmin` accepts either.

The browser proves identity with **Login with Spotify**, allow-listed to the operator account (email `kleine.m.r@gmail.com`, or Spotify id `berry_fudge` — see `admin-auth.ts`). The login reuses the Spotify app's already-registered redirect URI (`/api/admin/spotify/auth/callback`, which branches on `state.purpose`); it exchanges the code only to read `/v1/me` and **discards the tokens** — it never touches the publish refresh token in `spotify_auth`. On success it sets the grant cookie (`Path=/`, 30-day window) and redirects to `/admin/tag`. The gate is active in dev too (just without `Secure` on localhost).

## The keyboard loop

| Key             | Action                                     |
| --------------- | ------------------------------------------ |
| `←` `↑` `↓` `→` | Nudge the marker (mood / energy)           |
| `Enter`         | Save & next                                |
| `K`             | Play / pause the preview                   |
| `[` `]`         | Previous / next track                      |
| `L`             | Toggle between "needs review" and "placed" |

Coarse placement is a click or drag on the map; arrows are for fine adjustment.

## Data model & what's next

- `tracks.vibe_x` / `tracks.vibe_y` (`real`, nullable). Null = unplaced. The galaxy is derived, not stored, so re-coloring or re-bucketing is a code change, not a migration.
- Sub-genres are gone end to end: the `tags_json` / `tags_source` columns, `normalizeTags`, the CLI `--tag` flags, and the enrichment agent's sub-genre suggestion were all removed. The agent now writes only `bpm` / `key` / `features`; the operator owns placement.
- **Deferred:** clustering the map when it gets crowded (100+ findings — single circles with hover); and audio-driven **auto-placement** once there's enough placed data to train on (the spectral feature vector in `features_json` already approximates these axes — brightness ≈ mood, onset-rate/energy ≈ the energy axis).
