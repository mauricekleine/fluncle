# RFC: Last.fm + Discogs — sync-on-add and the music-data graph

**Status:** Research complete (APIs verified live + via Context7; accounts inspected read-only, 2026-06-20). For Maurice's two decisions + the secret provisioning below; the build is small once those land.
**For:** a fresh build session, plus Maurice for the API-key/token + the curation-semantics call.
**Canon/authority:** the codebase and `AGENTS.md` arbitrate; `docs/track-lifecycle.md` (the add → enrich flow + the Worker-owned-secret pattern), `docs/socials/README.md` (the identity map), and `docs/public-surfaces-checklist.md` (the open Last.fm / Discogs / Discogs-ID items) are ground truth. This is planning under `docs/`, not spec.

> Why this exists: the task was "each time I add a song to the galaxy, sync it to Last.fm / Discogs if trivial; else write a doc." Both turned out **non-trivial-to-just-do** — each needs a secret only Maurice can provision, and Last.fm carries a real brand question (sync = "listened", which Fluncle isn't claiming). The trivial, no-decision win — adding both profiles to the identity/`sameAs` set — already shipped in the same change as this doc (`docs/socials/README.md` + `fluncle-links.ts` → `about.tsx` + `-about-schema.test.ts`). This RFC is the rest.

---

## 0. Summary / the reframe

- **The accounts are live and already corroboration anchors.** Last.fm `fluncle` (https://www.last.fm/user/fluncle) and Discogs `fluncle` (https://www.discogs.com/user/fluncle, user `31223733`) both exist, both carry the tagline bio, both have the cosmonaut avatar. They are the same _kind_ of independent music-graph identity as MusicBrainz/Wikidata, so they are now in `sameAs` (shipped). This is the guaranteed win and it needed no secret and no decision.
- **"Sync a finding" is not one thing — and the obvious mapping is the wrong one.** A Last.fm **scrobble** means _Fluncle listened to this track just now_. That is a listening log, not a curation signal, and Fluncle's whole brand is "I heard it in full and certified it" — back-dated mass scrobbles on add would be a fabricated listening history (and Last.fm's own rules say only scrobble a real play). The honest mapping for "this is a certified finding" is **`track.love`** (a Loved Track = an explicit endorsement), not a scrobble. See §1.
- **Both writes need a secret only Maurice can create, so neither is "just do it."** Last.fm needs an **API key + shared secret + a one-time-authorized session key**; Discogs needs a **personal access token** (or full OAuth). The agent/Worker can hold these the same way it holds `POSTIZ_API_KEY` / `SPINUP_*` today, but provisioning them is a human step in Maurice's accounts (the task explicitly forbade doing it for him). So this is documented, not auto-built.
- **The genuinely-useful Discogs move is the read, not the write.** A Discogs **release lookup** (public, no token, just a polite User-Agent) closes the open `[ ] Discogs ID` checklist item and feeds real release metadata (label, year, styles, genres) into enrichment. That part needs no secret — but it does touch the schema (a new column + migration) and the add/enrich path, so it is a small real build, not a one-liner. Recommended as the first thing to actually ship. See §2.2.
- **Recommended order:** (1) `sameAs` — done. (2) Discogs **release-ID enrichment** (read-only, no decision, closes a checklist item) once Maurice okays the schema column. (3) Last.fm **`track.love` on add** once Maurice provisions the key/secret/session and confirms the "love, not scrobble" semantics. (4) Optional later: a Discogs **List** of the findings (write, needs the token).

---

## 1. Last.fm

### 1.1 What "sync a finding" should map to (the brand question — Decision #1)

Three candidate write methods, with what each _claims_:

| Method           | Means                                                      | Fit for a curated finding                                                                                                                                                                                                                                                                                    |
| ---------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `track.scrobble` | "a user played this track at time T"                       | **Wrong.** Fabricates a listening history. Fluncle's claim is _certification_, not a play-count. Back-dating one scrobble per finding invents data; Last.fm's ToS says only scrobble real plays (>30s, half the track). A curation brand publishing a fake listening log is off-canon and risks the API key. |
| `track.love`     | "this user endorses this track" — a public **Loved Track** | **Right.** A Loved Track _is_ an endorsement, which is exactly what a certified finding is. The profile already exposes a "Loved Tracks" tab; it would fill with the findings and read as "what Fluncle co-signs." One write per add, idempotent (loving twice is a no-op).                                  |
| `track.addTags`  | attach personal tags to a track                            | Optional add-on. Could tag each finding `fluncle` (and maybe the galaxy: solar/nebular/lunar/deep). Nice for the data graph, secondary to `love`.                                                                                                                                                            |

**The recommendation: `track.love` on add, never `scrobble`.** It is the only one that tells the truth about what Fluncle does. (If a "now playing on the rave terminal / Twitch DJ stream" feature ever wants a _real_ listening signal, `track.scrobble` / `track.updateNowPlaying` is the right tool _there_ — for an actual play — but not for the add flow.)

A caveat to surface to Maurice: matching a finding to Last.fm's catalog is **by `{artist, track}` strings**, not by ISRC/Spotify id (Last.fm has no ISRC lookup). `track.love` takes `artist` + `track` names; mismatches/remix-title drift will silently miss. `track.getCorrection` can normalize first. This is best-effort, like the Deezer label lookup already in the add flow.

### 1.2 The API + auth (verified against last.fm/api, 2026-06-20)

- **Root:** `http://ws.audioscrobbler.com/2.0/`, REST, XML by default — pass `format=json` for JSON. Identifiable `User-Agent` required.
- **All write methods require authentication.** Auth for a server-side single-user app is the three-step web/desktop flow, run **once**:
  1. `auth.getToken` → an unauthorized request token.
  2. Send the user to `https://www.last.fm/api/auth/?api_key=KEY&token=TOKEN` and approve in the browser (one time, Maurice clicks "Yes, allow access").
  3. `auth.getSession` (signed) → a **session key (`sk`)** that **does not expire**. Store it; it is the durable credential.
- Every authenticated call is signed: `api_sig = md5( <all params name+value, alphabetized> + shared_secret )` (the `format`/`callback` params are excluded from the signature). The call then carries `api_key`, `sk`, and `api_sig`. POST, form-urlencoded.
- **Getting the API key + secret is a human step:** create an application at https://www.last.fm/api/account/create (logged in as `fluncle`). That yields the **API key** + **shared secret**. Commercial use is supposed to email partners@last.fm first — a curation side-project is plausibly fine, but that is Maurice's call to make.

So the durable secrets are three: **API key**, **shared secret**, **session key** — all created by Maurice, none derivable by an agent.

### 1.3 Where it hooks in

Same shape as the existing Telegram post in `publishTrack()` (`apps/web/src/lib/server/publish.ts`): after the Spotify + Telegram writes succeed, fire a best-effort `track.love`. It is a single signed HTTPS call — cheap, Worker-safe (no ffmpeg/compute), so it belongs in **Phase 1 (the synchronous add in the Worker)**, not the Spinup agent. The Worker already owns every platform secret (`env.ts`); add:

- `LASTFM_API_KEY`, `LASTFM_API_SECRET`, `LASTFM_SESSION_KEY` to the `envKeys` array in `apps/web/src/lib/server/env.ts` (the same pattern as `TELEGRAM_BOT_TOKEN`, `POSTIZ_API_KEY`).
- a new `apps/web/src/lib/server/lastfm.ts` (mirroring `telegram.ts` / `deezer.ts`): a signed `lastfmLove(artist, track)` helper.
- a best-effort call in `publishTrack()` wrapped so a Last.fm failure **never** fails the add (it is a side-channel, like Deezer enrichment — log + continue; do not `throw`).

MD5 + a sorted-param signer is ~15 lines; `crypto.createHmac`/`createHash` is already imported in `env.ts`, so no new dependency. The CLI stays a thin client — it never holds the Last.fm secret; the Worker makes the call.

### 1.4 What we need from Maurice (Last.fm)

1. **Decision:** confirm **`track.love`, not `track.scrobble`** (no fake listening history). Optionally also `track.addTags` with `fluncle` + the galaxy.
2. **Provision (in the `fluncle` Last.fm account):** create the API application → get **API key** + **shared secret**; run the one-time browser auth → get the **session key**. Drop all three in 1Password (Fluncle vault) + set them as Worker secrets. (Optional: clear the commercial-use question with partners@last.fm.)
3. Then the build is the small `lastfm.ts` + the `publishTrack` hook above.

---

## 2. Discogs

### 2.1 The API + auth (verified via Context7 + the public API, 2026-06-20)

- **Root:** `https://api.discogs.com`, JSON. **Identifiable `User-Agent` is mandatory** (Discogs rejects/limits generic agents). Rate limit: ~60 req/min authenticated, ~25/min unauthenticated, per the docs — fine for one call per add.
- **Auth options:**
  - **Personal access token** — generated in Discogs developer settings, single-user, sent as a header/param. This is the simple path and the right one for a single-account write (`Client('ua', user_token=…)`). Still a secret only Maurice can create.
  - **OAuth 1.0a** — full three-legged flow (consumer key/secret → request token → authorize → access token). Only needed for multi-user apps; overkill here.
  - **None** — public reads (release lookup, a user's _public_ Lists) need no auth, just the User-Agent. The `fluncle` user object, public Lists, etc. are readable now; **collection folders require owner auth** (verified: the folders endpoint returns "authenticate as the owner").
- **The public read that matters:** `GET /database/search?type=release&artist=…&track=…` (or `&q=`) → release candidates; `GET /releases/{id}` → full metadata (tracklist, **labels**, **year**, **genres**, **styles**, videos). This is the open `[ ] Discogs ID` checklist item.
- **Writes (need the token):** add a release to a collection folder (`POST /users/{u}/collection/folders/{folder}/releases/{release}`), or create/append a **List** (a curated, public, ordered set — the natural "Fluncle's Findings on Discogs" surface).

### 2.2 Where it hooks in — and the honest "trivial?" verdict

**The read (Discogs release ID + metadata) is the recommended first ship and needs no secret** — but it is _not_ a one-liner, so it is documented here rather than bolted in unreviewed:

- It belongs in **Phase 1** (cheap HTTP, alongside the Deezer-by-ISRC lookup in the add flow) or Phase 2 enrichment — either is defensible; Phase 1 keeps it next to the existing Deezer label/preview lookup it most resembles.
- It needs a new **`discogs_release_id`** column on `tracks` (and probably `discogs_master_id`), which means a generated migration (`bun run --cwd apps/web db:generate` — never hand-written, per `AGENTS.md`) and a `docs/track-lifecycle.md` data-model row.
- Matching is fuzzy (`{artist, title}` → search → pick best release), like the Last.fm match problem. Discogs has no ISRC search, so it is best-effort; store the id only on a confident match.
- Payoff: closes `[ ] Discogs ID` in `docs/public-surfaces-checklist.md`, and the release metadata (label/year/styles) corroborates and could enrich the log page + JSON-LD. The `discogs.com/release/{id}` URL is a per-finding `sameAs` for the **track** (distinct from the artist-level `sameAs` already added).

**The write (a Discogs List or collection of the findings) needs the token** and is the lower-priority, brand-flavored move:

- A **List** ("Fluncle's Findings") is the better fit than a collection — a List is explicitly a curated, public, ordered set; a collection reads as "records I own," which Fluncle doesn't claim. The user currently has **0 lists**.
- Same hook shape as Last.fm: a best-effort `lib/server/discogs.ts` call in `publishTrack()`, Worker-owned `DISCOGS_USER_TOKEN`, never fails the add.
- This requires the release ID from the read step first (you append a _release_ to a List), so it is naturally **step 4**, after the read lands.

### 2.3 What we need from Maurice (Discogs)

1. **Okay the schema column** (`discogs_release_id`) so the read-only enrichment can ship — this is the no-secret, checklist-closing win and needs only your go-ahead on the data-model change.
2. **If/when you want the List write:** generate a **personal access token** in Discogs developer settings (account `fluncle`), into 1Password + Worker secret `DISCOGS_USER_TOKEN`. Decide **List vs collection** (recommend List — curation, not ownership).

---

## 3. Asks-from-Maurice (the short version)

| #   | Ask                                                                                                                      | Unblocks                                                               | Cost                    |
| --- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- | ----------------------- |
| 1   | Confirm Last.fm sync = **`track.love`**, not scrobble (no fabricated listening log)                                      | the Last.fm hook's whole premise                                       | a decision              |
| 2   | Last.fm: create API app → **key + secret**, run one-time browser auth → **session key**; into 1Password + Worker secrets | `lastfm.ts` + the `publishTrack` love-on-add                           | ~10 min in your account |
| 3   | Okay a `discogs_release_id` column on `tracks`                                                                           | read-only Discogs-ID enrichment (closes the checklist item, no secret) | a yes                   |
| 4   | _(later)_ Discogs **personal access token** + List-vs-collection call                                                    | the "Fluncle's Findings" Discogs List write                            | ~5 min + a decision     |

Nothing here was done in your accounts (read-only inspection only, per the brief): no API apps created, no scrobbles, no loves, no lists, no collection edits.

---

## Appendix — live findings (read-only, 2026-06-20)

- **Last.fm `fluncle`** — exists, scrobbling since 20 Jun 2026, **0 scrobbles / 0 artists** (fresh). About = "Drum & bass bangers from another dimension." (a stray trailing " ." — cosmetic, not in scope). Cosmonaut avatar set. Exposes Library / Playlists / **Loved Tracks** / Tags / Scrobbles. The MCP Chrome profile was **logged out** (nav showed Log In / Sign Up; `/api/account/create` redirected to login) — so the API-app/settings pages couldn't be read while authed; the public profile + the official `last.fm/api` docs gave everything needed.
- **Discogs `fluncle`** — confirmed via the public API (`GET https://api.discogs.com/users/fluncle`): id `31223733`, registered `2026-06-20`, `home_page` www.fluncle.com, profile "Drum & bass bangers from another dimension. www.fluncle.com.", avatar set, **`num_lists: 0`**, `num_for_sale: 0`. Public Lists endpoint returns an empty list; **collection folders require owner auth** ("authenticate as the owner"). The Discogs site is behind a Cloudflare Turnstile bot challenge for logged-out browsers, so the authed settings UI wasn't read; the public API + Context7's Discogs client docs grounded the auth/capabilities.
- **API facts** are from last.fm/api (method list incl. `track.love` / `track.scrobble` / `track.addTags`; "all write services require authentication"; the `auth.getToken`→authorize→`auth.getSession` flow and the `md5(params+secret)` signature) and the Discogs developer docs via Context7 (personal-token vs OAuth, `add_release` to a folder, Lists, release lookup, User-Agent + rate limits).
