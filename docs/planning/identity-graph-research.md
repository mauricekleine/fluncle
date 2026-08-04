# Identity graph — research evidence (2026-07-29)

The evidence behind Fluncle's identity surface, kept after the build shipped. Non-canonical planning input: the measured numbers, queries, and clauses the decisions rest on, committed so they outlive the session that gathered them (four research threads + two sub-verifications + a four-role adversarial panel, all 2026-07-29). Anything below not re-verifiable from this file or the cited primary source should be treated as UNVERIFIED before it carries a new decision.

What was built off this evidence is documented where it lives: the identity payload and its five states in the serializer module beside `apps/web/src/lib/server/identity-dials.ts` (the dials), the reader page at [/docs/identity](../../apps/web/content/docs/identity.mdx), and the surviving tail in [ROADMAP.md](./ROADMAP.md). The RFC these numbers were gathered for was pruned on ship (git history holds it).

## The market facts (all verified at primary sources, 2026-07-29)

- **Odesli/Songlink public API sunsets 2026-07-31** — Linktree Help Center, published 2026-05-21: `v1-alpha.1` on `api.song.link`/`api.odesli.co` returns `410 Gone` after that date; allowlist-only for partners; **no paid tier offered**; the consumer landing pages survive. Pre-sunset state, measured live: ~19 keyless requests per IP per day then hard 429 for the rest of the day; **the big-three bridge is already gone in every direction** (Spotify-in → no Apple/YouTube; Apple-in → no Spotify/YouTube; YouTube-in → own cluster only; 6/6 canonical tracks, API and free HTML pages both). Odesli never accepted an ISRC as input.
- **The read on Linktree's choice:** nine years running the canonical resolver, then switched off rather than charged — an incumbent's verdict that the API is a cost centre, not a product.
- **The paid successor exists:** Musicfetch — $50/50k, $100/150k, $200/500k req/mo, card-gated trial, no perpetual free tier, search by URL/ISRC/UPC across 40+ services including Apple Music and YouTube. No revenue/headcount/funding signal found for it or any small entrant (a price page is not revenue).
- **The day-before-sunset survey (2026-07-30):** after the sunset there is no free, keyless, ISRC-in resolver left anywhere. The survivors split into solo-operator newcomers (MusicLink $0–49/mo, 18 platforms incl. the four Odesli lost, ISRC in; SonoVault free–€249/mo beta, the only Beatport+Discogs coverage; SongPort API waitlisted) and industry vendors (Soundcharts from $250/mo; Songstats enterprise-quoted). SongPort independently ships Fluncle's honest-negatives model — every link labelled `direct` vs search-fallback "good, not certain." Songwhip has been a frozen Sony-owned corpse since 2024-07-22. The two links no survivor serves well, and the two that matter most for DnB: **SoundCloud** (dropped by Odesli as a target; SoundCloud cut Hypeddit's API 2026-06) and **Beatport** (one beta covers it) — both under their own terms reads as of this writing.
- **Demand measures tiny:** Stack Overflow empty on the sunset; HN never noticed; one ~10-upvote Reddit thread; ~80 GitHub repos reference the API; the best-funded SDK moves ~493 npm installs/week; measured indie willingness-to-pay ≈ 0 ("€0.01 per track, ouch" → build-my-own-cache). GitHub growth-curve signals in this niche are polluted by AI-agent-generated repos — filter before trusting.
- **Nobody prices on coverage.** Odesli: free, both tiers. Soundcharts $50–$4,500/mo by request volume; Viberate €300–€5,000 by throughput/depth; MetaBrainz $100–$2,000+/mo **by buyer headcount/stage**; AudD $5/1k sliding. Largest coverage claims: 100–160M tracks against Luminate's 253M streaming universe (40–63%); no vendor publishes a coverage percentage anywhere. The scope-fit thesis: partial coverage sells only where the vendor's scope is the buyer's entire universe (Apple←Primephonic classical; Beatport's ~5.5% slice into DJ hardware). No vendor markets underground/white-label coverage as an axis — unserved gap or too-small market, undecidable from the evidence.
- **Cautionary tales:** Echo Nest (partial-catalogue data business, licensed to the era's biggest DSPs, acquired by Spotify 2014, third-party market evaporated within a week); Jaxsta (best-positioned credits database, hibernated); WhoSampled ≤£632k turnover; MetaBrainz itself net −$46,726.
- **DnB-specific measurements:** a real DnB sample on MusicBrainz carries ISRCs at ~68% but URL-relations at only ~15% (the hole Fluncle's verified links fill); **~8% of DnB ISRCs map to more than one recording**; Deezer's unauthenticated `/track/isrc:` endpoint resolved 27/27 with ~7% silent title mismatches (it picks a winner silently — the anti-pattern); Apple's keyless iTunes lookup returns 0 for ISRC always. RollDaBeats (~100k-track DnB discography) is dead and unarchived 3y8m, ownerless.

## The platform-terms clauses (load-bearing, verbatim where retrieved)

- **Spotify Developer Policy II.4.c:** "You must not offer metadata, cover art, and/or Audio Preview Clips as a **standalone service or product**." Developer Terms V.5: "You will not sell any Spotify Content or other data obtained from Spotify." IV.3.1: "you may not store, aggregate or create compilations or databases of Spotify Content, other than as strictly necessary… Do not store Spotify Content indefinitely." IV.2.4: no robot/spider retrieval. III.14: no ML/AI ingestion. II.4.a/b: marks attribution + link-back. **The panel's correction: "standalone" is a structural clause, not a price test — free does not cure it**; and the contract binds Fluncle as a Spotify developer regardless of where any particular ID was sourced (MusicBrainz CC0 provenance defeats the copyright question, not the contract one).
- **Spotify Feb-2026 lockdown** (developer.spotify.com migration guide + 2026-02-06 blog): `external_ids` (ISRC) removed from dev-mode track objects; batch endpoints and `available_markets`/`label`/`popularity` removed; search capped; Extended Quota requires a registered business + 250k MAU (recorded in-repo as unreachable). Four restrictions in twenty months.
- **Deezer Developer Terms §IV:** use is "strictly limited for a non-commercial purpose and in a non-commercial environment"; the developer "shall not perceive, receive, generate, benefit or create directly or indirectly, any moneys, incomes, revenues, **data** or any other consideration." Note: Fluncle's Deezer calls are unauthenticated (no accepted key agreement — cuts both ways). The ISRC-recovery rung's exposure exists today, independent of the RFC. **Deepened 2026-07-30 (full portal read + live probes):** the terms are verbatim-frozen since at least 2013-01-26; app registration is CLOSED ("We're not accepting new application creation at this time"), which closed OAuth app creation but NOT the unauthenticated endpoints — `GET api.deezer.com/track/isrc:<ISRC>` answered keyless 200 today with a public `link` field (`https://www.deezer.com/track/<id>`, resolves without login). The contract forms by acceptance (§I) and acceptance runs through the closed registration, so Fluncle has never accepted and now cannot; the only live theory is acceptance-by-conduct, which the existing rungs already carry — a link leg raises visibility, not the theory. No clause anywhere addresses serving or deep-linking a URL; deezer.com's robots.txt blocks `/*/track/` only for AI crawlers, not generally. If bound: a visible Deezer logo is mandatory per their guidelines, images must never be cached ("No, images are not allowed to be stored for legal reasons" — their FAQ), while ids and names are explicitly storable. Termination is at-will (§II c). **Operator ruling 2026-07-30: the opportunistic id-retention leg ships** (keep the Deezer track ids three code paths already fetch and discard; forward-only; no sweep; no logo — Fluncle is not a party); the full sweep leg stays unbuilt until demand shows. Deezer market context: 8.9M paid subs mid-2026 (audited, −3.5% YoY), ~1% of the global paid base; deep DnB catalogue but namesake-polluted search — the ~7% ISRC-endpoint mismatch above stands, so every persisted id rides an identity gate.
- **Tidal Developer Terms — READ VERBATIM 2026-07-30, and the question is CLOSED: no Tidal leg, ever, under the current documents** (Developer Terms + Developer Guidelines + Design Guidelines, all v3.0 of 2024-05-06, all binding through one incorporation chain: Design Guidelines → Guidelines §II "Comply at all times with TIDAL's Design Guidelines" → Terms §I.2). Five independently fatal grounds: (1) Design Guidelines General Don'ts — "display TIDAL content next to content from similar services" (the identity page's entire layout); (2) Terms §II.1.05 — "you may not create stored databases or other compilations of data… Do not store TIDAL Content indefinitely" (a persisted `tidal_url` column is exactly this); (3) Terms §I.1 — "the sole purpose of developing and distributing non-commercial applications" is a purpose limitation, not a price test; (4) Guidelines §III.5/§III.10 — "Integrating TIDAL content with content or streams from another service" / "Enabling the transfer of data to another service" prohibited without express written approval; (5) Terms §II.1.19–20 — no offering "that utilizes TIDAL content for any purpose in connection with any artificial intelligence or machine intelligence technologies" (restated four times across the three documents; "Your Offering" is the whole site, and Fluncle's enrichment/notes/bios/embeddings are all AI). Constructing `tidal.com/track/<id>` URLs without the API is NOT a loophole — §II.1.04/§II.1.18 anti-scraping makes it a different violation — and Production-Mode approval includes a source-code review (Terms §IV). The bitter half, so the closure is honest about its cost: the API itself is exactly what a leg would want (open free registration, client-credentials, `GET /tracks?filter[isrc]=` at the open THIRD_PARTY tier, honest multi-match per ISRC), and demand research ranks Tidal the single most-requested missing platform across the Odesli ecosystem with the only live DJ-software surface (Serato, rekordbox, VirtualDJ, Engine OS, CDJ-3000X). Re-open only if TIDAL publishes materially different developer terms.
- **SoundCloud API Terms (read verbatim 2026-07-30, effective 2024-03-30) — track leg CLOSED.** Access flipped open (instant self-serve keys on Artist Pro $99/yr since 2026-05) but four clauses each kill it: the dedicated-pages ban ("must not… create a page, profile, channel or other online presence dedicated to one or more specific artists or set of repertoire" — Fluncle's /artist pages on their face); the aggregation ban ("any playback experience which aggregates and streams User Content with content from other services"); session-only caching ("must not… persistently store any User Content"); and the AI clause (User Content may not be used "as input to any artificial intelligence technology" nor "to create fingerprints"). Aggravating climate: SoundCloud severed Hypeddit 2026-06-11 (82% of DnB free-download gates) with no published reason, no terms change, seven weeks of tracker silence; termination discretionary, liability cap EUR 50, termination obliges deleting all stored User Content. Softeners: the SoundCloud-only repertoire (DnB runs ~3× the field on free downloads, 11–18× on VIPs) is ~78% ISRC-less — no key to hang it on in this graph anyway; and the permitted surface already ships (artist_socials profiles + the keyless soundcloud.com/oembed liveness oracle, no API, no terms accepted). The MB CC0 sidestep was probed and is EMPTY at recording level (5-ISRC probe 2026-07-30: one URL rel total, Spotify; zero SoundCloud — consistent with the ~15% figure above). The API has no ISRC lookup (search-in only) but track responses CARRY isrc — verify-not-resolve; moot given the closure.
- **Beatport API Terms (read verbatim 2026-07-30, "Last Updated: July 21, 2026" — public even though the API itself is partner-gated) — the friendliest of the five, with one hard rail.** §8 grants "non-commercial and informational use" of Beatport data BY DEFAULT; §2/§4 sanction exactly the link-back Fluncle would do; no clause bars display beside competitors; termination at-will incl. "for any other reason." The API front door is closed (self-serve registration 404s, schema auth-walled, "Request API Access" historically returns No-Access; the ecosystem's universal workaround — borrowing the public embed client_id hardcoded in embed.beatport.com's bundle — is explicitly forbidden by "All calls… must reference the API Key issued to you as an approved licensee" and is NOT a path). The KEYLESS path is verified live: public search returns slugs+ids; public release pages embed `isrc`, `bpm`, `key`, `genre`, `sub_genre` in their Next.js page data (real ISRCs extracted 2026-07-30); URL constructible as `beatport.com/track/<slug>/<id>`; robots.txt signals `Content-Signal: search=yes,ai-train=no` with `Allow: /` for generic agents while name-blocking AI crawlers and Cloudflare's rendering crawler — the fetcher's identity is the open compliance question (bare curl 403s on the Cloudflare wall; a rendering fetcher is required). THE RAIL: §F strictly prohibits using site content "including underlying metadata" for text/data mining or AI — a Beatport leg is defensible only as a TERMINAL LINK ARTIFACT (stored id + URL rendered as an outbound link; never into FTS5, the LLM search tier, or embeddings). DnB depth first-class (genre id 1; Jungle 15,599 / Liquid 13,202 / Jump Up 8,624 faceted tracks; the Top-100 culture; stable label pages mapping onto the label entity). ISRC as an API query filter UNVERIFIED (401 unauthenticated); ISRC on the track object confirmed. Operator lottery ticket: log in and look for "Request API Access" with the free non-commercial archive case; don't schedule against it.
- **Apple:** the controlling MusicKit clause is **ADPLA §3.3.6(D) — NOT RETRIEVED** (PDF fetch declined). Blocking for any third-party serving of Apple links; first-party rendering continues as today.
- **MusicBrainz/MetaBrainz:** core data (recordings, relationships & URLs, labels, artists, releases) is **CC0**; supplementary data CC BY-NC-SA; the hosted API asks 1 req/s + identifying UA (Fluncle complies) and "non-commercial use of this web service is free; see our commercial plans" — "commercial" includes an _expected_ revenue stream; Bronze $100/mo. Live Data Feed replication packets are CC BY-NC-SA (a supporter agreement, not just the licence, if replication is ever proposed).

## The measurement queries (run against HOSTED prod, never turso dev)

**Q0 — physical column order** (decides whether Q1/Q2 are covered; `embedding_blob` sits at cid 28 of 62 and post-blob arms drag 4KB overflow pages):

```sql
select cid, name from pragma_table_info('tracks');
```

**Q1 — ISRC + Spotify by tier** (expect `SCAN tracks USING COVERING INDEX tracks_funnel_scan_idx`; run `EXPLAIN QUERY PLAN` first):

```sql
select
  is_catalogue,
  count(*) as rows_total,
  sum(case when isrc is not null and trim(isrc) <> '' then 1 else 0 end) as has_isrc,
  sum(case when spotify_uri is not null then 1 else 0 end) as has_spotify,
  sum(case when isrc is not null and trim(isrc) <> '' and spotify_uri is not null then 1 else 0 end) as has_both,
  sum(case when spotify_uri is null and spotify_anchor_attempted_at is not null then 1 else 0 end) as spotify_tried_missed,
  sum(case when spotify_uri is null and spotify_anchor_attempted_at is null then 1 else 0 end) as spotify_never_tried,
  sum(case when spotify_uri is null and coalesce(spotify_anchor_attempts, 0) >= 6 then 1 else 0 end) as spotify_retired_at_cap
from tracks group by is_catalogue;
```

**Q2 — Apple + MBID + Discogs** (uncovered; time it — the duration is itself a baseline figure):

```sql
select
  is_catalogue,
  count(*) as rows_total,
  sum(case when apple_music_url is not null then 1 else 0 end) as has_apple,
  sum(case when apple_music_url is null and backfill_apple_music_attempted_at is not null then 1 else 0 end) as apple_tried_missed,
  sum(case when apple_music_url is null and backfill_apple_music_attempted_at is null then 1 else 0 end) as apple_never_tried,
  sum(case when backfill_apple_music_done_at is not null then 1 else 0 end) as apple_done,
  sum(case when mb_recording_id is not null then 1 else 0 end) as has_mbid,
  sum(case when mb_recording_id is null and mb_recording_id_attempted_at is not null then 1 else 0 end) as mbid_tried_missed,
  sum(case when mb_recording_id is null and mb_recording_id_attempted_at is null then 1 else 0 end) as mbid_never_tried,
  sum(case when in_release_id is not null then 1 else 0 end) as has_discogs_release
from tracks group by is_catalogue;
```

**Q3 — platform breadth + ISRC collisions** (the RFC's go/no-go reads off the breadth half):

```sql
select is_catalogue,
       (case when spotify_uri is not null then 1 else 0 end)
     + (case when apple_music_url is not null then 1 else 0 end)
     + (case when in_release_id is not null then 1 else 0 end) as platforms,
       count(*) as n
from tracks
where isrc is not null and trim(isrc) <> ''
group by is_catalogue, platforms order by is_catalogue, platforms;

select dupes, count(*) as isrcs from (
  select isrc, count(*) as dupes from tracks
  where isrc is not null and trim(isrc) <> '' group by isrc
) group by dupes order by dupes;
```

**Q4 — entity-grain coverage:**

```sql
select 'artists' as entity, count(*) as n,
       sum(case when mbid is not null then 1 else 0 end) as has_mbid,
       sum(case when spotify_artist_id is not null then 1 else 0 end) as has_spotify,
       sum(case when discogs_url is not null then 1 else 0 end) as has_discogs,
       sum(case when wikidata_qid is not null then 1 else 0 end) as has_wikidata
from artists
union all
select 'albums', count(*),
       sum(case when release_group_mbid is not null then 1 else 0 end),
       sum(case when apple_album_id is not null then 1 else 0 end),
       sum(case when upc is not null then 1 else 0 end), 0
from albums
union all
select 'labels', count(*),
       sum(case when mb_label_id is not null then 1 else 0 end),
       sum(case when discogs_label_id is not null then 1 else 0 end), 0, 0
from labels;
```

**Q5 — MBID fill by birth path** (panel addition; blocking on the MBID leg — tests whether MBID serves certified rows at all):

```sql
select case when substr(track_id,1,3)='mb_' then 'crawler' else 'spotify-born' end as birth,
       is_catalogue,
       count(*) as rows,
       sum(case when mb_recording_id is not null then 1 else 0 end) as with_mbid,
       sum(case when isrc is not null and isrc <> '' then 1 else 0 end) as with_isrc,
       sum(case when mb_recording_id_attempted_at is not null then 1 else 0 end) as attempted
from tracks group by 1, 2;
```

## The panel's load-bearing in-repo verifications (file:line as of `a286d542`-era main)

- `tracks.isrc` non-unique with the reason written down (`schema.ts:~638`); no `isrc_attempted_at` exists; `duplicate_of_track_id` written on exact catalogue↔finding ISRC match (`schema.ts:~290`).
- No value index on `mb_recording_id` — only the partial fill-queue index (`schema.ts:~660`); MBID is not unique and is not deduped across birth paths.
- The anchor gate computes and returns (never persists) `source`/`verifiedBy`; the Apify rung bypasses `resolveAnchorFree` and carries the five-member `AnchorReviewSource`; the operator's accepted review writes an anchor with no rung recorded; the subset-fallback gate (±1s, proper-subset credit) is a distinct confidence (`anchor.ts` §§ per the panel reports).
- `spotify_anchor_attempts` **decrements** on kill-flag requeue (`anchor-apify.ts:~111`) — a budget counter, not a look ledger; `anchorTrack` throws `certified` before any stamp, so certified findings carry NULL anchor state.
- Apple's `*DoneAt` doctrine makes Apple never-terminal ("re-checkable if Apple's catalogue grows", `schema.ts:~166`); MBID's attempt stamp is single-shot; Deezer's `enrichFromDeezer` returns indistinguishable `{}` on all four failure paths (`deezer.ts:~245-284`) and discards `track.id`.
- The anchor worklist's five permanent exclusions (`track-work.ts:~119-153`, `schema.ts:~712`): attempts cap, placeholder credits, dismissed, duplicate, no-duration — the `refused` state's predicate, to be shared as one exported SQL fragment.
- `handleOrpc` returns before the edge-cache block in `server.ts` (~:81 vs ~:126) — no oRPC op is edge-cacheable without opening the dispatch spine; `EdgeCachePolicy.contentType` is a two-member union read by three call sites.
- `rate_limit_counters` has no prune anywhere in the repo; the dials write 2 rows/req-window; `rateLimitBucket` falls back to a literal `"unknown"` shared bucket when `cf-connecting-ip` is absent.
- `tracks_funnel_scan_idx` (13 columns, verified from `drizzle/meta/0135_snapshot.json`) does not cover the coverage op's Apple/MBID/backfill arms.
- The Unlit precedent: six public unauthenticated ops serve title/artists/links for uncertified rows (`PUBLIC_OPERATION_IDS` in `orpc.test.ts:~685`), with the tier-is-a-boolean doctrine written into `_shared.ts` (~:191, :236, :262) and the public `?certified=false` filter documented in `content/docs/api-overview.mdx`.
- `resolve` verb registered as an external-authority WRITE (`orpc-naming.test.ts:~63`, `naming-conventions.md:~155`); all five live `resolve_*` ops are writes.
- `/terms` operative clauses: `terms.tsx:51` (self-description), `:65` (the user-side non-commercial licence grant — the launch blocker), `:72` ("reasonable use").
- `/chat`'s two-dial precedent is user-keyed, `search_archive`'s IP dial is single — no two-dial IP precedent exists.
- Every in-repo 422 is hand-thrown in-handler; oRPC schema rejection emits 400; the `search_tracks` contract documents the tolerant-input pattern.

## Monetization/tax facts (if posture B/C is ever revisited)

Stripe EEA: 1.5% + €0.25 card fee + 0.7% Billing (a €5 sub nets ≈ €4.64; the €0.25 fixed component is why nobody bills per-call at small volume); MoR (Paddle/Polar) ≈ 5% + $0.50 and takes the VAT liability as reseller. NL/EU: the €10,000 cross-border B2C threshold (not the €20,000 KOR) is the cliff; quarterly OSS; **UK has no threshold for a non-established seller — one UK B2C sale triggers registration**; 10-year record retention; Art. 24b evidence must come from a third party (the PSP), not a self-declared address; KVK €85.15 mandatory for profit-seeking supply. Comparable solo APIs price at $17–$49 entry, gate free tiers per-month; the niche's metadata APIs gate on **rate, not quota** (free keys buy 2.4–6×). Working solo-API accounts range "unimaginably tough" (ScreenshotOne, ~$20k MRR) to "an hour a year" (Zestful, ~$200/mo — the structural analogue of a cached resolver). No first-party free→paid conversion figure exists anywhere in the research.

## Unit 0 — RESULTS (run against hosted prod `fluncle`, 2026-07-29, operator interview session)

**Verdict: GO** — 8,341 rows with ≥2 platform links (8,256 catalogue + 85 certified) against the pre-stated 2,000 threshold.

| Measure                  | Certified (85 rows) | Catalogue (65,249–65,260 rows)                                                              |
| ------------------------ | ------------------- | ------------------------------------------------------------------------------------------- |
| ISRC                     | 85 (100%)           | 33,853 (52%)                                                                                |
| Spotify anchored         | 85 (100%)           | 20,271 (31%)                                                                                |
| Spotify tried-and-missed | 0                   | 8,778                                                                                       |
| Spotify never tried      | 0                   | 36,200                                                                                      |
| Spotify retired at cap   | 0                   | 0                                                                                           |
| Apple Music              | 84 (99%)            | **0 — all 65,260 never attempted** (the catalogue sweep leg exists but was never scheduled) |
| Discogs release id       | 35 (41%)            | 37,575 (58%)                                                                                |
| MBID                     | 53 (62%)            | 65,240 (~100%, crawler PK)                                                                  |

Platform breadth among ISRC-bearing rows: certified — 51 rows at 2 platforms, 34 at 3; catalogue — 8,836 at 0, 16,772 at 1, 8,256 at 2, none at 3 (Apple absent). ISRC collisions: 33,004 ISRCs unique, 459 shared by 2 rows, 9 by 3 (~1.4% of ISRCs — arrays required; 5× rarer than the external ~8% estimate). Birth-path (Q5): crawler rows 65,247 all MBID-bearing; spotify-born 78 certified (46 with MBID, 59%) + 20 catalogue (0 MBID). Entities (Q4): artists 9,364 (80% MBID, 49% Spotify, 3% Wikidata); albums 9,395 (99% MBID, 20 Apple album ids, 20 UPC); labels 1,233 (99% MBID). Q1's plan confirmed `SCAN tracks USING COVERING INDEX tracks_funnel_scan_idx`; Q2 (uncovered) completed in ~4.8s wall including network — a one-off cost, never a live op.

## Wave 2 hosted proofs (2026-07-29)

Run against a hosted Turso scratch FORK of prod (never `turso dev` — the local engine diverges on exactly these behaviours), destroyed after.

- **The MBID value index build: 104s at 66,096 rows.** `create index tracks_mb_recording_id_idx on tracks (mb_recording_id)`. The cost is not the column, it is the column's POSITION: `mb_recording_id` sits post-`embedding_blob` (cid 28 of 62, Q0), so the build drags every row's 4 KB vector overflow pages to read one text field. Operational consequence, carried verbatim into the shipping PR: the migration auto-applies in the CF build and holds the single writer ~2 min; merge at a quiet hour; reads proceed under WAL, sweeps retry.
- **The plans, confirmed by `EXPLAIN QUERY PLAN` on the fork:** `where mb_recording_id = ?` → `SEARCH tracks USING INDEX tracks_mb_recording_id_idx`; `where isrc = ?` → `SEARCH tracks USING INDEX tracks_isrc_idx` (the pre-existing index, which is why the ISRC key needs no new one — and why the key must be normalized in the isolate rather than wrapped in `upper()` in SQL).
- **A keyed identity read: 239 ms wall including network, sub-ms server-side seek.** The wall time is the round trip; the database work is the index seek plus one row fetch, which is the shape the whole identity payload was designed around (explicit column list, no blob).
- **The dial write load: 40 sequential counter upserts in 1.10 s over one connection** (~27 ms each, network-dominated). Two rows per metered request (a burst window and a daily window) is therefore ~55 ms of writes on a read that already costs 239 ms — acceptable, and the reason the dials ride the existing atomic limiter rather than anything new.

### ADPLA §3.3.6(D) — RETRIEVED 2026-07-29 (the clause the RFC left open)

Fetched from `developer.apple.com/support/downloads/terms/apple-developer-program/Apple-Developer-Program-License-Agreement-English.pdf` (the PDF the RFC recorded as declining a fetch; the dated filename 404s, the undated one serves). §3.3.6 is "Entertainment Technologies"; subsection D is MusicKit. The two operative sentences, verbatim:

> "You agree not to call the MusicKit APIs or use MusicKit JS (or otherwise attempt to gain information through the MusicKit APIs or MusicKit JS) for purposes unrelated to facilitating access to Your end users' Apple Music subscriptions."

> "You may play MusicKit Content only as rendered by the MusicKit APIs or MusicKit JS and only as permitted in the Documentation (e.g., album art and music-related text from the MusicKit API may not be used separately from music playback or managing playlists)."

**The read:** it does NOT permit third-party redistribution. Fluncle's Apple links come from the Apple Music API's exact-ISRC lookup, and serving them to an arbitrary machine caller is neither "facilitating access to Your end users' Apple Music subscriptions" nor use alongside playback or playlist management. So Apple ships `unsupported` in machine-served answers — now on a read clause rather than on an unread one — while first-party rendering on Fluncle's own pages continues unchanged. The full Apple state is still computed off its columns behind one constant (`APPLE_LINKS_MACHINE_SERVED`), so a future re-ruling is a one-line flip rather than a rebuild.

## The operator rulings (2026-07-29 interview) — recorded here for provenance

(1) Unlit confirmed — uncertified rows served, certified boolean the only tier carrier. (2) Artifact = reader page + `get_track` keyed extension; no standalone endpoint; no nightly dump for now (trigger: a real consumer, likely label outreach). (3) Posture A free; the links-map free-commitment is contract-scoped (Spotify V.5); Fluncle's own analysis stays monetizable later. (4) Pre-overhaul, build now. (5) No retirement trigger (nothing accretes standing cost). (6) Wrong-answer channel = hey@fluncle.com. (7) The Spotify hop served EVERYWHERE (stored raw, served `/out/spotify/<fluncleTrackId>`), carve-outs: JSON-LD/sameAs stays raw; the iOS app resolves the hop to preserve instant app-open. (8) Dials: 30/min/IP + 1,000/day/IP on the identity lookups. Interview addition: the Apple catalogue backfill cron leg is enabled (the biggest idle coverage lever — 33,853 ISRC-bearing rows to try).
