# Video variants and on-the-fly transforms

How one finding's footage reaches every surface (web Stories, the `/log` page, `radio.fluncle.com`, YouTube, TikTok) from the fewest stored files. The short version: **store two masters per finding, derive every other shape on the fly with Cloudflare Media Transformations (MT).** This is the decision record the render pipeline, `media.ts`, the presign allow-list, and the catalogue backfill build against.

## The three cost tiers

Each variant is produced at the cheapest tier that can make it:

1. **Re-render in Remotion** — minutes of GPU, a stored R2 file. The only things that genuinely need this are baked **pixels**: the aspect (a portrait composition vs a landscape one) and the baked **text** (the TypePlate identity/telemetry + CloseCard, present or absent).
2. **Cloudflare Media Transformation** — free, on the fly, no stored file. Derives the resolution ladder, the poster frame (`mode=frame`), an aspect crop (`fit=crop`), and audio removal (`audio=false`), all from one stored master, with the input asset cached across variants.
3. **Browser overlay** — free, no file. On Fluncle's own DOM surfaces (`/log`, radio) the page draws its own metadata over clean footage, so those surfaces never need a baked-text file.

Audio is never a render and never needs its own file. Orientation is never a render when a square master exists. Text is the only thing that ever forces a second render.

## The two stored masters

Per finding, in `found.fluncle.com/<log-id>/`:

- **`footage.mp4`** — square `1920×1920`, audio, **clean (no text overlay)**. The source master. Nothing plays it as a square; MT crops it to portrait or landscape and strips its audio on demand. It must be clean because baked text cannot survive a crop (see below).
- **`footage.social.mp4`** — portrait `1080×1920`, audio, **baked text** (TypePlate + CloseCard). The playable social cut: the homepage Stories experience, YouTube as-is, and TikTok with audio stripped.

`footage-silent.mp4` is retired — TikTok's silent upload is `footage.social.mp4` served through an `audio=false` MT URL, so the silent variant no longer exists as a file.

`cover.jpg` (profile-grid cover) and `poster.jpg` are unchanged; the `/log` poster can also be derived from a master via MT `mode=frame`.

### Render-flag provenance (`render.json` `variants`)

The two masters are the **same composition + props** rendered with **different flags** — `footage.mp4` is `{ aspect: "square", hideOverlay: true }` and `footage.social.mp4` is the portrait default `{ aspect: "portrait", hideOverlay: false }`. Those flags live in the render scripts, not the bundle, so the stored bundle alone would naively re-render the portrait cut. The bundle `render.json` therefore records a `variants` map keyed by output filename → its render flags:

```jsonc
"variants": {
  "footage.mp4":        { "aspect": "square",   "hideOverlay": true },
  "footage.social.mp4": { "aspect": "portrait", "hideOverlay": false }
}
```

This makes `render.json` self-describing: a future clean re-render from source is `render(composition, props, variants["footage.mp4"])` for the square master (and `variants["footage.social.mp4"]` for the social cut), so it can't accidentally reproduce the wrong cut. Every writer of the bundle `render.json` derives `variants` from one shared helper (`buildVariants()` in `packages/video/src/remotion/variants.ts`) so the canonical flags can't drift; a writer that produces only one master records only that master's entry.

## What MT derives on the fly

All from the square `footage.mp4` master unless noted. URL construction lives in `apps/web/src/lib/server/media.ts` (the existing resolution-ladder + poster deriver extends to these); option strings:

- **Landscape clean** (`/log` desktop, radio desktop): `fit=crop,width=1920,height=1080`
- **Portrait clean** (`/log` mobile, radio mobile): `fit=crop,width=1080,height=1920`
- **Audio-stripped** (TikTok, from `footage.social.mp4`): `audio=false`
- **Resolution ladder** (any surface): `width=360|480|720|1080`
- **Poster frame**: `mode=frame,time=<t>`

Cost is negligible: MT bills $0.50 per 1,000 monthly **unique** transformation operations with 5,000 free per month, so with `Cache Everything` + a long TTL on the MT URLs, each unique crop is one billed op per month and we likely never leave the free tier.

## Surface → asset map

The governing principle: **Stories are a social-post format (text baked in); `/log` and radio are archive/player surfaces where the page owns the chrome (clean footage, responsive orientation).**

| Surface               | Asset                                | Orientation                                          |
| --------------------- | ------------------------------------ | ---------------------------------------------------- |
| Homepage feed Stories | `footage.social.mp4`                 | portrait, always (Stories = a social post)           |
| `/log/<id>` page      | square master, MT-cropped            | landscape on desktop, portrait on mobile             |
| `radio.fluncle.com`   | square master, MT-cropped            | full-screen landscape on desktop, portrait on mobile |
| YouTube Shorts        | `footage.social.mp4`                 | portrait, pushed as-is                               |
| TikTok (via Postiz)   | `footage.social.mp4` + `audio=false` | portrait, silent so the operator adds TikTok audio   |

Consequence to confirm in the UI slice: today `/log` plays the text portrait; under this model `/log` plays the **clean** crop (the page already shows the Log ID, prose, and metadata, so the overlay is redundant there). The desktop landscape is the deliberate "show off the asset" moment.

## The square-crop quality dial

`fit=crop` is a **center crop**. A `1920×1920` square keeps both the `1080×1920` and `1920×1080` crops at native resolution (no upscale), but only the center "plus/cross" of the square is ever seen — the four corners never appear in either crop. So compositions destined for cropping must keep their centre of gravity centered.

A center-crop is **not** the bespoke 16:9 reflow a dedicated landscape render produces. For abstract shader vehicles (fbm/flow/voronoi fields) the crop reads beautifully; for vehicles with a strong off-centre subject it can feel arbitrary. Play it by ear: when a crop fails the eye test, render a dedicated **`footage.landscape.mp4`** (landscape, clean, audio) for that finding and let `media.ts` prefer it over the cropped square. That file is the escape hatch, not the default.

## Constraints and watch-items

- **MT input ≤ 100 MB, output ≤ 1 min, input must be MP4 H.264 + AAC/MP3.** A `1920×1920` master is heavier than a portrait one, so keep its CRF in check — the existing masters already flirt with the cap.
- **Crop is centered only** — no focal/gravity control is confirmed for video MT, so off-centre action means a re-render, not a crop.
- **Square comps must read at 1:1** — the square render has to look composed as a square, not a stretched portrait, for the crops to hold.

## Migration (the gradual, per-finding cutover)

Redefining `footage.mp4` from portrait to square is **stateful and gradual** — the square backfill renders per-track over time, so at any moment some findings carry the old portrait `footage.mp4` and some carry the new square. A finding's layout is therefore a **per-finding signal**, not a global flag: the `video_squared_at` column on `tracks` (an ISO timestamp). Set → `footage.mp4` is the clean square master and `footage.social.mp4` rides alongside; null → the legacy single-file layout (`footage.mp4` is the old portrait+text cut). The video finalize/upload path stamps it when a bundle carries BOTH the square `footage.mp4` and the portrait `footage.social.mp4` (the CLI signals `squared`); the footage→social rename migration never stamps it, because that copy alone doesn't make `footage.mp4` square.

Consumers read the signal and fall back, so deploying the consumer code changes nothing for un-migrated findings:

- `media.ts` exposes the square-crop helpers (`videoCrop` → `fit=crop` portrait/landscape) + `videoAudioStripped` (`audio=false`) + `socialVideoUrl`; callers reach for the crops/social cut **only when `videoSquaredAt` is set**.
- `/log` and `radio.fluncle.com`: squared → an MT centre-crop of the square (clean, the page owns the chrome); un-squared → today's `footage.mp4` portrait rendition. Radio additionally strips the audio (`videoAudioStripped`) so its only sound is the observation, and plays only squared+observed findings (the `get_random_radio_track` eligibility filter).
- Stories / YouTube / TikTok: squared → `footage.social.mp4` (TikTok via `audio=false` MT); un-squared → `footage.mp4` (its old portrait+text cut) + `footage-silent.mp4`.

The ordered rollout (run, don't merge-and-pray):

1. **Throwaway script** (`apps/web/scripts/migrate-footage-social.ts`, `--dry-run` first): for every finding with a video, server-side R2-copy `footage.mp4` → `footage.social.mp4` (no re-render — today's `footage.mp4` is already the social cut's spec). Idempotent; does NOT set `video_squared_at`.
2. **Deploy the consumer code** (this slice): the signal-gated `media.ts` + players + publish push + the `footage.social` presign allow-list entry. With every finding now carrying a `footage.social.mp4` but no `video_squared_at`, every consumer still serves the legacy path — a no-op deploy by design.
3. **Backfill the squares**, per-track over time: re-render each finding's square (`aspect=square`, clean) and `fluncle admin track video` it alongside the portrait social cut, which stamps `video_squared_at`. Each finding lights up the new layout the moment its square lands; the catalogue converts gradually with zero broken intermediate states.
4. **Cutover cleanup** (after the catalogue is fully squared): drop `footage-silent.mp4` from the presign allow-list + stop shipping it, and retire the legacy fallback branches.

The presign allow-list keeps `footage-silent` accepted through steps 1–3 (back-compat for legacy bundles + pre-cutover ships); it's removed only at step 4.
