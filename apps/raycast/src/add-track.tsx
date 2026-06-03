import { Action, ActionPanel, Clipboard, Form, showToast, Toast } from "@raycast/api";
import { useEffect, useState } from "react";
import { addTrack, parseSpotifyTrackInput } from "./fluncle";

type FormValues = {
  spotifyUrl: string;
  note?: string;
};

export default function Command() {
  const [spotifyUrl, setSpotifyUrl] = useState<string>("");

  useEffect(() => {
    void Clipboard.readText().then((text) => {
      const spotifyUrl = parseSpotifyTrackInput(text ?? "");
      if (spotifyUrl) {
        setSpotifyUrl(spotifyUrl);
      }
    });
  }, []);

  async function handleSubmit(values: FormValues) {
    const spotifyUrl = parseSpotifyTrackInput(values.spotifyUrl);

    if (!spotifyUrl) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Invalid Spotify track URL",
      });
      return;
    }

    const toast = await showToast({
      style: Toast.Style.Animated,
      title: "Publishing track",
    });

    try {
      const result = await addTrack(spotifyUrl, values.note);
      toast.style = Toast.Style.Success;
      toast.title = "📻 Transmission sent";
      toast.message = `${result.track.artists.join(", ")} — ${result.track.title}`;
    } catch (error) {
      toast.style = Toast.Style.Failure;
      toast.title = "Failed to publish track";
      toast.message = error instanceof Error ? error.message : String(error);
    }
  }

  return (
    <Form
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Add Track" onSubmit={handleSubmit} />
        </ActionPanel>
      }
    >
      <Form.TextField
        id="spotifyUrl"
        title="Spotify URL"
        placeholder="https://open.spotify.com/track/..."
        value={spotifyUrl}
        onChange={setSpotifyUrl}
      />
      <Form.TextField id="note" title="Note" placeholder="Optional" />
    </Form>
  );
}
