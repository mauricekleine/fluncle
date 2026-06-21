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

## Migration (the one-time cutover)

Today's `footage.mp4` is already exactly `footage.social.mp4`'s spec (portrait, text, audio), so the rename is free and no re-render is needed for the social cut. Order matters:

1. **Throwaway script:** for every finding, R2-copy `footage.mp4` → `footage.social.mp4` (no re-render).
2. **Repoint consumers** to `footage.social.mp4` for the portrait playable: `apps/web/src/lib/server/media.ts`, the `/log` + Stories players, and the `VIDEO_ARTIFACTS` presign allow-list in `apps/web/src/lib/server/video-bundle.ts` (add `footage.social`; redefine `footage.mp4` as the square; drop `footage-silent`).
3. **Only then** render the square into `footage.mp4` (the catalogue backfill) and point `/log` + radio at the MT crops.

Step 3 must not land before steps 1–2, or a player briefly serves a square it expects to be portrait. The migration script is throwaway and runs once against the catalogue before the slice merges to `main`.
