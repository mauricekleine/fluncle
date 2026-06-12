import { publicApiGet, publicApiPost } from "../api";
import { promptLine, selectWithKeyboard, truncateTerminalLine } from "../interactive";
import { CliError } from "../output";

type SearchResponse = {
  ok: true;
  results: SearchCandidate[];
};

type SubmitResponse = {
  ok: true;
};

type SearchCandidate = {
  id: string;
  spotifyUrl: string;
  title: string;
  artists: string[];
  album?: string;
  artworkUrl?: string;
};

const PROMPT_NON_INTERACTIVE_MESSAGE =
  "fluncle submit requires an interactive terminal for prompts.";
const SELECT_NON_INTERACTIVE_MESSAGE =
  "fluncle submit requires an interactive terminal to confirm a track.";

export async function submitCommand(input: string | undefined): Promise<void> {
  const query =
    input?.trim() || (await promptLine("Search or Spotify URL: ", PROMPT_NON_INTERACTIVE_MESSAGE));

  if (!query) {
    throw new CliError("missing_query", "Missing search input");
  }

  const response = await publicApiGet<SearchResponse>(`/api/search?q=${encodeURIComponent(query)}`);

  if (response.results.length === 0) {
    throw new CliError("no_results", "No Spotify tracks found.");
  }

  const selected = await selectCandidate(response.results);

  if (!selected) {
    return;
  }

  const note = await promptLine("Note (optional): ", PROMPT_NON_INTERACTIVE_MESSAGE);
  const contact = await promptLine("Contact (optional): ", PROMPT_NON_INTERACTIVE_MESSAGE);

  await publicApiPost<SubmitResponse>("/api/submissions", {
    album: selected.album,
    artists: selected.artists,
    artworkUrl: selected.artworkUrl,
    contact,
    honeypot: "",
    note,
    source: "cli",
    spotifyTrackId: selected.id,
    spotifyUrl: selected.spotifyUrl,
    title: selected.title,
  });

  console.log("Logged. Fluncle will give it a listen.");
}

async function selectCandidate(
  candidates: SearchCandidate[],
): Promise<SearchCandidate | undefined> {
  return await selectWithKeyboard(candidates, {
    nonInteractiveMessage: SELECT_NON_INTERACTIVE_MESSAGE,
    renderLines: buildSelectorLines,
  });
}

function buildSelectorLines(
  candidates: SearchCandidate[],
  selectedIndex: number,
  columns: number,
): string[] {
  return [
    "Select a track to submit",
    ...candidates.map((candidate, index) => {
      const prefix = index === selectedIndex ? "> " : "  ";
      const label = `${candidate.artists.join(", ")} — ${candidate.title}`;
      const line = truncateTerminalLine(`${prefix}${label}`, Math.max(columns, 20));

      return index === selectedIndex ? `\x1b[7m${line}\x1b[0m` : line;
    }),
    "",
    "Press enter to submit",
    "Up/k Down/j  q/Esc: cancel",
  ];
}
