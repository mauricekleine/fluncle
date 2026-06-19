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

- **Mixcloud — primary home.** Properly licensed (direct deals with the majors + indies like Ninja Tune / XL via Merlin): it plays legally and pays the featured artists, within the Featured-Artist / SRPC limits (≤ 4 tracks per artist, ≤ 3 per album, tracklist required — trivial for a varied D&B set).
- **YouTube — reach mirror.** Content ID claims it: the video stays up but the labels monetize it. Good for reach, not revenue, with a minor regional-block / strike risk. The **mixtape video** lives here.
- **SoundCloud — secondary mirror.** Patchier (takedown risk). Profile presence is the separate roadmap item; hosting actual audio there is the licensing-gated question this runbook owns.
- **Teaser clips.** Short clips cut from the set go to the social surfaces (TikTok / Shorts / IG) the same way a finding's clip does — the clip is a trailer for the mixtape, captioned with the mixtape's `fluncle://<id>` coordinate. (Clip-of-a-mixtape has no pipeline yet; see Open questions.)

## Titles + covers

- **Title — the same string everywhere** (the spine `title` on `/log`, Mixcloud, YouTube, SoundCloud): `Fluncle Drum & Bass Mixtape #N | XXX.F.ZZ`. Searchable genre up front, the coordinate as the unique tail. Auto-set at publish (`publishMixtape` canonicalizes the draft stub once the number + coordinate exist; a title the operator typed is left as-is). The title stays plain and consistent; the **dream note** carries the cryptic/evocative weight (and doubles as the platform descriptions).
- **Covers render on the fly** — no per-mixtape render step. `GET /api/mixtape-cover/<logId>?size=square|og|wide` is an edge route (`workers-og`/Satori, same path as the finding OG card) that stamps `MIXTAPE #N` + the coordinate over a fixed Deep-Field background. At publish, an empty cover is filled with the `size=square` URL automatically; the operator can still paste a custom `coverImageUrl` to override.
  - **Square 1500×1500** (`size=square`) → Mixcloud + SoundCloud artwork, and the mixtape's `coverImageUrl` on `/log`.
  - **16:9 1280×720** (`size=wide`) → the YouTube thumbnail.
  - **1200×630** (`size=og`) → the `/log` link-preview (OG) card.
  - The shared background (cosmonaut on the One-Sun Deep Field, grain) is baked once by `bun run --cwd packages/media render:mixtape-bg` into `apps/web/public/mixtape-bg-{square,wide,og}.png` (the `<MixtapeCover>` composition with `markers: false`). Re-run only when the art changes; iterate it with the `fluncle-video` kit. Remotion is no longer in the publish path.

## Editing after publish

Publishing is the irreversible-ish step, but only the **coordinate** is truly frozen (enforced in `updateMixtape`):

- **Publish requires ≥ 1 external link** (Mixcloud / YouTube / SoundCloud) — no empty, substance-less mixtape goes live.
- **After publish you can still edit** the title, note, cover, and the external links — add YouTube after Mixcloud, swap a cover, add SoundCloud later.
- **You can never remove the last link** — a published mixtape must always keep somewhere to listen.
- **Frozen once published:** the Log ID + sequence number, the `recordedAt` (its sector is baked into the coordinate), and the **tracklist** (members stay draft-only — the published set is the record).

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

**Phase C — Publish:**

1. Mint the mixtape Log ID (sector = today; `F` marker; the next sequence number).
2. Upload to Mixcloud with the tracklist breadcrumbs.
3. Mirror the video to YouTube (description + chapters carry the breadcrumbs).
4. (Optional) SoundCloud mirror.
5. MusicBrainz DJ-mix release, then the Wikidata loop.
6. Confirm the spine entry is live: feed checkpoint row, `/mixtapes` index, the `/log` page, and the API / RSS / MCP / CLI / SSH resolvers.
7. Update `llms.txt` (the Mixtapes section).

**Phase D — Announce:** Telegram → newsletter → home → CLI/SSH line.

**Phase E — Verify:** every surface resolves `fluncle://<id>`; every tracklist link lands the right `/log/<id>` page; the schema validates as a `DJMixAlbum`.

## Tonight (first set, 2026-06-18)

Scope is **Phase A only**: record, capture the assets, lock the tracklist with member Log IDs, archive the raw files. Publishing waits on the Phase B build so the mixtape lands everywhere at once rather than as orphaned external links. The first mixtape will mint as **`019.F.1A`**. Capture the teaser clips tonight even though the clip-of-a-mixtape pipeline isn't built — they're raw material we don't want to re-shoot.

## Galaxy tie-in (future, not now)

A mixtape sits at its sector, which the Galaxy game maps to a distance from Earth — so a mixtape is a natural **checkpoint / forward base / waystation** out there. That overlaps the parked "new home planets as forward bases / respawn + refuel hubs" idea in the Galaxy backlog: the metaphor and the game mechanic want the same object. Note it; don't build it here.

## Open questions / build tasks

> **Internal plumbing shipped** (PRs #18 / #20 / #21): separate `mixtapes` / `mixtape_tracks` tables, the draft→publish lifecycle, publish-time `XXX.F.ZZ` minting, admin create/edit/member/publish routes, `/log/<id>` mixtape resolution, quiet feed inclusion, `/mixtapes`, `/api/mixtapes`, `fluncle mixtapes`, MCP inclusion, RSS category, sitemap entries, `DJMixAlbum` JSON-LD, and `llms.txt` awareness. A mixtape is still not a finding, does not increment `FOUND`, and stays out of the admin board, tag queue, Stories feed, and newsletter windows. (The design RFC that scoped this has been retired now that it's built; remaining follow-ups live in `ROADMAP.md` → _Fluncle's own mixtapes_.)

- **Member tracks that aren't findings yet:** add them as findings first, or allow non-finding members in a mixtape's tracklist.
- **SSH mixtapes view:** the web/API/CLI/MCP front doors exist; the rave terminal view is still a future surface.
- **Clip-of-a-mixtape pipeline:** how teaser clips get cut, captioned, and pushed.
- ~~**OG image:** a per-mixtape `/log` page OG card.~~ Shipped: `/api/mixtape-cover/<logId>?size=og` renders it on the fly (see Titles + covers).
- **External publishing chain:** Mixcloud upload, YouTube mirror, optional SoundCloud mirror, MusicBrainz DJ-mix release, Wikidata loop, and announce posts remain out of this plumbing build.

## Cross-links

- **Canon:** PRODUCT.md (Mixtapes — Fluncle dreaming), DESIGN.md (Checkpoint Row), the Voice canon (the `mixtape` vocabulary entry + the `F` Log ID marker).
- **Roadmap:** this doc absorbs the former "A Fluncle DJ mix" item. The SoundCloud profile item and the off-site MusicBrainz/Wikidata thread stay on `ROADMAP.md` and cross-link here.
