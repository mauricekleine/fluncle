// A Beatport search URL for a finding — the buy-then-mix run starts here. Shared by
// the Add-to-mixtape dialog and the draft tracklist rows so the link reads the same
// everywhere.
export function beatportSearchUrl(artists: string[], title: string): string {
  const query = `${artists.join(" ")} ${title}`.trim();
  return `https://www.beatport.com/search?q=${encodeURIComponent(query)}`;
}
