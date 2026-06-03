import {
  Action,
  ActionPanel,
  Detail,
  Icon,
  List,
  showToast,
  Toast,
} from "@raycast/api";
import { useEffect, useState } from "react";
import { getRecentTransmissions, type RecentTransmission } from "./fluncle";

export default function Command() {
  const [isLoading, setIsLoading] = useState(true);
  const [tracks, setTracks] = useState<RecentTransmission[]>([]);

  useEffect(() => {
    getRecentTransmissions()
      .then(setTracks)
      .catch((error) => {
        showToast({
          style: Toast.Style.Failure,
          title: "Failed to load recent transmissions",
          message: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => setIsLoading(false));
  }, []);

  return (
    <List
      isLoading={isLoading}
      searchBarPlaceholder="Search recent transmissions"
    >
      {tracks.map((track) => (
        <List.Item
          key={track.trackId}
          title={`${track.artists.join(", ")} — ${track.title}`}
          subtitle={track.note}
          accessories={[{ text: formatDate(track.addedAt) }]}
          actions={<TrackActions track={track} />}
        />
      ))}
    </List>
  );
}

function TrackActions({ track }: { track: RecentTransmission }) {
  return (
    <ActionPanel>
      <Action.Push
        icon={Icon.Eye}
        title="Show Details"
        target={<TrackDetail track={track} />}
      />
      <Action.OpenInBrowser title="Open in Spotify" url={track.spotifyUrl} />
      <Action.CopyToClipboard
        title="Copy Spotify URL"
        content={track.spotifyUrl}
      />
    </ActionPanel>
  );
}

function TrackDetail({ track }: { track: RecentTransmission }) {
  const markdown = [
    `# ${track.artists.join(", ")} — ${track.title}`,
    track.album ? `Album: ${track.album}` : undefined,
    `Added: ${formatDateTime(track.addedAt)}`,
    track.note ? `Note: ${track.note}` : undefined,
    "",
    `[Open in Spotify](${track.spotifyUrl})`,
  ]
    .filter(Boolean)
    .join("\n\n");

  return (
    <Detail markdown={markdown} actions={<TrackActions track={track} />} />
  );
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  }).format(new Date(value));
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}
