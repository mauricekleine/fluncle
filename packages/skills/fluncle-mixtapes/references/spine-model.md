# The mixtape spine model

The object model behind Fluncle's own mixtapes: what a mixtape _is_, how its identity works, where it lives, and the per-surface build map. The `SKILL.md` is the operator workflow; this is the background you read once to understand the object. Canon (DESIGN.md / PRODUCT.md / VOICE.md) arbitrates the words and the look; this carries the model. Scoped to DJ mixtapes — if originals, edits, or guest sets ever appear, generalize into "own publications" then, not before. ("Mixtape" is the canonical term; "mix" is the casual synonym.)

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

- **Sector (`XXX`)** = days since the epoch (2026-05-30) to the night the mixtape is recorded/published — identical rule to a finding.
- **Marker (`F`)** = the middle slot is always the literal letter `F` (Fluncle). A finding's middle slot is a digit; a mixtape's is `F`. That single letter is the whole tell — quiet, learnable, and on-format.
- **Number (`ZZ`)** = the mixtape's sequence number as `<digit><letter>`, digit `1–9`, letter `A–F` (hex-flavored). `1A` is mixtape #1, `1B` is #2, … `1F` is #6, then it rolls to `2A` for #7, up to `9F` for #54. Always two characters, always digit-then-letter (the finding mark shape), so nothing screams. A human-meaningful count, not a content hash.

So the first mixtape minted as **`019.F.1A`**.

What this scheme buys:

- The number keeps the exact finding mark shape (`<digit><letter>`), so a mixtape coordinate reads as on-format and quiet; only the middle `F` distinguishes it on sight.
- A `XXX.F.ZZ` coordinate **can never collide with a finding** (findings carry a digit in the middle slot), so **no finding-alphabet surgery is needed** — the `F` does all the work.
- Sequential mint is collision-free, and the number is meaningful ("Mixtape No. 6").

Notes:

- **Cap: 54** (9 digits × 6 letters). Past that, extend the alphabet or the digit range — a bridge to cross then.
- **Minting:** the separate `mixtapes` table _is_ the counter: the next number is `max(existing) + 1`, encoded into `<digit><letter>` (number N → digit `floor((N-1)/6)+1`, letter `A–F` at index `(N-1) mod 6`). No separate counter primitive needed. Same shape as a finding (sector = day, tail = the identifying signature), but the tail is a sequence here, not a content hash.
- A mixtape Log ID is **minted once, never reassigned**, same contract as a finding's.

## URL — one universal resolver

`fluncle://<id>` resolves through **`/log/<id>`** for both findings and mixtapes — one identity, many representations, no second URL namespace. The log page renders the **mixtape flavor**: the member tracklist (each track linked to its own `/log/<id>`), the embedded Mixcloud/YouTube player, and the dream note. The CLI/SSH/API resolvers stay universal too; they return a mixtape-typed object when the coordinate's middle slot is `F`.

## Two ways in: quiet inclusion + a front door

A mixtape slips **quietly into the existing track surfaces** (the feed, `recent`, the API) as one more row — the checkpoint row of DESIGN.md, not a banner. It **also gets a dedicated surface**:

- **Web** — a `/mixtapes` index (the mixtape archive, newest first).
- **API** — `/api/mixtapes` (mixtapes as JSON).
- **CLI** — `fluncle mixtapes`.
- **SSH** — a mixtapes view in the rave terminal (`screenMixtapes` / `screenMixtapeDetail` / `fetchMixtapes` in `apps/ssh/main.go`).

## Mixtape-aware for machines (SEO / AEO)

Crawlers, bots, and AI answer engines must read a mixtape **as a DJ mixtape**, not as a single track. This lives in the **structured layer**, not the Log ID string:

- **schema.org** — a `MusicAlbum` with `albumProductionType: DJMixAlbum`, tracklist as `track` entries linking each member finding — distinct from a finding's `MusicRecording`.
- **RSS** — mixtape items flagged in the observation feed (a `<category>`) so the feed is honestly two item types.
- **llms.txt** — a labeled **Mixtapes** section stating these are Fluncle's own DJ mixtapes consolidating findings, each with its own coordinate.

## Hosting — where the audio and video go

- **Mixcloud — primary home.** Properly licensed (direct deals with the majors + indies like Ninja Tune / XL via Merlin): it plays legally and pays the featured artists, within the Featured-Artist / SRPC limits. Two failure tiers to stay clear of: exceeding the consecutive rule (≤ 3 per artist consecutive, ≤ 2 per release consecutive) makes the show **regionally unavailable**; **4–8 tracks from one artist makes the whole show Premium / subscriber-only globally** (a hard paywall). The curator waiver doesn't apply. Trivial for a varied D&B set — observe, don't pre-lint; if a show ever gets gated it's visible on Mixcloud and fixable by hand (audio can't be swapped — delete + re-upload). Upload is **CLI-direct** (the Worker can't proxy a multi-GB master) but the **token is server-side** (`mixcloud_auth`); the CLI fetches it just-in-time. One length caveat: a **full-length mixtape is a licensed _show_**, but a **short single clip is classified as an unlicensed _track_ and copyright-blocked** — so test with real-length audio, not a short clip.
- **YouTube — reach mirror.** Content ID claims it: the video stays up but the labels monetize it. Good for reach, not revenue. The **mixtape video** lives here, uploaded via `youtube_auth` — published unlisted, flipped public by the operator.
- **SoundCloud — secondary mirror.** Patchier (takedown risk). Profile presence is a separate roadmap item; hosting actual audio there is the licensing-gated question.
- **Teaser clips.** Short clips cut from the set go to the social surfaces (TikTok / Shorts / IG) the same way a finding's clip does — the clip is a trailer, captioned with the mixtape's `fluncle://<id>` coordinate. The Fluncle Studio clip pipeline cuts them from the set master on R2 (`mixtape_clips`, `fluncle admin clips list|cut`, `/admin/studio/$logId` + `/admin/clips`, the `fluncle-studio-clip` cron; see `docs/fluncle-studio.md`).

## Titles + covers

- **Title — the same string everywhere** (`/log`, Mixcloud, YouTube, SoundCloud): `Fluncle Drum & Bass Mixtape #N | XXX.F.ZZ`. Searchable genre up front, the coordinate as the unique tail. It's an **output, not an input** — `publishMixtape` mints it from the number + coordinate; there's no title field on the draft. The `title` column stays so a future non-"Mixtape #N" series can carry its own name (publish leaves a non-stub title untouched). The **dream note** carries the cryptic/evocative weight.
- **The note → the description, with a `fluncle://` breadcrumb (external only).** The dream note doubles as the YouTube / Mixcloud description, with the mixtape's `fluncle://<logId>` coordinate appended as a derived suffix (the note, a blank line, then `fluncle://<logId>`). The marker is **never stored in the `note` column** and is **appended only when the description is built for the platforms at upload**. Internally, `/log` shows the clean stored note — the coordinate is already on the page as the mixtape's identity.
- **Covers render on the fly, fully derived** — no per-mixtape render step, no stored cover, no input. `GET /api/mixtape-cover/<logId>?size=square|og|wide` is an edge route (`workers-og`/Satori, same path as the finding OG card) that stamps `MIXTAPE #N` + the coordinate over a fixed Deep-Field background. A published mixtape's cover URL is derived from its Log ID (`mixtapeCoverUrl`); the `cover_image_url` column was dropped.
  - **Square 1500×1500** (`size=square`) → Mixcloud + SoundCloud artwork, and the mixtape's `coverImageUrl` on `/log`.
  - **16:9 1280×720** (`size=wide`) → the YouTube thumbnail.
  - **1200×630** (`size=og`) → the `/log` link-preview (OG) card.
  - The shared background (cosmonaut on the One-Sun Deep Field, grain) is baked once by `bun run --cwd packages/media render:mixtape-bg` (the `<MixtapeCover>` composition with `markers: false`) and **hosted on R2 at `found.fluncle.com/mixtape/bg-{square,wide,og}.jpg`** — the cover endpoint fetches it **cross-origin** (it must not live on `www`, or a Worker self-fetch loops to the SPA fallback and the cover renders black). The render script writes the jpgs to `packages/media/out/mixtape-bg/` and prints the `wrangler r2 object put` upload recipe. Re-run + re-upload only when the art changes; iterate with the `fluncle-video` kit. Remotion is no longer in the publish path.

## Editing after publish — the lifecycle

Publishing is the irreversible-ish step, but only the **coordinate** is truly frozen (enforced in `updateMixtape`):

- **Minting requires the substance, not the links** — a recorded date, a dream note, a duration, and ≥ 1 tracklist member. A draft is just the operator-authored subset; `publishMixtape` verifies it, then mints the Log ID + number + title into the `distributing` state. The external link is **not** a mint gate — distribution supplies it (the mint-first reshape). No empty, substance-less mixtape goes live.
- **The lifecycle:** `draft` → (mint) `distributing` (coordinate committed, cover renders, hidden from public) → (first platform link) `published`. A `distributing` mixtape is edit-locked like a published one and can't be deleted (it owns a committed coordinate); a totally failed distribution leaves it `distributing` with its Log ID held for retry, never a linkless public mixtape.
- **After publish you can still edit** the note and the external links — add YouTube after Mixcloud, add SoundCloud later. (Title and cover are derived from the coordinate, so there's nothing to edit there.)
- **You can never remove the last link** — a published mixtape must always keep somewhere to listen.
- **Frozen once minted:** the Log ID + sequence number, the title + cover derived from them, the `recordedAt` (its sector is baked into the coordinate), and the **tracklist** (the minted set is the record).

## Tracklist — the breadcrumb

The required tracklist **is the breadcrumb**, and the AEO/SEO play. Write each track as its finding: `Artist — Title`, its `fluncle://<log-id>` coordinate, and a `/log/<id>` link (Mixcloud tracklist; YouTube description + chapters). Owned surfaces and authentic scene presence pointing back at fluncle.com. A member track that isn't a finding yet is added as a finding first (or allowed as a non-finding member — an open question). The ordered identity comes out of Rekordbox history (see `scripts/rekordbox-tracklist.py`); its load timestamps are **not** usable as cue offsets (deck-load time precedes the audible mix-in by a variable lead), so the tracklist carries order + identity, not jump-to times.

## MusicBrainz + Wikidata

- **MusicBrainz DJ-mix release.** Add the mixtape as a DJ-mix release (Fluncle as the mix artist, tracklist = the real recordings). The on-brand way to make the MusicBrainz artist (`53346748-1357-45c0-a847-9d248b65d655`) substantial — no AI original needed.
- **Close the loop to Wikidata.** A real release is exactly the kind of fact that accumulates on `Q140169844`: link the MusicBrainz release / add the mixtape as the artist's work once it exists.

## The spine-native fan-out (build map)

Where a mixtape lands and what each surface renders (all built):

| Surface                | A finding does     | A mixtape does                                                                                           |
| ---------------------- | ------------------ | -------------------------------------------------------------------------------------------------------- |
| Web feed               | a finding row      | a quiet **checkpoint row** (own cover/title, member count + run time instead of the chip row; DESIGN.md) |
| Web index              | the archive        | a dedicated **`/mixtapes`** overview                                                                     |
| `/log/<id>`            | observation page   | **compilation page**: member tracklist (each linked), embedded Mixcloud/YouTube, the dream note          |
| CLI                    | `fluncle log <id>` | resolves to the mixtape; quiet in `recent`; listed by `fluncle mixtapes`                                 |
| API                    | `/api/tracks/<id>` | mixtape-typed payload (members, external URLs, duration); `/api/mixtapes` index                          |
| RSS                    | observation entry  | a flagged **mixtape** entry in the feed                                                                  |
| MCP                    | list/random/search | the mixtape reachable as the same typed object                                                           |
| SSH                    | the rave terminal  | a checkpoint + a mixtapes view (`screenMixtapes` / `screenMixtapeDetail`)                                |
| Machines               | `MusicRecording`   | `MusicAlbum` / `DJMixAlbum` schema, RSS category, llms.txt Mixtapes section                              |
| MusicBrainz / Wikidata | artist anchors     | the DJ-mix release → the Wikidata fact                                                                   |

## Galaxy tie-in (future, not now)

A mixtape sits at its sector, which the Galaxy game maps to a distance from Earth — so a mixtape is a natural **checkpoint / forward base / waystation** out there. That overlaps the parked "new home planets as forward bases / respawn + refuel hubs" idea in the Galaxy backlog: the metaphor and the game mechanic want the same object. Note it; don't build it here.

## Open questions / build tasks

The internal plumbing and the external distribution chain are **shipped**. Remaining follow-ups (also tracked in `docs/ROADMAP.md` → _Fluncle's own mixtapes_):

- **Member tracks that aren't findings yet:** add them as findings first, or allow non-finding members in a mixtape's tracklist.
- **Per-track cue offsets:** Rekordbox load times can't supply them (see Tracklist); if wanted, capture them against the final video.

## Cross-links

- **Canon:** PRODUCT.md (Mixtapes — Fluncle dreaming), DESIGN.md (Checkpoint Row), the Voice canon (the `mixtape` vocabulary entry + the `F` Log ID marker).
- **Roadmap:** the SoundCloud profile item and the off-site MusicBrainz/Wikidata thread stay on `docs/ROADMAP.md` and cross-link here.
