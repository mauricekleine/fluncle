import { createInterface } from "node:readline/promises";
import { publicApiGet, publicApiPost } from "../api";
import { CliError } from "../output";

type SearchResponse = {
  ok: true;
  results: SearchCandidate[];
};

type SubmitResponse = {
  ok: true;
};

export type SearchCandidate = {
  id: string;
  spotifyUrl: string;
  title: string;
  artists: string[];
  album?: string;
  artworkUrl?: string;
};

export async function submitCommand(input: string | undefined): Promise<void> {
  const query = input?.trim() || (await promptLine("Search or Spotify URL: "));

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

  const note = await promptLine("Note (optional): ");
  const contact = await promptLine("Contact (optional): ");

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

  console.log("Received. Fluncle will give it a listen.");
}

async function promptLine(label: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new CliError(
      "not_interactive",
      "fluncle submit requires an interactive terminal for prompts.",
    );
  }

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    return (await rl.question(label)).trim();
  } finally {
    rl.close();
  }
}

async function selectCandidate(
  candidates: SearchCandidate[],
): Promise<SearchCandidate | undefined> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new CliError(
      "not_interactive",
      "fluncle submit requires an interactive terminal to confirm a track.",
    );
  }

  let selectedIndex = 0;
  let renderedLines = 0;
  let done = false;

  const stdin = process.stdin;
  const stdout = process.stdout;
  const wasRaw = stdin.isRaw === true;

  return await new Promise<SearchCandidate | undefined>((resolve) => {
    function cleanup(): void {
      if (done) {
        return;
      }

      done = true;
      stdin.off("data", onData);
      stdin.setRawMode(wasRaw);
      stdin.pause();
      stdout.write("\x1b[?25h");
    }

    function finish(candidate?: SearchCandidate): void {
      cleanup();
      stdout.write(renderedLines > 0 ? "\n" : "");
      resolve(candidate);
    }

    function cancel(): void {
      cleanup();
      clearRendered(stdout, renderedLines);
      stdout.write("Cancelled.\n");
      resolve(undefined);
    }

    function render(): void {
      clearRendered(stdout, renderedLines);
      const lines = buildSelectorLines(candidates, selectedIndex, stdout.columns ?? 80);
      renderedLines = lines.length;
      stdout.write(`${lines.join("\n")}\n`);
    }

    function onData(chunk: Buffer): void {
      const value = chunk.toString("utf8");

      if (value === "\u0003" || value === "\u001b" || value === "q") {
        cancel();
        return;
      }

      if (value === "\r" || value === "\n") {
        finish(candidates[selectedIndex]);
        return;
      }

      if (value === "\u001b[A" || value === "k") {
        selectedIndex = selectedIndex === 0 ? candidates.length - 1 : selectedIndex - 1;
        render();
        return;
      }

      if (value === "\u001b[B" || value === "j") {
        selectedIndex = selectedIndex === candidates.length - 1 ? 0 : selectedIndex + 1;
        render();
      }
    }

    stdout.write("\x1b[?25l");
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
    render();
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
      const line = truncate(`${prefix}${label}`, Math.max(columns, 20));

      return index === selectedIndex ? `\x1b[7m${line}\x1b[0m` : line;
    }),
    "",
    "Press enter to submit",
    "Up/k Down/j  q/Esc: cancel",
  ];
}

function clearRendered(stdout: NodeJS.WriteStream, lineCount: number): void {
  if (lineCount === 0) {
    return;
  }

  stdout.write(`\x1b[${lineCount}F\x1b[J`);
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, Math.max(maxLength - 3, 0))}...`;
}
