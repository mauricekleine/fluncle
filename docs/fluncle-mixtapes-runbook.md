# Fluncle's Mixtapes — runbook + spine model

How Fluncle publishes one of his own DJ mixtapes, and where it lives across the Galaxy. Planning + operator checklist, not spec: canon (DESIGN.md / PRODUCT.md / VOICE.md) arbitrates the words and the look; this doc carries the steps and the build map. Born from the first set, recorded 2026-06-18. Scoped to DJ mixtapes for now — if originals, edits, or guest sets ever appear, generalize this into "own publications" then, not before. ("Mixtape" is the canonical term; "mix" is the casual synonym.)

## The concept

A mixtape is **Fluncle dreaming**: the short-term memories that individual findings are (literally short — one track) consolidated into one long-term memory (literally long — a 30+ minute set). It's the **epilogue that closes a chapter** before the next one starts, a **checkpoint** on the progression path. A selector mixing his own findings is the real thing where an AI-made original would fight the persona.

The double read is the point, and it is the Depth Gradient in object form: **to outsiders it's just another mixtape; to insiders, a glimpse into Fluncle's subconscious** — surface-legible to anyone, deeper for the crew. The canon stubs live in PRODUCT.md (the object), DESIGN.md (the checkpoint row), and the Voice canon (`packages/skills/copywriting-fluncle/references/voice.md` — vocabulary + the Log ID marker).

## The object: a mixtape is not a finding

A finding is one banger Fluncle found. A mixtape is a consolidation of findings into one long recording. They're different kinds of object sharing the same spine, and the difference is load-bearing:

- A mixtape is **not a "find"** — it does **not** increment the `FOUND · N` counter.
- It is **not** in the finding stage flow (Enrich · Tag · YouTube · TikTok) on the `/admin` board.
- It is **not** a track (no single ISRC, no BPM/key chip row).
- It **is** a first-class object on the Log ID spine, with its own permanent identity and its own `/log` page.

## Identity — the mixtape Log ID

A mixtape gets a real Log ID in the same `XXX.Y.ZZ` family as a finding, distinguished by one fixed slot:

- **Sector (`XXX`)** = days since the epoch (2026-05-30) to the night the mixtape is recorded/published — identical rule to a finding. Tonight's set lands around `019`.
- **Marker (`F`)** = the middle slot is always the literal letter `F` (Fluncle). A finding's middle slot is a digit; a mixtape's is `F`. That single letter is the whole tell — quiet, learnable, and on-format.
- **Number (`ZZ`)** = the mixtape's sequence number as `<digit><letter>`, digit `1–9`, letter `A–F` (hex-flavored). `1A` is mixtape #1, `1B` is #2, … `1F` is #6, then it rolls to `2A` for #7, up to `9F` for #54. Always two characters, always digit-then-letter (the finding mark shape), so nothing screams. It's a human-meaningful count, not a content hash — and hex-flavored, so `1A` reads as "mixtape one", not decimal 26.

So tonight's mixtape — the first — mints as **`019.F.1A`**.

What this scheme buys:

- The number keeps the exact finding mark shape (`<digit><letter>`), so a mixtape coordinate reads as on-format and quiet; only the middle `F` distinguishes it on sight.
- A `XXX.F.ZZ` coordinate **can never collide with a finding** (findings carry a digit in the middle slot), so **no finding-alphabet surgery is needed** — the `F` does all the work.
- Sequential mint is collision-free, and the number is meaningful ("Mixtape No. 6").

Notes:

- **Cap: 54** (9 digits × 6 letters). Past that, extend the alphabet or the digit range — a bridge to cross then.
- **Minting:** nothing counts in the system today — findings derive their tail from an FNV-1a hash of the recording's ISRC (`apps/web/src/lib/server/log-id.ts`), with the sector from the date. The mixtape number is the first sequential element, and the separate `mixtapes` table (below) _is_ the counter: the next number is `max(existing) + 1`, encoded into `<digit><letter>` (number N → digit `floor((N-1)/6)+1`, letter `A–F` at index `(N-1) mod 6`). No separate counter primitive needed. Same shape as a finding (sector = day, tail = the identifying signature), but the tail is a sequence here, not a content hash.
- A mixtape Log ID is **minted once, never reassigned**, same contract as a finding's.

## URL — one universal resolver

`fluncle://<id>` resolves through **`/log/<id>`** for both findings and mixtapes — one identity, many representations, no second URL namespace. The log page renders the **mixtape flavor**: the member tracklist (each track linked to its own `/log/<id>`), the embedded Mixcloud/YouTube player, and the dream note. The CLI/SSH/API resolvers stay universal too; they return a mixtape-typed object when the coordinate's middle slot is `F`.

## Two ways in: quiet inclusion + a front door

A mixtape slips **quietly into the existing track surfaces** (the feed, `recent`, the API) as one more row — the checkpoint row of DESIGN.md, not a banner. It **also gets a dedicated surface** for anyone looking specifically for an overview of mixtapes:

- **Web** — a `/mixtapes` index (the mixtape archive, newest first).
- **API** — `/api/mixtapes` (mixtapes as JSON).
- **CLI** — `fluncle mixtapes`.
- **SSH** — a mixtapes view in the rave terminal.

Quiet in the feed; a real front door for the overview.

## Mixtape-aware for machines (SEO / AEO)

Crawlers, bots, and AI answer engines must read a mixtape **as a DJ mixtape**, not as a single track. This awareness lives in the **structured layer**, not the Log ID string:

- **schema.org** — type a mixtape as a `MusicAlbum` with `albumProductionType: DJMixAlbum` (the `MixtapeAlbum` production type is the close alternative; pick one at build, verify the enum), tracklist as `track` entries linking each member finding — distinct from a finding's `MusicRecording`.
- **RSS** — flag mixtape items in the observation feed (a `<category>` / distinct treatment) so the feed is honestly two item types, not one.
- **llms.txt** — a clearly-labeled **Mixtapes** section stating these are Fluncle's own DJ mixtapes consolidating findings, each with its own coordinate, so an agent reading the file knows the archive has two object types.

## Hosting — where the audio and video go

- **Mixcloud — primary home.** Properly licensed (direct deals with the majors + indies like Ninja Tune / XL via Merlin): it plays legally and pays the featured artists, within the Featured-Artist / SRPC limits. Two failure tiers to stay clear of: exceeding the consecutive rule (≤ 3 per artist consecutive, ≤ 2 per release consecutive) makes the show **regionally unavailable**; **4–8 tracks from one artist makes the whole show Premium / subscriber-only globally** (a hard paywall). The curator waiver doesn't apply. Trivial for a varied D&B set — observe, don't pre-lint; if a show ever gets gated it's visible on Mixcloud and fixable by hand (audio can't be swapped — delete + re-upload). Upload is **CLI-direct** with the operator's own token.
- **YouTube — reach mirror.** Content ID claims it: the video stays up but the labels monetize it. Good for reach, not revenue. The **mixtape video** lives here, uploaded via Fluncle's own OAuth (`youtube_auth`) — published unlisted, flipped public by the operator.
- **SoundCloud — secondary mirror.** Patchier (takedown risk). Profile presence is the separate roadmap item; hosting actual audio there is the licensing-gated question this runbook owns.
- **Teaser clips.** Short clips cut from the set go to the social surfaces (TikTok / Shorts / IG) the same way a finding's clip does — the clip is a trailer for the mixtape, captioned with the mixtape's `fluncle://<id>` coordinate. (Clip-of-a-mixtape has no pipeline yet; see Open questions.)

## Titles + covers

- **Title — the same string everywhere** (the spine `title` on `/log`, Mixcloud, YouTube, SoundCloud): `Fluncle Drum & Bass Mixtape #N | XXX.F.ZZ`. Searchable genre up front, the coordinate as the unique tail. It's an **output, not an input** — `publishMixtape` mints it from the number + coordinate; there's no title field on the draft. The `title` column stays so a future non-"Mixtape #N" series can carry its own name (publish leaves a non-stub title untouched). The title stays plain and consistent; the **dream note** carries the cryptic/evocative weight.
- **The note → the description, with a `fluncle://` breadcrumb (external only).** The dream note doubles as the YouTube / Mixcloud description, with the mixtape's `fluncle://<logId>` coordinate appended as a derived suffix (the note, a blank line, then `fluncle://<logId>`). The marker is **never stored in the `note` column** and is **appended only when the description is built for the platforms at upload**. Internally, `/log` shows the clean stored note — the coordinate is already on the page as the mixtape's identity, so no marker there. The breadcrumb points the external platforms (where the spine isn't otherwise visible) back to fluncle.com.
- **Covers render on the fly, fully derived** — no per-mixtape render step, no stored cover, no input. `GET /api/mixtape-cover/<logId>?size=square|og|wide` is an edge route (`workers-og`/Satori, same path as the finding OG card) that stamps `MIXTAPE #N` + the coordinate over a fixed Deep-Field background. A published mixtape's cover URL is derived from its Log ID (`mixtapeCoverUrl`); the `cover_image_url` column was dropped.
  - **Square 1500×1500** (`size=square`) → Mixcloud + SoundCloud artwork, and the mixtape's `coverImageUrl` on `/log`.
  - **16:9 1280×720** (`size=wide`) → the YouTube thumbnail.
  - **1200×630** (`size=og`) → the `/log` link-preview (OG) card.
  - The shared background (cosmonaut on the One-Sun Deep Field, grain) is baked once by `bun run --cwd packages/media render:mixtape-bg` (the `<MixtapeCover>` composition with `markers: false`) and **hosted on R2 at `found.fluncle.com/mixtape/bg-{square,wide,og}.jpg`** — the cover endpoint fetches it **cross-origin** (it must not live on `www`, or a Worker self-fetch loops to the SPA fallback and the cover renders black). The render script writes the jpgs to `packages/media/out/mixtape-bg/` and prints the `wrangler r2 object put` upload recipe. Re-run + re-upload only when the art changes; iterate it with the `fluncle-video` kit. Remotion is no longer in the publish path.

## Editing after publish

Publishing is the irreversible-ish step, but only the **coordinate** is truly frozen (enforced in `updateMixtape`):

- **Minting requires the substance, not the links** — a recorded date, a dream note, a duration, and ≥ 1 tracklist member. A draft is just the operator-authored subset; `publishMixtape` verifies it, then mints the Log ID + number + title into the `distributing` state. The external link is **not** a mint gate — distribution supplies it (the mint-first reshape; see [the autopublish RFC](./rfcs/mixtape-autopublish-rfc.md)). No empty, substance-less mixtape goes live.
- **The lifecycle:** `draft` → (mint) `distributing` (coordinate committed, cover renders, hidden from public) → (first platform link) `published`. A `distributing` mixtape is edit-locked like a published one and can't be deleted (it owns a committed coordinate); a totally failed distribution leaves it `distributing` with its Log ID held for retry, never a linkless public mixtape.
- **After publish you can still edit** the note and the external links — add YouTube after Mixcloud, add SoundCloud later. (Title and cover are derived from the coordinate, so there's nothing to edit there.)
- **You can never remove the last link** — a published mixtape must always keep somewhere to listen.
- **Frozen once minted:** the Log ID + sequence number, the title + cover derived from them, the `recordedAt` (its sector is baked into the coordinate), and the **tracklist** (members stay draft-only — the minted set is the record).

## Tracklist — the breadcrumb

The required tracklist **is the breadcrumb**, and the AEO/SEO play. Write each track as its finding: `Artist — Title`, its `fluncle://<log-id>` coordinate, and a `/log/<id>` link (Mixcloud tracklist; YouTube description + chapters). Owned surfaces and authentic scene presence pointing back at fluncle.com — directly advancing the off-site thread's "authentic presence where dnb lives". A member track that isn't a finding yet is an open question below (add it as a finding first, or allow non-finding members).

## MusicBrainz + Wikidata

- **MusicBrainz DJ-mix release.** Add the mixtape as a DJ-mix release (Fluncle as the mix artist, tracklist = the real recordings). The on-brand way to make the MusicBrainz artist (`53346748-1357-45c0-a847-9d248b65d655`) substantial and settle the "is this a real artist" question — no AI original needed.
- **Close the loop to Wikidata.** A real release is exactly the kind of fact the off-site thread wants accumulating on `Q140169844`: link the MusicBrainz release / add the mixtape as the artist's work once it exists.

## The spine-native fan-out (build map)

Mirroring the finding ladder, this is where a mixtape lands and what each surface needs:

| Surface                | A finding does     | A mixtape does                                                                                           |
| ---------------------- | ------------------ | -------------------------------------------------------------------------------------------------------- |
| Web feed               | a finding row      | a quiet **checkpoint row** (own cover/title, member count + run time instead of the chip row; DESIGN.md) |
| Web index              | the archive        | a dedicated **`/mixtapes`** overview                                                                     |
| `/log/<id>`            | observation page   | **compilation page**: member tracklist (each linked), embedded Mixcloud/YouTube, the dream note          |
| CLI                    | `fluncle log <id>` | resolves to the mixtape; quiet in `recent`; listed by `fluncle mixtapes`                                 |
| API                    | `/api/tracks/<id>` | mixtape-typed payload (members, external URLs, duration); `/api/mixtapes` index                          |
| RSS                    | observation entry  | a flagged **mixtape** entry in the feed                                                                  |
| MCP                    | list/random/search | the mixtape reachable as the same typed object                                                           |
| SSH                    | the rave terminal  | a checkpoint + a mixtapes view                                                                           |
| Machines               | `MusicRecording`   | `MusicAlbum` / `DJMixAlbum` schema, RSS category, llms.txt Mixtapes section                              |
| MusicBrainz / Wikidata | artist anchors     | the DJ-mix release → the Wikidata fact                                                                   |

## Announce — the four owned surfaces

Once a mixtape is live on the spine, make the crew aware of it on Fluncle's own channels (all in-voice; draft with the `copywriting-fluncle` skill):

- **Telegram crew channel** — a post with the Mixcloud link and the `fluncle://<id>` coordinate.
- **Friday newsletter** — a mention/feature in the weekly letter (the mothership).
- **Website / home** — surface it: a link in the social row and/or the checkpoint row in the feed.
- **CLI / SSH** — a line pointing to the mixtape where output already prints URLs.

## The runbook (repeatable, per mixtape)

**Phase A — Record + archive** (the only phase for the first set tonight):

1. Record the set.
2. Capture the assets: the mixtape audio master, the mixtape video, any teaser clips.
3. Lock the tracklist with each track's member Log ID and `/log/<id>` link.
4. Archive the raw assets to the operator path (R2), like a finding's analysis archive.

**Phase B — Build/confirm the spine home** (first time only, then reused):

- The data model, Log ID minting (the `mixtapes` table is the counter), the `/log/<id>` mixtape flavor, the `/mixtapes` surfaces, the `DJMixAlbum` schema/RSS/llms.txt awareness, and the per-surface rendering from the fan-out map above.

**Phase C — Publish:** one CLI command distributes a mixtape's video→YouTube + audio→Mixcloud and records the links (see [the autopublish RFC](./rfcs/mixtape-autopublish-rfc.md)). The CLI moves the bytes (the Worker can't proxy a multi-GB master); the Worker mints the coordinate and records the outcome. The flow is **mint-first**: `publishMixtape` mints the draft into a non-public **`distributing`** state (the cover renders, public surfaces stay hidden), the uploads carry the committed Log ID, and the **first successful platform link flips it `published`** — so a public mixtape always has somewhere to listen.

_One-time setup (per machine):_

- `fluncle admin auth youtube` — opens Google's consent screen; the durable refresh token is stored server-side in `youtube_auth` (the dashboard "Make public" button + the resumable upload both ride on it). Precondition: the `@fluncle` channel is phone-verified (done) — without it, uploads over 15 min fail at insert.
- `fluncle admin auth mixcloud` — prints a Mixcloud authorize URL (same shape as `auth youtube`); approve, and Mixcloud returns to the admin callback which exchanges the code and stores the token server-side in `mixcloud_auth`. The durable credential never touches the CLI — at upload time the CLI fetches it just-in-time from the Worker for the CLI-direct POST (only the bytes are CLI-side). Token revocable; re-run if a later upload reports an invalid token. (Secrets live on Cloudflare: `MIXCLOUD_CLIENT_ID/SECRET/REDIRECT_URI`.)

_Per mixtape, from the Mac where the assets live:_

1. **Distribute.** `fluncle admin mixtapes distribute <idOrLogId> --video <mixtape>.mp4 --audio <master>` (omit a flag to target one platform). The CLI mints the coordinate if it's still a draft, then: streams the video to YouTube (**unlisted**, title + description ending in `fluncle://<logId>` + the cued chapter block, the wide cover set best-effort as the thumbnail; resumes on a mid-upload token expiry or dropped session), and POSTs the full-quality master to Mixcloud (name + description + square cover + a per-track `sections[]` tracklist from cued members, published **listed** directly). Each leg records into `mixtape_social_posts`, dual-writes `mixtapes.{youtube,mixcloud}_url`, and flips the mixtape public on the first link.
2. **Make YouTube public** (the recurring human gate — one action): the `/admin/mixtapes` **Make YouTube public** button, or `fluncle admin mixtapes publish-youtube <idOrLogId>`. Server-side `videos.update` (the Worker holds the token).
3. **(Optional) SoundCloud mirror** — manual for now (API registration is externally gated); paste the link via the editor. The data model accepts it with no rework.
4. **MusicBrainz DJ-mix release**, then the Wikidata loop.
5. **Confirm + retry.** Watch the `/admin/mixtapes` Distribution strip; a failed leg stays retryable (re-run `distribute` — idempotent per platform, reuses the committed Log ID). Confirm the spine entry is live: feed checkpoint row, `/mixtapes` index, the `/log` page, and the API / RSS / MCP / CLI / SSH resolvers, and the `llms.txt` Mixtapes section.

_Limits + crash recovery._ YouTube `videos.insert` is metered in the separate **Video Uploads bucket (~100/day** post-Dec-2025), 256 GB / 12 h per video — a non-issue at this cadence; Content ID will claim the mix (it stays up, labels monetize). Because the Log ID is committed before upload, a crash between a successful PUT and finalize leaves a live unlisted video with the right coordinate; re-running may create a duplicate unlisted video to delete in YouTube Studio.

**Phase D — Announce:** Telegram → newsletter → home → CLI/SSH line.

**Phase E — Verify:** every surface resolves `fluncle://<id>`; every tracklist link lands the right `/log/<id>` page; the schema validates as a `DJMixAlbum`.

## Tonight (first set, 2026-06-18)

Scope is **Phase A only**: record, capture the assets, lock the tracklist with member Log IDs, archive the raw files. Publishing waits on the Phase B build so the mixtape lands everywhere at once rather than as orphaned external links. The first mixtape will mint as **`019.F.1A`**. Capture the teaser clips tonight even though the clip-of-a-mixtape pipeline isn't built — they're raw material we don't want to re-shoot.

## Galaxy tie-in (future, not now)

A mixtape sits at its sector, which the Galaxy game maps to a distance from Earth — so a mixtape is a natural **checkpoint / forward base / waystation** out there. That overlaps the parked "new home planets as forward bases / respawn + refuel hubs" idea in the Galaxy backlog: the metaphor and the game mechanic want the same object. Note it; don't build it here.

## Open questions / build tasks

> **Internal plumbing shipped** (PRs #18 / #20 / #21): separate `mixtapes` / `mixtape_tracks` tables, the draft→publish lifecycle, publish-time `XXX.F.ZZ` minting, admin create/edit/member/publish routes, `/log/<id>` mixtape resolution, quiet feed inclusion, `/mixtapes`, `/api/mixtapes`, `fluncle mixtapes`, MCP inclusion, RSS category, sitemap entries, `DJMixAlbum` JSON-LD, and `llms.txt` awareness. A mixtape is still not a finding, does not increment `FOUND`, and stays out of the admin board, tag queue, and Stories feed. (A mixtape added inside the week's window now rides along in the Friday newsletter — its own "Fresh off the decks" section; see [newsletter-agent.md](./newsletter-agent.md).) (The design RFC that scoped this has been retired now that it's built; remaining follow-ups live in `ROADMAP.md` → _Fluncle's own mixtapes_.)

- **Member tracks that aren't findings yet:** add them as findings first, or allow non-finding members in a mixtape's tracklist.
- **SSH mixtapes view:** the web/API/CLI/MCP front doors exist; the rave terminal view is still a future surface.
- **Clip-of-a-mixtape pipeline:** how teaser clips get cut, captioned, and pushed.
- ~~**OG image:** a per-mixtape `/log` page OG card.~~ Shipped: `/api/mixtape-cover/<logId>?size=og` renders it on the fly (see Titles + covers).
- **External publishing chain:** Mixcloud upload, YouTube mirror, optional SoundCloud mirror, MusicBrainz DJ-mix release, Wikidata loop, and announce posts remain out of this plumbing build.

## Cross-links

- **Canon:** PRODUCT.md (Mixtapes — Fluncle dreaming), DESIGN.md (Checkpoint Row), the Voice canon (the `mixtape` vocabulary entry + the `F` Log ID marker).
- **Roadmap:** this doc absorbs the former "A Fluncle DJ mix" item. The SoundCloud profile item and the off-site MusicBrainz/Wikidata thread stay on `ROADMAP.md` and cross-link here.
