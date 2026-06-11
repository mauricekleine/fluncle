# Web-overhaul "before" baseline — captured 2026-06-11

The before/after reference for the web-overhaul RFC (docs/web-overhaul-rfc.md §9). Re-run the same probes after each unit deploys.

## Canonicals (live, curl)

| Page                                | Canonicals | Values                                                                  |
| ----------------------------------- | ---------- | ----------------------------------------------------------------------- |
| www.fluncle.com/                    | 1          | `https://www.fluncle.com/` (correct)                                    |
| www.fluncle.com/stories/004.7.2I    | **2**      | `https://www.fluncle.com/` + `https://www.fluncle.com/stories/004.7.2I` |
| www.fluncle.com/stories             | **2**      | `https://www.fluncle.com/` + `https://www.fluncle.com/stories`          |
| www.fluncle.com/galaxy              | **2**      | `https://www.fluncle.com/` + `https://www.fluncle.com/galaxy`           |
| galaxy.fluncle.com/                 | **2**      | `https://www.fluncle.com/` + `https://www.fluncle.com/galaxy`           |
| galaxy.fluncle.com/stories/004.7.2I | **2**      | `https://www.fluncle.com/` + `https://www.fluncle.com/stories/004.7.2I` |

`og:url` is singular everywhere (one per page, leaf value) — confirmed NOT a bug. Leaf canonicals are already absolute `www` URLs, so deleting the root canonical also resolves the galaxy host to "canonical → www equivalent" (the §8 decision).

`/log/004.7.2I` → 404 (route absent). Sitemap lists only `/` (with a real max(added_at) lastmod). JSON-LD: home has `MusicPlaylist` + 10 `MusicRecording`; `/stories/<id>` has none.

## robots.txt + AI crawlers (live)

- Live `/robots.txt` on both hosts matches the repo file (Cloudflare managed robots is OFF). Content-Signal `search=yes, ai-input=yes, ai-train=yes` is served.
- **AI-crawler block at Cloudflare (the missed blocker is real):** spoofed-UA probes from a residential IP: GPTBot → 403, ClaudeBot → 403, PerplexityBot → 403, OAI-SearchBot → 403, while Google-Extended → 200, bingbot → 200. The asymmetry points at Cloudflare's AI-crawler block (default-on since 2025-07-01), not generic fake-bot detection. **Needs a Cloudflare dashboard change (Maurice-confirmed) — robots.txt `Allow` cannot override a WAF/AI-Crawl-Control block.**

## Search/AI probe answers (before)

- Google/Bing-backed web search for `"004.7.2I" fluncle`: fluncle.com homepage surfaces (the token appears in feed SSR), **no story/log page** in results. Bare-token retrieval: failing, as the RFC states.
- "who is Fluncle drum and bass": fluncle.com + galaxy.fluncle.com surface with the tagline; no third-party corroboration; the assistant cannot say who/what Fluncle is beyond the tagline.
- `"fluncle://" log ID meaning`: only galaxy.fluncle.com surfaces (via the game's meta description "every banger is a star at its Log ID coordinate"); no decode answer available.
- **galaxy.fluncle.com is already indexed and ranking alongside www** — the duplicate-host problem is live, not theoretical.

## Performance (before)

Lighthouse 12.x, headless Chrome, mobile defaults, against https://www.fluncle.com/ (2026-06-11):

- **LCP 5.6 s** (element: the cover `<img>` — `fluncle-cover.webp`; cover art is LCP as canon requires)
- FCP 2.6 s · TBT 0 ms · CLS 0 · Speed Index 4.0 s · perf score 0.74
- Field note: warm-cache TTFB ~320–500 ms; cover.webp responseEnd ~280 ms.

After-gate: LCP element stays the cover image and the Lighthouse LCP does not regress (same methodology: `npx lighthouse https://www.fluncle.com/ --only-categories=performance --chrome-flags="--headless=new"`).

## Visual (before)

Production screenshot 2026-06-11: anonymous page (h1 is sr-only), cover + button column left, playlist shell right; the "before" for the A0 silhouette test.

## GSC / Bing (before)

Captured from the GSC dashboard (sc-domain:fluncle.com, 2026-06-11):

- **Performance, last 3 months: 1 click, 1 impression total.** The site is effectively invisible in Google search.
- **Page indexing: "Processing data, please check again in a day or so"** — the domain property has no coverage report yet (recently added). Re-check after Unit 0 deploys; expected interim state per RFC: "Duplicate, Google chose different canonical".
- Bing Webmaster Tools: not checked (no session); submit sitemap there as part of Unit 1 rollout.
