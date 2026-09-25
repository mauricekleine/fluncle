export function beatportSearchUrl(artists: string[], title: string): string {
  const query = `${artists.join(" ")} ${title}`.trim();
  return `https://www.beatport.com/search?q=${encodeURIComponent(query)}`;
}
