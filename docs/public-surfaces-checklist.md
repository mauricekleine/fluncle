# Fluncle Public Surface Checklist

## Canonical object

- [x] Stable `fluncle://` ID for every track
- [x] Canonical web page for every track
- [x] Canonical API object for every track
- [x] Canonical metadata schema
- [x] MusicBrainz/Wikidata IDs where available
- [x] Discogs ID — read-only release-ID enrichment shipped (`apps/web/src/lib/server/discogs.ts`: MusicBrainz-first by ISRC then a tracklist-confirmed Discogs search, storing `in_release_id`/`in_master_id` only on ≥0.90 confidence)

## Web

- [x] Website
- [x] Sitemap
- [x] JSON-LD
- [x] llms.txt
- [x] GitHub repo
- [x] Track OpenGraph images
- [x] Track Twitter/X cards
- [x] robots.txt
- [ ] Public changelog
- [x] Public docs

## Subdomains

_Dropped (2026-06-20): per-coordinate web subdomains add nothing over `/log/<id>` and were the only thing requiring Cloudflare for SaaS — superseded by the `dig` surface below. Recorded here as the decision, not a TODO._

- [ ] `241-7-3a.fluncle.com`
- [ ] `random.fluncle.com`
- [ ] `latest.fluncle.com`
- [ ] `today.fluncle.com`
- [ ] Subgenre subdomains
- [ ] Wildcard DNS
- [ ] Wildcard TLS
- [ ] Unknown-coordinate fallback

## DNS / dig

- [x] TXT record for track IDs
- [x] TXT record for random track
- [x] TXT record for latest track
- [ ] TXT record for today’s track
- [x] `dig` documentation
- [x] DNS metadata response format
- [x] Optional custom authoritative DNS server

## API / dev

- [x] API
- [x] CLI
- [x] MCP
- [x] OpenAPI
- [x] API docs/playground
- [x] JSON Feed
- [x] Atom feed
- [x] npm package
- [x] Homebrew tap
- [ ] Docker image
- [ ] Postman collection
- [x] Raycast extension
- [ ] Browser extension

## SSH

- [x] SSH terminal
- [x] `ssh rave.fluncle.com latest`
- [x] `ssh rave.fluncle.com random`
- [x] `ssh rave.fluncle.com <id>`
- [ ] Inline artwork
- [ ] ANSI/Braille fallback
- [ ] Sixel/Kitty/iTerm image support
- [ ] Terminal visualizer
- [ ] Audio pipe mode
- [ ] Live mode

## Tor

- [ ] Onion mirror
- [ ] API over Tor
- [ ] RSS over Tor
- [ ] SSH over Tor
- [ ] MCP over Tor
- [ ] Deep-space mirror docs

## Feeds/subscriptions

- [x] RSS
- [x] Newsletter
- [x] Telegram
- [x] JSON Feed
- [x] Atom
- [x] Podcast RSS
- [x] Calendar feed
- [ ] WebSub
- [ ] PWA push notifications

## Social/video

- [x] YouTube
- [x] TikTok
- [x] Instagram
- [x] Mixcloud
- [x] SoundCloud
- [x] Twitch
- [x] YouTube Shorts pipeline
- [ ] Instagram Reels pipeline
- [ ] X
- [ ] Bluesky
- [ ] Threads
- [ ] Mastodon/Fediverse
- [ ] ActivityPub
- [ ] Reddit
- [ ] Subreddit

## Community

- [x] Telegram channel
- [ ] Discord server
- [ ] Discord bot
- [ ] Slack app/channel
- [ ] WhatsApp Channel
- [ ] Matrix room, optional

## Music/data graph

- [x] MusicBrainz
- [x] Wikidata
- [x] Last.fm — profile `fluncle` claimed + in `sameAs`; write-side sync (love-on-add) shipped (`apps/web/src/lib/server/lastfm.ts`, gated on the `LASTFM_*` Worker secrets); a one-time catalogue backfill is the open tail (see ROADMAP)
- [ ] ListenBrainz
- [x] Discogs — profile `fluncle` claimed + in `sameAs`; release-ID enrichment shipped (`apps/web/src/lib/server/discogs.ts`). The optional Discogs "List of findings" write is the one unbuilt tail (`apps/web/src/lib/fluncle-links.ts` notes it)
- [ ] 1001Tracklists
- [ ] Rate Your Music
- [ ] Bandcamp
- [ ] Audius
- [ ] Apple Music playlist
- [x] Spotify playlist/profile
- [ ] YouTube Music playlist

## Directories

- [ ] Product Hunt
- [ ] API directories
- [ ] MCP directories
- [ ] CLI/tool directories
- [ ] Raycast Store
- [ ] Homebrew formula
- [x] npm
- [ ] Docker/GHCR
- [ ] Podcast directories
- [ ] Newsletter directories
- [ ] DnB/music directories
- [ ] Internet Archive
- [ ] Hugging Face dataset/Space
