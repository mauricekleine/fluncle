export const siteUrl = "https://www.fluncle.com";

// A finding's permanent home: its own log page. The canonical builder, reused
// wherever a hyperlink-capable surface points at a finding (log JSON-LD, the
// public API DTO, Telegram posts).
export function logPageUrl(logId: string): string {
  return `${siteUrl}/log/${encodeURIComponent(logId)}`;
}

export const spotifyPlaylistUrl =
  import.meta.env.VITE_FLUNCLE_SPOTIFY_PLAYLIST_URL ??
  "https://open.spotify.com/playlist/1m5LADqpLjiBERdtqrIiL0?si=054d3c6cbcf14a36";

export const telegramUrl = import.meta.env.VITE_FLUNCLE_TELEGRAM_URL ?? "https://t.me/fluncle";

// The owned channels (docs/socials/): TikTok is the primary video channel.
export const tiktokUrl = "https://www.tiktok.com/@fluncle";

export const instagramUrl = "https://www.instagram.com/fluncle/";

// The licensed home for the DJ mix (docs/socials/).
export const mixcloudUrl = "https://www.mixcloud.com/fluncle/";

// SoundCloud profile (docs/socials/) — profile presence; not a content host yet.
export const soundcloudUrl = "https://soundcloud.com/fluncle";

export const youtubeUrl = "https://www.youtube.com/@fluncle";

// Twitch live channel (docs/socials/) — `flunclelive`; `fluncle` was taken there.
export const twitchUrl = "https://www.twitch.tv/flunclelive";

// Fluncle has no own X handle yet; the social row routes DMs to Maurice.
export const xUrl = "https://x.com/mauricekleine";

// The open-source repo: an operator breadcrumb for the curious, not a Fluncle
// identity — kept out of the entity sameAs, surfaced only in the "for the
// nerds" panel (docs/socials/).
export const repoUrl = "https://github.com/mauricekleine/fluncle";

// The Galaxy game (same Worker, galaxy. subdomain): fly to every banger.
export const galaxyUrl = "https://galaxy.fluncle.com";

// The Model Context Protocol endpoint (Streamable HTTP, no auth): the archive
// as agent tools. The server card is at /.well-known/mcp/server-card.json.
export const mcpUrl = `${siteUrl}/mcp`;

// Third-party corroboration anchors (created 2026-06-11): the independent,
// machine-readable identities the entity schema points at via sameAs.
export const musicbrainzUrl = "https://musicbrainz.org/artist/53346748-1357-45c0-a847-9d248b65d655";

export const wikidataUrl = "https://www.wikidata.org/wiki/Q140169844";

// Music-graph profiles (created 2026-06-20): the same corroboration role as
// MusicBrainz/Wikidata, kept in sameAs. Any write-side sync (Last.fm love,
// Discogs List) is scoped in docs/rfcs/lastfm-discogs-sync.md, not here.
export const lastfmUrl = "https://www.last.fm/user/fluncle";

export const discogsUrl = "https://www.discogs.com/user/fluncle";
