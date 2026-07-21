export type SearchResult = {
  id: string;
  spotifyUrl: string;
  title: string;
  artists: string[];
  album?: string;
  artworkUrl?: string;
};

export async function searchTracks(query: string): Promise<SearchResult[]> {
  const params = new URLSearchParams({ q: query });
  const response = await fetch(`/api/v1/search?${params.toString()}`);
  const data = (await response.json()) as {
    ok?: boolean;
    results?: SearchResult[];
    message?: string;
  };

  if (!response.ok || !data.ok) {
    throw new Error(data.message ?? `Search failed: ${response.status}`);
  }

  return data.results ?? [];
}

export async function submitTrack({
  candidate,
  contact,
  honeypot,
  note,
}: {
  candidate: SearchResult;
  contact?: string;
  honeypot?: string;
  note?: string;
}): Promise<void> {
  const response = await fetch("/api/v1/submissions", {
    body: JSON.stringify({
      album: candidate.album,
      artists: candidate.artists,
      artworkUrl: candidate.artworkUrl,
      contact,
      honeypot,
      note,
      source: "web",
      spotifyTrackId: candidate.id,
      spotifyUrl: candidate.spotifyUrl,
      title: candidate.title,
    }),
    headers: {
      "Content-Type": "application/json",
    },
    method: "POST",
  });
  const data = (await response.json()) as {
    ok?: boolean;
    message?: string;
  };

  if (!response.ok || !data.ok) {
    throw new Error(data.message ?? `Submission failed: ${response.status}`);
  }
}
