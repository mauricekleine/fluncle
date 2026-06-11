# RFC: fluncle.com — discoverability, the log page, routed-dialog Stories, and the aesthetic overhaul

**Status:** Final (research → /taste → 4-reviewer adversarial panel synthesized, 2026-06-11) — completeness standard applied: the whole thing, tested + documented, no deferrals.
**For:** a fresh build session + sub-agents.
**Canon:** DESIGN.md / PRODUCT.md / VOICE.md and the codebase arbitrate. This is planning, not spec.

> Process note: this RFC went through divergent research (aesthetic, routing, SEO, AI/GEO), a /taste pass, and a four-role adversarial review (staff engineer, design/brand, SEO/GEO, product/scope). Their factual corrections and reframes are baked in below; the panel's verifications are in the appendix.

## The standard (definition of done)

Boil the ocean: **do the whole thing, do it right, with tests and documentation, every thread tied off.** The bar is "holy shit, that's done," not "good enough."

- **Nothing below is deferred or optional.** Every unit and every Track-A surface ships, complete. The unit/PR decomposition is _sequencing for safety_ — not a menu to cut from. The whole delivery lands.
- **Tests + docs are part of done** (§9), not a follow-up.
- **Honest scoping ≠ deferral, and is the only sanctioned "not now":** a genuine external-dependency chain (Wikidata needs a MusicBrainz anchor first) is _ordering_; an outcome outside our control (whether an LLM cites a coordinate) is _truth_. Do everything in reach; be honest about what isn't.
- **Tie off the dangling thread:** close the Track-add **ISRC-fallback gap** (`docs/ROADMAP.md`) as part of this, so every finding is a coordinate-bearing log page — no Log-ID-less stragglers the log page / sitemap / schema can't represent.

---

## 0. The reframe: four units + one parallel track, NOT one overhaul

The draft bundled three "workstreams" under a "build `/log/<id>` once for all three" story. The panel's decisive correction: that story is **half true**. The honest decomposition is **four shippable units plus one independent track**, decoupled by _true_ coupling:

| Unit                        | What                                                                                                                                                 | Coupling                                 | Value                                     |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | ----------------------------------------- |
| **0 — Unblock**             | Fix the duplicate canonical (all hosts) + Cloudflare crawler audit                                                                                   | none                                     | **Day one.** Unblocks _all_ indexing      |
| **1 — The log page**        | SSR prose (definitional + decode) + `MusicRecording` JSON-LD + self-canonical + crawlable internal links + sitemap enumeration + 301 from `/stories` | the real spine                           | The growth payoff                         |
| **2 — Entity/answer layer** | One canonical description string + schema'd glossary + third-party corroboration                                                                     | light (needs Unit 1's pages to point at) | AI-answerability                          |
| **3 — On-site polish**      | Routed-dialog masking, swipe/margin fix, homepage IA regroup, story TikTok link                                                                      | independent UX                           | On-site feel — _search/LLMs never see it_ |
| **A — Aesthetic overhaul**  | The texture + plate pass                                                                                                                             | fully independent                        | "Looks the part"                          |

**The corrected synthesis:** `/log/<id>` is **one data/route surface with TWO visual registers** — the in-app **dialog** (cinematic player) and the standalone **page** (a readable archival _plate_). It is **not** one identical visual and **not** one component (see §3, §5). "Build it once" applies to the _route and data_, not the presentation.

**Masking is falsely coupled to the goal.** Search engines and LLMs only ever consume the SSR'd standalone page; they never see the masked dialog. So Unit 1 (the indexable page) ships **without** masking; Unit 3 (masking) ships as **its own PR, sequenced last** (highest derail risk → isolate it) — sequencing, not deferral. It still ships, complete.

---

## 1. Context & goals (honestly calibrated)

The Log ID (`sector.orbit.mark`, e.g. `004.7.2I` = `fluncle://004.7.2I`) is the cross-surface spine; it rides every TikTok caption. Goals:

1. The site finally _looks_ like the Nostalgic Cosmos (not just structurally correct).
2. Stories feel native (dialog over the feed, deep-linkable, the coordinate as the URL).
3. The coordinates become discoverable in **search** and **AI answers**.

**Goal calibration (from the SEO/GEO review — believe this):** "Search `004.7.2I` → get the log page" is achievable **weeks-to-months** after Units 0–1, _if_ the thin pages clear Google's "deserves a distinct URL" bar. "ChatGPT/Claude answers _what is `fluncle://004.7.2I`_ from memory" is **not** a near-term outcome from first-party pages — downgrade it to **"live-retrievable when an AI engine crawls fluncle.com."** The generic entity ("who is Fluncle?") is the achievable AI win, and it hinges on **third-party corroboration** (§4), not our own pages.

Framing that governs everything: **the website is the QUIET pane** (dark-only, cover-led, fast). Borrow the video kit's texture/warmth/ignition; refuse its loudness/vehicles/motion.

---

## 2. Unit 0 — Indexing unblock (P0, ship today, standalone PR, zero decisions)

**This is the single highest-leverage change in the RFC and it's gated behind nothing. Do it first, alone, deploy, verify — then build on top. Per the research: nothing else indexes until this lands.**

- **Duplicate `rel="canonical"` (verified live).** `__root.tsx` hard-codes a homepage canonical; TanStack merges `links` without deduping by `rel`, so every leaf emits two canonicals (homepage + its own). Google collapses pages into `/`. **Fix:** delete the canonical from `__root.tsx`; set a self-referencing canonical in each leaf's `head()`.
- **CORRECTION (don't chase a non-bug):** `og:url` is **not** duplicated — `meta` _is_ deduped by `property` (last-wins), so the leaf already overrides root. Leave root's `og:url` (harmless homepage default). The acceptance line "one `og:url`" already passes today.
- **MISSED BLOCKER — `galaxy.fluncle.com` is a crawlable duplicate host** serving the same app with the **same canonical bug** and its own open robots.txt. Decide: should `galaxy.` be indexable? If not, `X-Robots-Tag: noindex` (or host-canonical to `www`); if yes, fix its canonical too. **The canonical fix must be verified on every host, not just `www`.**
- **Cloudflare AI-crawler audit (human, parallel):** confirm managed-robots OFF, "block AI training bots" = allow, no WAF rule blocks GPTBot/ClaudeBot/PerplexityBot/OAI-SearchBot/Google-Extended/Bingbot (a WAF block overrides robots.txt `Allow`; Cloudflare blocks AI crawlers by default for new domains since 2025-07-01). Add a recurring **live-`/robots.txt` regression check** (it can flip silently).

**Acceptance:** exactly one self-referencing `canonical` per page **per host** (curl `www` _and_ `galaxy`); robots.txt matches the repo across hosts.

---

## 3. Unit 1 — The log page (the growth spine)

### The route + URL decision

- **Recommend `/log/<id>`** (singular — matches the canon already in `docs/track-lifecycle.md`). The bolder `/<id>` (the coordinate _is_ the URL — poetic, on-thesis) is **safe in shape** (Log IDs always start with a digit, regex `^\d{3,4}\.\d\.\d[A-Z]$`) **but** a bare top-level `$id` becomes the **catch-all for every unknown single-segment path** (`/foo`, typos, `/.well-known/*`) — a site-wide 404-handling change, not a local concern. `/log/<id>` avoids that. The guard must run in `beforeLoad`/`params.parse` → `notFound()` **before** the loader. **DECISION (resolve before build).**

### The component structure (engineer — don't get this wrong)

The standalone presentation is **text-first SSR prose** (crawlers); the dialog presentation is the **full-bleed client `StoriesPlayer`** (video/audio/gestures). These are **not one component with different CSS.** Concretely:

- `LogStandaloneRoute = <LogProse/> (SSR) + <StoryPlayer client-only/>` — prose is the primary SSR DOM (the SEO/archival surface); the player mounts on top / inline.
- Dialog (Unit 3) = `<Dialog><StoryPlayer/></Dialog>` — the **same player**, **no prose** (the home feed is underneath).
- **Do NOT make `StoriesPlayer` itself emit SSR prose** ("triple duty" must not be read that way). `StoryPlayer` takes a `presentation: "page" | "dialog"` prop (drops `position:fixed` in dialog mode).

### CORRECTION: the page already SSRs prose

The current `/stories/$logId` already server-renders title/artist/"Found Jun 3" — it is **not** "meta-only." The work is **adding**: a **definitional block** in the proven `[Entity] is a [category] that [differentiator]` shape — _"`004.7.2I` is Fluncle's Log ID for Axwell, 1991 — Nobody Else (1991 Remix), a drum & bass banger found Jun 3."_ (the coordinate as subject, in **both** forms, also in `<title>`/description) — plus a short **decode** (sector = days since the 2026-05-30 epoch / the Found date; tail = stable hash of the recording identity; permanent), linking to the glossary.

### Schema (corrected shape)

- Per-page **`MusicRecording`** via `head().scripts` (the home route already does this pattern with `MusicPlaylist` — acknowledge that baseline; don't let `name`/`sameAs` conflict across blocks). Include `byArtist`, `inAlbum`, `duration` (ISO-8601), `isrcCode`, `url`, `image`, **`datePublished`** (the Found date — freshness signal), `sameAs: [spotifyUrl]`.
- **The Log ID as TWO `identifier` PropertyValues** (`value: "004.7.2I"` and `value: "fluncle://004.7.2I"`, `propertyID: "fluncle-log-id"`) — **not** `fluncle://` shoved into `alternateName` (that's a schema-vs-prose mismatch that gets the block discounted).
- Site-wide low-effort wins the draft omitted: **`BreadcrumbList`** + **`WebSite` + `SearchAction`**.

### Sitemap + internal links

- `sitemap.xml.ts` lists only `/` today. Enumerate every log page (`<loc>` per finding). **`lastmod` = `added_at`** — there is **no `updated_at` column exposed** (`TRACK_SELECT` has only `added_at`); either accept that (findings are largely immutable post-enrichment) or add an `updated_at` column. Do **not** fake per-track lastmod from a build stamp. Resubmit in GSC + Bing.
- Log pages are currently **orphan** (reachable only inside the JS player). Add crawlable `<a href>` from the feed/index to each `/log/<id>`, anchor text = the bare Log ID (~10–20% exact-match, rest artist–title).

### Migration / redirects

- 301 `/stories/$logId` → `/log/$logId`. **Normalize trackId→logId ONCE, at `/log`**; make `/stories` a **dumb param-passthrough 301** to avoid `301→301` chains (the old `/stories` loader normalizes today; a `beforeLoad` redirect runs before it). Verify the 301 is honored on SSR with `curl -I` (don't assume). Same for `/stories` index. Real reason to redirect = preserve shared links (TikTok bio/Telegram); SEO equity is mostly theoretical (these pages aren't indexed yet).

### Edge cases (must be specified — a builder hits these on track #1)

- **A track with no Log ID / no ISRC** (the roadmap's ISRC-fallback gap is real): does it get a log page at all? Recommend: **no Log ID → no log page** (it's not yet a coordinate); the feed row shows the bare `#NN` until backfilled.
- **No video / no preview:** the log page still renders (cover-led plate + prose + JSON-LD); the player degrades to the cover (no video → cover; no preview → silent). `tiktokUrl` is **mostly absent at launch** (reconciliation is manual) — the TikTok link simply doesn't render; that's expected, not a bug.

**Acceptance:** `/log/<id>` SSR HTML contains the definitional block + both Log-ID forms + valid `MusicRecording` (Rich Results Test); GSC shows the **set** of log pages moving to Indexed (count ≈ archive size — partial indexing of thin pages is the real risk, watch the count); **bare-token retrieval** (`004.7.2I` and `fluncle://004.7.2I`) returns the log page in Google + Bing (the actual product goal — currently failing).

---

## 4. Unit 2 — Entity & answer layer (the GEO win)

- **One canonical Fluncle description string, reused verbatim everywhere** (home meta, root meta, llms.txt, Spotify/Telegram/X bios). It diverges today (`og:description` "Drum & bass bangers from another dimension" vs the richer llms.txt prose) — fragmentation splits the entity across models. Author it from VOICE.md via the `copywriting-fluncle` skill. **Near-zero effort, second-best ROI in the RFC.**
- **The full lore + glossary page (the answer surface) — built complete, not a stub.** Server-rendered: the Galaxy lore narrative (in VOICE) + the four `[Entity] is a…` definition blocks (Fluncle, Fluncle's Galaxy, a Log ID / `fluncle://`, Fluncle's Findings) + the "how to read a Log ID" decode + a worked example. Schema on it: `Organization` **or `MusicGroup`/`Person`** (pick one — a single curator persona reads as `MusicGroup`/`Person`; use it consistently in `sameAs`) with the canonical description + `sameAs: [spotify, telegram, x, musicbrainz, wikidata]`; and a **`FAQPage`** (Who is Fluncle / What is the Galaxy / What does `004.7.2I` mean / What is `fluncle://` / How are tracks chosen) — answers 50–300 words, natural-query phrasing. **FAQPage no longer yields Google rich results (restricted since 2023)** — it's for non-Google extraction; set that expectation, but ship it. (Schema must mirror visible prose, or it's ignored.)
- **THIRD-PARTY CORROBORATION — the highest GEO lever, missing from the draft.** Brands are ~6.5× more likely cited via third parties; the draft was almost entirely first-party. Add an explicit thread, sequenced:
  1. **MusicBrainz** — the on-genre structural anchor for a dnb selector/playlist (also a Wikidata-notability qualifier).
  2. **Wikidata** — created **after** MusicBrainz, which provides the structural identifier that satisfies notability (a bare self-made item citing only fluncle.com risks deletion, and a notability-reform RFC is in motion, March 2026). Sequencing, not deferral — both ship; seed it carefully (errors propagate across model versions).
  3. Authentic presence where dnb lives (r/DnB, RYM/Discogs-style references) — participate, don't fabricate.
- **`llms.txt`:** keep (great agent onboarding, ~zero cost) but **don't bet on it** (crawlers rarely fetch it; Google declined to support it); add one link to the glossary.

---

## 5. Unit 3 — On-site polish (routed dialogs etc.) — its own PR, sequenced last

_Ships after Unit 1's standalone route works (sequencing, not deferral — it ships, complete); nothing here affects discoverability._

- **Routed dialogs via TanStack route masking** (`createRouteMask` / `mask` / `routeMasks` — confirmed present in the installed **1.170/1.171**, _not_ 1.139; verify against current docs). The in-app `<Link>` masks to `/log/<id>` while the feed stays mounted; **a fresh load/refresh has no `location.state` → renders the standalone route** (the free fallback = the standalone page). Masking is **client-only**; SSR never produces the dialog.
- **Close / back / scroll (real bugs to fix):** the masked open is a keyed navigation. Closing via `navigate({ to: "/" })` mints a new key → **scrolls the feed to top**. Close via `router.history.back()` when opened in-app (preserves feed scroll); use `navigate({ to: "/" })` only as the standalone-origin fallback. Spec the dialog's close/Escape behavior explicitly (today it's hardcoded in `stories-player.tsx`).
- **The `replaceState`→`navigate` migration is the highest-risk change** (`stories-player.tsx` rewrites the URL on every flick). A real `navigate({ replace, mask })` per flick re-runs the route lifecycle (matching/`beforeLoad`/loader) and can jank the swipe + re-fire the loader (today `fetchStory` re-runs per param). **Gate the loader (`staleTime: Infinity` / `shouldReload: false`) so same-route param changes are no-ops, or keep a raw masked `replaceState`.** Do this **last**, behind the working standalone route, so you can diff behavior.
- **The standalone-page vertical-margin fix (desktop-gated):** `.stories-stage` (`position:fixed; inset:0; height:100dvh`) sizes the 9:16 pane off the _full_ viewport → edge-to-edge. Make the stage `place-items:center` + block padding; size the slot/pane from the **padded stage height** (not `100dvh`) via a shared CSS var (the pane, `.stories-chrome`, and the swipe `translateY(...100%...)` all key to `calc(100dvh*9/16)` — move them together). Mobile stays full-bleed. In dialog mode the `DialogContent` owns centering — the `presentation` prop drops `position:fixed`.
- **Homepage IA regroup (design — don't just append 2 more buttons).** The action list is already ~10 controls (a button farm PRODUCT.md warns against). Regroup by fiction: **destinations** (Spotify, Telegram — primary, near the cover) / **follow across the Galaxy** (a single quiet socials icon cluster: TikTok, X, subscribe, "all stories") / **contribute** (Submit, the nerd box) / **shuffle** as an affordance on the masthead, not a third primary slab. The RFC's TikTok + "view all stories" land in the socials cluster.
- **Story-page TikTok link** (`tiktokUrl` when a published post exists) — in the archival plate's footer links.

---

## 6. Track A — The aesthetic overhaul (fully independent; start in parallel day one)

**The design review's core finding: the draft was an excellent _polish_ pass mislabeled as an overhaul — "more attributes on the same skeleton" won't beat "it looks the same," because the page's _silhouette_ doesn't change.** So:

- **A0 — change the silhouette first (the actual overhaul): the page as a recovered logbook _plate_.** A single-document framing with a **real visible masthead** (today the `<h1>` is `sr-only` — the page is literally anonymous), a stamped "Fluncle's Findings" nameplate (Oxanium, sanctioned), and catalog/archive grammar from the moodboard (crop-mark corner brackets, register marks, a "FOUND" stamp, a worn edge). This is canon-coherent (the cover + list sit _flat on_ one document plate — DESIGN.md) and it's what makes someone go "this is a thing Fluncle printed and sent back," not "a dark playlist." **Texture is the finish on A0, not the substance.**
- **Gold-as-ignition, not gold-as-fill** (the best line in the doc — keep it): one directional Eclipse-Gold bloom (anchored to the cover's sun), lit edges, igniting hovers — gold placed _like light_, not applied like paint, still ~10% of screen.
- **Fix the grain architecture BEFORE tuning opacity (AA risk).** The grain veil today is a `z-30` overlay **over the reading text**; pushing it to 7–8% risks an AA regression on Stardust lines. Move dense grain _under_ content (cosmos + cover-frame mat), a whisper over panes, **never over reading text**. Then tune. Verify AA on the Stardust artist/date lines specifically.
- **One-Sun worst-case audit:** bloom + lit frame edge + row-ignition hover + Log-ID heat can be ~4 gold events in one hovered view. Require a single annotated screenshot proving the ≤10% gold budget at the worst case.
- **Every surface, complete — nothing here is optional; placement is craft, not a cut:** the cover-frame texture (grain over a bent warm gradient + lit edge — the highest-leverage surface, the founding document); buttons that **ignite** (toward Eclipse Glow) instead of dimming; chips **de-pilled** into stamped catalog marks; pane-tooth grain (AA-verified); and scanline/halftone placed where they belong — the **artwork fallback + empty/loading states** (no text to protect → the one sanctioned contained halftone/dither moment, Retint Rule). Every one ships; the only judgment is _where_ each lands, governed by AA, not _whether_.
- **One imperceptible bloom-breath** (~30–60s, reduced-motion-gated) on top of the existing 72s drift — a totally static textured page is the failure mode Maurice dislikes; "quiet" ≠ "frozen JPEG."
- **`/log/<id>` archival register (design):** the standalone page is a _designed log entry_ — the Log ID as masthead/coordinate, the cover-frame as the body, metadata as logbook fields (the prose SEO wants reads as genuine logbook copy, not an "SEO basement"), the video embedded as one element. The **dialog** register stays cinematic/full-bleed. Two registers, one component library.
- **Suggestive, not dictating:** lead the build from the one-liner — _"the logbook printed on aged, lossy stock under one burning sun"_ — plus A0 + gold-as-ignition + the cover-frame exemplar; treat the per-surface list as reference, not a mandate.

**Constraints (every surface):** AA 4.5:1 verified wherever texture nears text; all texture static (reduced-motion-safe by construction; the one bloom-breath gated); zero new network requests (reuse the inline SVG noise + the one cover image); no WebGL; cover art stays LCP; **capture a baseline LCP now** (none exists) for the before/after.

---

## 7. Sequencing & ownership (the fan-out)

- **Day one (no decisions):** Unit 0 (one agent, ~30–60 min) + Cloudflare audit (human) + **kick off Track A in parallel** (longest-pole creative work, fully independent — don't gate it last).
- **Resolve the §8 decisions BEFORE the rest** (a sub-agent will block or guess otherwise — the biggest executability gap).
- **Critical path:** Unit 0 → URL decision → **Unit 1** (the standalone log page: prose + schema + sitemap + internal links + 301s).
- **Then fan out:** Unit 2 (entity layer), Unit 3 (on-site polish, after Unit 1's route exists), finish Track A.
- **Last:** MusicBrainz → Wikidata; monitoring.
- **DEPLOY DISCIPLINE:** fluncle-web deploys via Cloudflare Workers Builds with **build-coalescing — rapid pushes during an in-flight build get silently dropped** (a multi-agent commit burst is exactly that pattern). **Serialize deploys and verify each landed** before running post-deploy acceptance, or you'll test stale builds.
- **The ONE thing that de-risks the most:** ship Unit 0, deploy, confirm one canonical per page per host in GSC — _then_ build. Every other discoverability investment is wasted spend until it lands.

---

## 8. Decisions needed BEFORE handoff

1. **Log-ID URL:** `/log/<id>` (recommended) vs `/<id>` (bold; site-wide 404-surface tradeoff) vs `/logs/<id>`.
2. **`galaxy.fluncle.com`:** indexable (fix its canonical) or `noindex`?
3. **Glossary/lore route + scope:** schema'd glossary now (recommended) vs full lore narrative; which route (`/about`, `/galaxy`, `/guide`, `/log` index)?
4. **The one canonical Fluncle description string** — write it (VOICE.md / `copywriting-fluncle`).
5. **`/stories` index:** keep, rename to `/log`, or drop in favor of dialog + per-log pages.
6. **`lastmod`:** accept `added_at`, or add an `updated_at` column.
7. **Aesthetic intensity:** confirm A0 (the plate reframe) + the bounded-texture/no-WebGL direction.

---

## 9. Acceptance criteria

- One self-referencing `canonical` per page **per host** (curl `www` + `galaxy`); `og:url` already singular (verify, don't "fix").
- `/log/<id>` SSR HTML has the definitional block + both Log-ID forms + valid `MusicRecording`; glossary has valid `Organization`/`MusicGroup` + `FAQPage`; Rich Results Test clean.
- GSC Coverage: the **set** of log pages → Indexed (count ≈ archive size), not just one sample; off "Duplicate, Google chose different canonical."
- **Bare-token retrieval:** `004.7.2I` + `fluncle://004.7.2I` return the log page in Google + Bing (currently failing).
- Sitemap enumerates all log pages; submitted to GSC + Bing.
- Stories: dialog-over-home in-app; refresh/share → standalone plate; 301 from `/stories/<id>` (verified `curl -I`); desktop pane has vertical margin, mobile full-bleed, swipe still tracks; **dialog-close preserves feed scroll**.
- Aesthetic: the **silhouette visibly changed** (the "looks the same" test must fail); AA holds on every textured surface incl. Stardust lines; reduced-motion fully static (+ the one gated bloom-breath); LCP vs the captured baseline unchanged.
- **Baseline captured NOW** (GSC impressions/coverage, current AI answers to the three probe questions, LCP) for before/after.
- robots.txt matches the repo across hosts; Fluncle present in Brave Search; submitted to Bing.
- **Tests (part of done):** unit/integration coverage for the new logic — the `/log/<id>` param guard + `notFound()`, the `/stories`→`/log` 301 normalization (asserting no `301→301` chains), sitemap enumeration, the JSON-LD output shape (`MusicRecording`/`Organization`/`FAQPage` validity), and the masking close → `history.back()` + feed-scroll preservation. If `apps/web` has no test setup, establish one (Vitest) as part of this — not after.
- **Docs (part of done):** update `docs/track-lifecycle.md` (the `/log/<id>` surface + the URL), flip the shipped items in `docs/ROADMAP.md` to done, and run the moodboard→canon audit follow-through for anything Track A promotes into DESIGN.md.
- **Monitoring, not ship gates:** GSC "Indexed" and AI-citation are weeks-out outcomes — track, don't block on them.

---

## 10. Risks & open questions

- **Thin-page folding:** 22 short log pages over covers risk being treated as thin/doorway — keep each genuinely useful (decode + notes + player), or Google folds them back into the playlist.
- **The `replaceState`→`navigate` jank** + dialog-close scroll — the most error-prone migration spots (§5).
- **AA regression** from texture near text — the recurring failure; the grain _architecture_ fix precedes any opacity bump.
- **Cloudflare can silently re-block AI crawlers** + build-coalescing drops deploys — hence the regression check + serialized deploys.
- **Entity blindness:** JSON-LD that contradicts visible prose is ignored — schema mirrors prose.
- **GEO honesty:** the per-coordinate answer is "live-retrievable when crawled," not "from memory"; the real lever is third-party corroboration, which is slow and partly outside our control.
- **Don't write "content for AI"** (chunked fragments, keyword stuffing) — the glossary/FAQ must read as genuine Fluncle voice (VOICE.md).
- **Quiet-web discipline:** the aesthetic must not drift into the video kit's loudness — no WebGL, no motion-budget growth beyond the one bloom-breath.
- **Edge case:** tracks with no Log ID / ISRC / video — specified in §3; confirm the degraded render.

---

## Appendix — verifications & sources

**Panel verifications (live, 2026-06-11):** 2 canonicals + 1 `og:url` + SSR prose + 0 JSON-LD on `/stories/004.7.2I`; home has 1 canonical + `MusicPlaylist`/`MusicRecording` JSON-LD, `numTracks:22`; `/log/004.7.2I` → 404 (route absent); `999.9.9Z` → true HTTP 404; `galaxy.fluncle.com` = duplicate host, same canonical bug, open robots; `sitemap.xml` lists only `/`; web search for `004.7.2I` does not surface the story page; installed TanStack = router 1.170/1.171, start 1.168 (lockfile) vs `^1.139.3` declared.

**Routing:** [TanStack Route Masking](https://tanstack.com/router/latest/docs/guide/route-masking) · [createRouteMask](https://tanstack.com/router/latest/docs/framework/react/api/router/createRouteMaskFunction) · [Route Matching](https://tanstack.com/router/latest/docs/framework/react/guide/route-matching)

**SEO:** [Google JS SEO basics](https://developers.google.com/search/docs/crawling-indexing/javascript/javascript-seo-basics) · [TanStack Start SEO](https://tanstack.com/start/latest/docs/framework/react/guide/seo) · [schema.org/MusicRecording](https://schema.org/MusicRecording) · [SEJ XML sitemaps](https://www.searchenginejournal.com/technical-seo/xml-sitemaps/) · [Yoast lastmod](https://yoast.com/lastmod-xml-sitemaps-google-bing/)

**AI/GEO:** [Google AI optimization guide](https://developers.google.com/search/docs/fundamentals/ai-optimization-guide) · [GEO best practices 2026 (GenOptima)](https://www.gen-optima.com/geo/generative-engine-optimization-best-practices-2026/) · [Cloudflare AI Crawl Control](https://developers.cloudflare.com/ai-crawl-control/features/manage-ai-crawlers/) · [Cloudflare blocks AI crawlers by default](https://llmrefs.com/blog/cloudflare-blocks-ai-crawlers) · [State of llms.txt 2026](https://presenc.ai/research/state-of-llms-txt-2026) · [Wikidata for brands (notability)](https://www.mlforseo.com/knowledge-graph-strategy/wikidata-for-brands-notability-criteria-and-a-realistic-path/) · [Wikidata notability reform RFC](https://www.wikidata.org/wiki/Wikidata:Requests_for_comment/Notability_policy_reform) · [Entity blindness in LLMs](https://generative-engine.org/entity-blindness-in-llms-why-chatgpt-ignores-your-schema-mar-1760569369608) · [1,000 AI Overviews citation study](https://www.digitalapplied.com/blog/we-analyzed-1000-ai-overviews-citation-pattern-study)

**Canon:** DESIGN.md · PRODUCT.md · VOICE.md · `packages/video/moodboard/MOODBOARD.md` · `docs/track-lifecycle.md` (the `/log/<id>` ↔ `fluncle://<id>` spine) · `docs/ROADMAP.md`
