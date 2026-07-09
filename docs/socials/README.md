# Social Accounts & Channels

The map of where Fluncle exists off-repo: handles, links, profile assets, and bios. Bios are copy surfaces and follow VOICE.md; the canonical platform bio (set 2026-06-11, mirrored as `fluncleBio` in `apps/web/src/lib/identity.ts`) is the tagline plus the address on its own line:

```
Drum & bass bangers from another dimension.

www.fluncle.com
```

Profile imagery follows three roles — avatar (the cosmonaut), cover/wordmark (the FLUNCLE'S FINDINGS cover art), and banner (generated). See [Profile assets](#profile-assets) below.

## Accounts

| Platform           | Handle                     | Link                                                                                       | Sign-in                        | Bio (current)                                                                                                                                                                                              |
| ------------------ | -------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Spotify (profile)  | `fluncle`                  | https://open.spotify.com/user/berry_fudge?si=5c4a9d39a3384088                              | Maurice's Spotify              | n/a                                                                                                                                                                                                        |
| Spotify (playlist) | Fluncle's Findings         | https://open.spotify.com/playlist/1m5LADqpLjiBERdtqrIiL0?si=054d3c6cbcf14a36               | Maurice's Spotify              | The product artifact; this is the link surfaces share                                                                                                                                                      |
| TikTok             | `@fluncle`                 | https://www.tiktok.com/@fluncle                                                            | Fluncle alias                  | "Drum & bass bangers from another dimension."                                                                                                                                                              |
| Mixcloud           | `fluncle`                  | https://www.mixcloud.com/fluncle/                                                          | Fluncle alias                  | "Drum & bass bangers from another dimension."                                                                                                                                                              |
| SoundCloud         | `fluncle`                  | https://soundcloud.com/fluncle                                                             | Fluncle alias                  | "Drum & bass bangers from another dimension." (+ www.fluncle.com link)                                                                                                                                     |
| YouTube            | `@fluncle`                 | https://www.youtube.com/@fluncle                                                           | Maurice's personal Google      | "Drum & bass bangers from another dimension." (links out to fluncle.com + galaxy.fluncle.com)                                                                                                              |
| Twitch             | `flunclelive`              | https://www.twitch.tv/flunclelive                                                          | Fluncle alias                  | Live home for the DJ-mix stream; canonical bio (to set). `fluncle` was taken, hence `flunclelive`                                                                                                          |
| Instagram          | `fluncle`                  | https://www.instagram.com/fluncle/                                                         | Fluncle alias                  | "Drum & bass bangers from another dimension."                                                                                                                                                              |
| Bluesky            | `@fluncle.bsky.social`     | https://bsky.app/profile/fluncle.bsky.social                                               | Fluncle alias                  | "Drum & bass bangers from another dimension." (+ www.fluncle.com link). Findings auto-post as link cards to the /log page (`apps/web/src/lib/server/bluesky.ts`) — gated on the `BLUESKY_*` Worker secrets |
| Telegram (channel) | `@fluncle`                 | https://t.me/fluncle                                                                       | Maurice's Telegram             | The feed every surface links to; one banger per post under the 🛸 header                                                                                                                                   |
| MusicBrainz        | artist entry               | https://musicbrainz.org/artist/53346748-1357-45c0-a847-9d248b65d655                        | Fluncle alias                  | The corroboration anchor (Person, "drum & bass selector, Fluncle's Findings"); no bio field                                                                                                                |
| Wikidata           | `Q140169844`               | https://www.wikidata.org/wiki/Q140169844                                                   | Fluncle alias                  | The knowledge-graph item; cites the MusicBrainz ID, site, SoundCloud (P3040), TikTok + Telegram                                                                                                            |
| Last.fm            | `fluncle`                  | https://www.last.fm/user/fluncle                                                           | Fluncle alias                  | Music-graph profile; About set to the tagline. Love-on-add sync shipped (`apps/web/src/lib/server/lastfm.ts`) — gated on the `LASTFM_*` Worker secrets                                                     |
| Discogs            | `fluncle`                  | https://www.discogs.com/user/fluncle                                                       | Fluncle alias                  | Music-graph profile (user `31223733`); profile set to the bio. Release-ID enrichment shipped (`apps/web/src/lib/server/discogs.ts`); the optional findings List write is the unbuilt tail                  |
| Telegram (bot)     | `@fluncle_bot`             | https://web.telegram.org/k/#@fluncle_bot                                                   | Maurice's Telegram (BotFather) | "Drum & bass bangers from another dimension."                                                                                                                                                              |
| X                  | none (deliberate, for now) | personal cross-post via https://x.com/mauricekleine ("DM me on X" on the site)             | —                              | Fluncle has no own X handle yet; the site routes DMs to Maurice                                                                                                                                            |
| GitHub (repo)      | `mauricekleine/fluncle`    | https://github.com/mauricekleine/fluncle (`fluncle.git` in the home "for the nerds" panel) | Maurice's GitHub               | Operator breadcrumb, not a Fluncle identity — open-source repo, deliberately kept out of `sameAs`                                                                                                          |

The **Sign-in** column says which identity manages each profile — not the literal login. This repo is public, so the actual login emails/usernames live in 1Password alongside the keys, not here. Most Fluncle profiles sit under a `@fluncle.com` alias that forwards to Maurice's inbox; the older ones (Spotify, Telegram, YouTube) predate it and keep their own logins. Mixcloud is the licensed home for the DJ mix on the [roadmap](../planning/ROADMAP.md) — mind the Featured-Artist limits before uploading. A bare duplicate `soundcloud.com/fluncle-646915409` also exists — ignore or remove it; `/fluncle` is the canonical one.

## Owned channels (not accounts, same map)

| Channel    | Address                         | Notes                                        |
| ---------- | ------------------------------- | -------------------------------------------- |
| Web        | https://www.fluncle.com         | The archive                                  |
| SSH        | `ssh rave.fluncle.com`          | The rave terminal                            |
| Newsletter | the mothership, via Resend      | "Fresh bangers, every Friday, from Fluncle." |
| RSS        | https://www.fluncle.com/rss.xml |                                              |

## Unclaimed / future

Worth holding even if dormant; squatters move fast on short names. Nothing outstanding — SoundCloud and Twitch are both claimed (Twitch as `flunclelive`, since `fluncle` was taken there). The licensed DJ-mix audio home is still Mixcloud.

## Profile assets

Fluncle's public imagery resolves into three roles:

- **Avatar** (circular profile pics) — the lone **floating cosmonaut** (`apps/web/public/fluncle.png`, 1180×1180: the figure on a starfield). The founding image; reads at circle-size. Used on the Telegram bot, Mixcloud, YouTube, Instagram, …
- **Wordmark / cover** — the **FLUNCLE'S FINDINGS cover art** (`apps/web/public/fluncle-cover.png`, 1254×1254). The founding document (DESIGN.md); it is the **Spotify playlist cover** and the **Telegram channel** image. There is no separate wordmark-only treatment — the cover _is_ it.
- **Banner** — the cosmonaut against a full space backdrop, generated (below).

The transparent cutout `apps/web/public/fluncle-transparant.png` (mirrored to `packages/media/public/fluncle-cosmonaut.png`) is what the banners composite over the cosmos.

## Banners & covers

Generated from code by [`@fluncle/media`](../../packages/media/README.md) and written to [`banners/`](./banners): the floating cosmonaut against a warm Deep Field cosmos, **wordless** (the platform shows the channel name as text; the wordmark lives on the cover art). Regenerate with `bun run --cwd packages/media render:socials`.

| Platform   | Asset          | File                     | Dimensions | Format | Notes                                                                                                |
| ---------- | -------------- | ------------------------ | ---------- | ------ | ---------------------------------------------------------------------------------------------------- |
| YouTube    | channel banner | `banners/youtube.png`    | 2048×1152  | PNG    | the figure is centred in the **1235×338** safe area so the hard mobile crop still catches it; ≤ 6 MB |
| Mixcloud   | profile cover  | `banners/mixcloud.png`   | 2048×512   | PNG    | wide ~4.75:1 — confirm the exact crop in the uploader                                                |
| SoundCloud | profile header | `banners/soundcloud.png` | 2480×520   | PNG    | 4.7:1, ≤ 2 MB cap; figure centred to survive SoundCloud's hard mobile crop (safe central ~1000×260)  |
| Twitch     | profile banner | `banners/twitch.png`     | 1200×480   | PNG    | 2.5:1, ≤ 10 MB; figure centred (the avatar overlaps bottom-left on the channel page)                 |

The **Spotify playlist cover** and the **Telegram channel** image are the cover art (`fluncle-cover.png`), not generated here. The X (1500×500) banner spec is wired in (`render: false`) for when that handle is claimed.

**Future:** the cosmonaut/avatar images want a single home in `@fluncle/media` (so the web app imports them and the banners composite them) — the cutout already lives there; relocating `fluncle.png` itself is a flagged, not-yet-done move.

## Conventions

- Imagery follows the three roles above (avatar = cosmonaut, cover/wordmark = the FLUNCLE'S FINDINGS cover, banner = generated); keep an asset's uses in sync when it changes.
- Usernames/handles are always lowercase `fluncle` (or `@fluncle` where the platform prefixes); the name `Fluncle` stays capitalized in prose (VOICE.md §6).
- Bios are Fluncle speaking: sentence case, no exclamation marks, banned words apply (no "curated"). When in doubt, the canonical bio above; where a platform is too tight for both lines, the tagline alone.
- Emoji policy holds per platform register: Telegram may use the sanctioned set (🛸 🎧); other platform bios stay typographically clean unless the platform's culture demands otherwise, which is a VOICE.md amendment conversation, not an ad-hoc choice.
- Record every new account here in the same commit that creates its first content.
