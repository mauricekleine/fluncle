import {
  Action,
  ActionPanel,
  Icon,
  Image,
  List,
  showToast,
  Toast,
} from "@raycast/api";
import { useEffect, useState } from "react";
import { getRecentTracks, type RecentTrack } from "./fluncle";

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  month: "short",
});

export default function Command() {
  const [isLoading, setIsLoading] = useState(true);
  const [tracks, setTracks] = useState<RecentTrack[]>([]);

  useEffect(() => {
    void getRecentTracks()
      .then(setTracks)
      .catch((error) => {
        void showToast({
          message: error instanceof Error ? error.message : String(error),
          style: Toast.Style.Failure,
          title: "Failed to load recent bangers",
        });
      })
      .finally(() => setIsLoading(false));
  }, []);

  return (
    <List isLoading={isLoading} searchBarPlaceholder="Search recent bangers">
      <List.EmptyView
        icon={Icon.Music}
        title="No findings logged yet"
        description="Quiet sector tonight."
      />
      {tracks.map((track) => (
        <List.Item
          key={track.trackId}
          icon={getTrackIcon(track)}
          title={`${track.artists.join(", ")} — ${track.title}`}
          subtitle={track.note}
          accessories={[
            {
              text: formatDate(track.addedAt),
              tooltip: `Found ${formatDate(track.addedAt)}`,
            },
          ]}
          actions={<TrackActions track={track} />}
        />
      ))}
    </List>
  );
}

function getTrackIcon(track: RecentTrack): Image.ImageLike {
  if (!track.albumImageUrl) {
    return Icon.Music;
  }

  return {
    mask: Image.Mask.RoundedRectangle,
    source: track.albumImageUrl,
  };
}

function TrackActions({ track }: { track: RecentTrack }) {
  return (
    <ActionPanel>
      <Action.Open
        title="Open in Spotify"
        target={`spotify:track:${track.trackId}`}
        application="Spotify"
      />
      <Action.OpenInBrowser title="Open in Browser" url={track.spotifyUrl} />
      <Action.CopyToClipboard
        title="Copy Spotify URL"
        content={track.spotifyUrl}
      />
    </ActionPanel>
  );
}

function formatDate(value: string): string {
  return dateFormatter.format(new Date(value));
}
