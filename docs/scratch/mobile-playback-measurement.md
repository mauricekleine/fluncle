# MEASUREMENT — the mobile web-playback win (Cloudflare Media Transformation rendition vs raw master)

**Status: MEASURED (2026-06-25), live prod.** Closes the ROADMAP "Optimize web playback — verify the mobile win" item. This is the before/after the roadmap asked for: throttled-mobile bytes-on-load + time-to-first-frame for the Media-Transformation (MT) rendition path that `apps/web/src/lib/media.ts` serves, with the raw-master fallback measured for the delta. Numbers are real captures, not estimates.

## What was measured

Two live findings, both squared (two-master layout, `videoSquaredAt` set — so `/log` and Stories play an on-the-fly MT centre-crop of the clean square master, not a stored portrait file):

- **`020.0.5L`** — Ownglow "Do U?" (the first observation render; a heavy clip, raw master 82.95 MB).
- **`020.2.3D`** — "Dream Days" (a lighter clip, raw master 54.46 MB).

Two surfaces:

- **`/log/<id>`** (`LogFootage`, `apps/web/src/components/log/log-footage.tsx`) — a muted decorative loop, fetch deferred until near-viewport, poster = a cheap MT `mode=frame` JPEG. On mobile a squared finding requests `videoCrop(logId, "portrait")` at the **native 1080×1920** crop (no ladder width).
- **Homepage Stories** (`StoryView`, `apps/web/src/components/stories/story-view.tsx`, opened via `/?story=<id>`) — a full-bleed autoplaying reel. A squared finding requests `videoCrop(logId, "portrait", renditionWidth)`; on a full-viewport dialog the measured pane resolves to the **1080** rung, and the player preloads the next story's clip too.

Two throttle presets (Chrome DevTools definitions):

- **Slow 4G** — 400 Kbps down/up, 400 ms RTT.
- **Fast 4G** — 4 Mbps down, 150 ms RTT (the realistic everyday-mobile baseline).

Viewport: 390×844 @ dpr 3, mobile + iOS UA, **cache disabled** (cold visitor).

## Methodology

The shared chrome-devtools-mcp Chrome held its profile lock and dropped the MCP server's handle (a parallel browser session), and a second raw CDP connection to its page targets had its `*.enable`/`Runtime.evaluate` calls swallowed (session contention). So the measurement was driven against a **dedicated, isolated Chrome-for-Testing 149** (the binary puppeteer already cached) launched headless on its own debug port + a throwaway profile, with **no contention** with the MCP browser (which was left untouched). A small Bun CDP harness drove it directly over the WebSocket:

- `Emulation.setDeviceMetricsOverride` + `setUserAgentOverride` (mobile iPhone), `Network.setCacheDisabled`, `Network.emulateNetworkConditions` (the preset above).
- Per-request byte accounting from `Network.dataReceived` / `loadingFinished`, classified by URL (raw master `footage.mp4` vs MT crop `/cdn-cgi/media/fit=cover…` vs MT poster `…mode=frame…`).
- A 250 ms poll of the page: scroll the `<video>` into view (to trip the `/log` near-viewport gate), mirror the `poster=` attribute into an `Image()` to time the **first visual** (poster paint), and watch the `<video>` for the **first decodable frame** (`readyState ≥ 2` or `getVideoPlaybackQuality().totalVideoFrames > 0`). Cumulative bytes are snapshotted **at the first-frame instant** ("bytes on load"), not over a long tail.
- The **raw-master fallback** was forced with `Fetch.failRequest` on every `/cdn-cgi/media` _video_ transform (poster left alone), so the `<video>`'s one-shot `onError` drops to `footage.mp4` — the same path the component takes for a >100 MB straggler or any edge error.

100 s deadline per run. A run that never reaches a video first frame is reported as such (not faked).

## Results

### Per-asset full-file weights (the rendition-vs-master ceiling)

The MT crop the surfaces serve vs the raw master they fall back to (full-file `Content-Length`, `?v=1`):

| Asset                                                        | `020.0.5L`   | `020.2.3D`   |
| ------------------------------------------------------------ | ------------ | ------------ |
| raw square master `footage.mp4` (onError fallback)           | 82.95 MB     | 54.46 MB     |
| social cut `footage.social.mp4`                              | 63.37 MB     | 28.05 MB     |
| **MT portrait crop 1080×1920** (what `/log` + Stories serve) | **51.63 MB** | **27.47 MB** |
| MT portrait crop 720×1280 (smaller-pane rung)                | 10.36 MB     | 5.56 MB      |
| MT portrait crop 360×640 (smallest rung)                     | 0.80 MB      | 0.79 MB      |
| MT poster frame (jpg, first paint)                           | 0.25 MB      | 0.12 MB      |

The 1080 crop is **~50–62% of the raw master** for the same finding; the 720 rung is **~12–20%**; the poster frame is **~0.2–0.5%**. So the rendition path is unambiguously the lighter wire payload, and the win scales with how small a pane the surface can request.

### Throttled page loads — time-to-first-visual, time-to-first-frame, bytes on load

| Run                          | Surface / path | Throttle    | First visual (poster) | First video frame  | Video bytes → first frame          |
| ---------------------------- | -------------- | ----------- | --------------------- | ------------------ | ---------------------------------- |
| `020.0.5L` squared crop      | `/log`         | **Fast 4G** | 675 ms / 134 KB       | **2 943 ms**       | 6.29 MB                            |
| `020.0.5L` **forced master** | `/log`         | **Fast 4G** | 702 ms / 131 KB       | **4 478 ms**       | 6.52 MB                            |
| `020.2.3D` squared crop      | `/log`         | **Fast 4G** | (poster)              | **2 183 ms**       | 2.72 MB                            |
| `020.0.5L` squared crop      | `/log`         | **Slow 4G** | 3 973 ms / 84 KB      | **never (>100 s)** | — (watchdog bailed to master)      |
| `020.0.5L` **forced master** | `/log`         | **Slow 4G** | 4 003 ms / 81 KB      | **never (>100 s)** | 72.8 MB pulled, no frame           |
| `020.0.5L` Stories crop      | Stories        | **Fast 4G** | 4 521 ms              | **5 023 ms**       | 15.31 MB (active + preloaded next) |
| `020.0.5L` Stories crop      | Stories        | **Slow 4G** | 38 157 ms             | **41 426 ms**      | 19.71 MB                           |

### The headline deltas

1. **First visual is always fast and cheap — that's the poster-first design paying off.** On `/log` the MT poster frame (a single `mode=frame` JPEG) paints in **~0.7 s on Fast 4G** and **~4 s on Slow 4G**, costing **~80–134 KB**. The reader never stares at an empty pane while a multi-MB clip streams.

2. **The MT rendition reaches a playable video frame faster than the raw master — even when both eventually decode.** Fast 4G, `020.0.5L`: the 1080 crop hits first frame at **2 943 ms** vs the raw square master at **4 478 ms** — the rendition is **~1.5 s (34%) faster to first frame**. Bytes-to-first-frame are similar (6.29 vs 6.52 MB, both progressive), but the master's frames are bigger (1920×1920 vs 1080×1920), so more leading bytes must arrive before frame 1 decodes, and over a full loop the master keeps pulling its full 82.95 MB vs the crop's 51.63 MB.

3. **On a genuine Slow 4G (400 Kbps) link, the raw master is unwatchable and the rendition is borderline on `/log`.** The forced-master `/log` run pulled **72.8 MB and still never produced a video frame in 100 s**. The rendition `/log` run also failed to reach a frame — but because its **stall watchdog (`use-video-recovery.ts`) bailed the 1080 crop to the even-heavier raw master**, which then couldn't decode either. The poster still carried the visual throughout, so the page is never blank — but the muted loop effectively does not start at 400 Kbps when the surface requests the **native 1080** crop. (Stories, which keeps the same crop rendition instead of thrashing to the master, _did_ reach a frame on Slow 4G — at 41 s.)

## Verdict — is the mobile win real?

**Yes, with one honest caveat the numbers expose.** The MT-rendition path is the lighter, faster path on every axis measured: ~50% of the master's wire weight at 1080, far less at smaller rungs, a sub-second poster first-paint, and ~34% faster time-to-first-frame than the raw master at Fast 4G. The poster-first + deferred-fetch + range-stream design holds up on real throttled mobile.

The caveat is **not** about the rendition vs the master — the rendition wins there cleanly. It is that **`/log` mobile asks for the native 1080×1920 crop regardless of pane size** (`log-footage.tsx` calls `videoCrop(logId, "portrait")` with no width, unlike Stories which passes the measured `renditionWidth`). At 1080 the clip is too heavy to decode a frame on a true 400 Kbps link inside 100 s, and the stall watchdog makes it worse by swapping to the heavier master. The poster covers the visual, so nothing is broken — but the muted loop is effectively dormant on the slowest connections.

## Follow-up worth filing (out of scope for this docs-only measurement)

A small, well-scoped optimization the data points at: have `/log` mobile request a **pane-sized ladder rung** (e.g. the 720 crop — 10.36 MB vs 51.63 MB for `020.0.5L`) the way Stories already does, instead of the native 1080. The `useResponsiveWidth` hook and the `videoCrop(logId, orientation, width)` width argument already exist; `log-footage.tsx` line ~59 just doesn't pass them for squared findings. That would bring `/log` first-frame within reach on Slow 4G without touching the master or the encode. The stall watchdog's bail-to-master on a slow-but-progressing crop is also worth revisiting — on a constrained link the lighter crop is the better target than the master, not the worse one.
