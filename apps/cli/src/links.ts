// Fluncle's canonical external URLs that recur across CLI surfaces (`about`,
// `open`, and the help text). Keeping the handle/URL in one place here
// so the surfaces can't drift.

export const spotifyPlaylistUrl = "https://open.spotify.com/playlist/1m5LADqpLjiBERdtqrIiL0";
export const telegramUrl = "https://t.me/fluncle";

// The canonical web home. `search` builds entity page links off it (an
// `/artist/<slug>` jump is a WEB destination, not the `--api-base` a test may
// point elsewhere), so it stays fixed rather than derived from the API base.
export const webBaseUrl = "https://www.fluncle.com";
