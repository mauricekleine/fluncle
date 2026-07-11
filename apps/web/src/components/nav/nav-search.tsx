// The archive search for variant D — how the nav integrates search and how it
// scales when "the log" is thousands of findings, not hundreds. It reuses the same
// machinery as the /mix cold-start picker (a command palette over the public
// `/api/v1/tracks` API), so this is honest existing wiring, not a new endpoint.
// Selecting a finding routes to its /log coordinate. (The productization step for a
// full DnB-archive catalog is a server-side full-text op behind this same palette.)

import { useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode } from "react";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@fluncle/ui/components/command";

type SearchFinding = {
  artists: string[];
  logId?: string;
  title: string;
  trackId: string;
  type?: string;
};

async function fetchFindingPool(): Promise<SearchFinding[]> {
  try {
    const response = await fetch("/api/v1/tracks?limit=60");

    if (!response.ok) {
      return [];
    }

    const body = (await response.json()) as { tracks?: SearchFinding[] };

    return (body.tracks ?? []).filter((item) => item.type !== "mixtape" && Boolean(item.logId));
  } catch {
    return [];
  }
}

export function NavSearch({ onNavigate }: { onNavigate?: () => void }): ReactNode {
  const navigate = useNavigate();
  const { data: pool = [] } = useQuery({
    queryFn: fetchFindingPool,
    queryKey: ["nav-search-pool"],
    staleTime: 60_000,
  });

  return (
    <Command className="nav-search">
      <CommandInput placeholder="Search the findings…" />
      <CommandList>
        <CommandEmpty>No finding by that name.</CommandEmpty>
        <CommandGroup heading="Findings">
          {pool.map((finding) => (
            <CommandItem
              key={finding.trackId}
              onSelect={() => {
                const logId = finding.logId;

                if (logId) {
                  onNavigate?.();
                  void navigate({ params: { logId }, to: "/log/$logId" });
                }
              }}
              value={`${finding.artists.join(" ")} ${finding.title} ${finding.logId ?? ""}`}
            >
              <span className="min-w-0 flex-1 truncate">
                {finding.artists.join(", ")} — {finding.title}
              </span>
              <span className="track-log-id shrink-0">{finding.logId}</span>
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </Command>
  );
}
