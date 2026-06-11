# Social Accounts & Channels

The map of where Fluncle exists off-repo: handles, links, profile assets, and bios. Bios are copy surfaces and follow VOICE.md; the canonical platform bio (set 2026-06-11, mirrored as `fluncleBio` in `apps/web/src/lib/identity.ts`) is the tagline plus the address on its own line:

```
Drum & bass bangers from another dimension.

www.fluncle.com
```

The shared profile image is `apps/web/public/fluncle.png` (1180×1180) everywhere.

## Accounts

| Platform           | Handle                     | Link                                                                           | Bio (current)                                                                               |
| ------------------ | -------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| Spotify (profile)  | `fluncle`                  | https://open.spotify.com/user/berry_fudge?si=5c4a9d39a3384088                  | n/a                                                                                         |
| Spotify (playlist) | Fluncle's Findings         | https://open.spotify.com/playlist/1m5LADqpLjiBERdtqrIiL0?si=054d3c6cbcf14a36   | The product artifact; this is the link surfaces share                                       |
| TikTok             | `@fluncle`                 | https://www.tiktok.com/@fluncle                                                | "Drum & bass bangers from another dimension."                                               |
| Telegram (channel) | `@fluncle`                 | https://t.me/fluncle                                                           | The feed every surface links to; one banger per post under the 🛸 header                    |
| MusicBrainz        | artist entry               | https://musicbrainz.org/artist/53346748-1357-45c0-a847-9d248b65d655            | The corroboration anchor (Person, "drum & bass selector, Fluncle's Findings"); no bio field |
| Wikidata           | `Q140169844`               | https://www.wikidata.org/wiki/Q140169844                                       | The knowledge-graph item; cites the MusicBrainz ID, site, TikTok + Telegram                 |
| Telegram (bot)     | `@fluncle_bot`             | https://web.telegram.org/k/#@fluncle_bot                                       | "Drum & bass bangers from another dimension."                                               |
| X                  | none (deliberate, for now) | personal cross-post via https://x.com/mauricekleine ("DM me on X" on the site) | Fluncle has no own X handle yet; the site routes DMs to Maurice                             |

## Owned channels (not accounts, same map)

| Channel    | Address                         | Notes                                        |
| ---------- | ------------------------------- | -------------------------------------------- |
| Web        | https://www.fluncle.com         | The archive                                  |
| SSH        | `ssh rave.fluncle.com`          | The rave terminal                            |
| Newsletter | the mothership, via Loops       | "Fresh bangers, every Friday, from Fluncle." |
| RSS        | https://www.fluncle.com/rss.xml |                                              |

## Unclaimed / future

The video pipeline (packages/video) will eventually want vertical-video homes beyond TikTok. Claim handles early even if they stay dormant; squatters move fast on short names:

- YouTube (`@fluncle`) for Shorts
- Instagram (`@fluncle`) for Reels
- SoundCloud (`fluncle`) if mixes ever happen

## Conventions

- One profile image everywhere (`apps/web/public/fluncle.png`); update it in one commit when it changes.
- Bios are Fluncle speaking: sentence case, no exclamation marks, banned words apply (no "curated"). When in doubt, the canonical bio above; where a platform is too tight for both lines, the tagline alone.
- Emoji policy holds per platform register: Telegram may use the sanctioned set (🛸 🎧); other platform bios stay typographically clean unless the platform's culture demands otherwise, which is a VOICE.md amendment conversation, not an ad-hoc choice.
- Record every new account here in the same commit that creates its first content.
