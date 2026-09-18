// A Beatport search URL for a finding — the buy-then-mix run starts here. Shared by
// the Add-to-mixtape dialog, the draft tracklist rows, and the server-side resolver
// (lib/server/beatport-resolve.ts scrapes this exact URL), so the link reads the same
// everywhere and the resolver cannot search a different page than the one offered.
export function beatportSearchUrl(artists: string[], title: string): string {
  const query = `${artists.join(" ")} ${title}`.trim();
  return `https://www.beatport.com/search?q=${encodeURIComponent(query)}`;
}
