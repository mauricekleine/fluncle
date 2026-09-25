export const siteUrl = "https://www.fluncle.com";

export function logPageUrl(logId: string): string {
  return `${siteUrl}/log/${encodeURIComponent(logId)}`;
}

export const spotifyPlaylistUrl =
  import.meta.env.VITE_FLUNCLE_SPOTIFY_PLAYLIST_URL ??
  "https://open.spotify.com/playlist/1m5LADqpLjiBERdtqrIiL0?si=054d3c6cbcf14a36";

export const spotifyPlaylistCanonicalUrl = spotifyPlaylistUrl.split("?")[0] ?? spotifyPlaylistUrl;

export const telegramUrl = import.meta.env.VITE_FLUNCLE_TELEGRAM_URL ?? "https://t.me/fluncle";

export const tiktokUrl = "https://www.tiktok.com/@fluncle";

export const instagramUrl = "https://www.instagram.com/fluncle/";

export const blueskyUrl = "https://bsky.app/profile/fluncle.com";

export const mixcloudUrl = "https://www.mixcloud.com/fluncle/";

export const soundcloudUrl = "https://soundcloud.com/fluncle";

export const youtubeUrl = "https://www.youtube.com/@fluncle";

export const twitchUrl = "https://www.twitch.tv/flunclelive";

export const xUrl = "https://x.com/mauricekleine";

export const repoUrl = "https://github.com/mauricekleine/fluncle";

export const galaxyUrl = "https://galaxy.fluncle.com";

export const radioUrl = "https://radio.fluncle.com";

export const chromeExtensionUrl =
  "https://chromewebstore.google.com/detail/efkkceaofendabikblfjhoepgejfpakk";

export const appStoreUrl = "https://apps.apple.com/app/id6790080540";

export const onionUrl = "http://p53pc2uzfu2tnih4cd6wd42ok6zup2uttj6xdmjdccy5kqo33fyppkqd.onion";

export const musicbrainzUrl = "https://musicbrainz.org/artist/53346748-1357-45c0-a847-9d248b65d655";

export const wikidataUrl = "https://www.wikidata.org/wiki/Q140169844";

export const lastfmUrl = "https://www.last.fm/user/fluncle";

export const discogsUrl = "https://www.discogs.com/user/fluncle";

export const fluncleEntityId = `${siteUrl}/#fluncle`;

export const fluncleWebsiteId = `${siteUrl}/#website`;

export const fluncleSameAs: string[] = [
  spotifyPlaylistCanonicalUrl,
  telegramUrl,
  tiktokUrl,
  instagramUrl,
  blueskyUrl,
  youtubeUrl,
  mixcloudUrl,
  soundcloudUrl,
  twitchUrl,
  onionUrl,
  musicbrainzUrl,
  wikidataUrl,
  lastfmUrl,
  discogsUrl,
];
