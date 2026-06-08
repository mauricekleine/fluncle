import { Clipboard, closeMainWindow, showToast, Toast } from "@raycast/api";
import { addTrack, parseSpotifyTrackInput } from "./fluncle";

export default async function Command() {
  const clipboardText = await Clipboard.readText();
  const spotifyUrl = parseSpotifyTrackInput(clipboardText ?? "");

  if (!spotifyUrl) {
    await showToast({
      style: Toast.Style.Failure,
      title: "Clipboard does not contain a Spotify track URL",
    });
    return;
  }

  const toast = await showToast({
    style: Toast.Style.Animated,
    title: "Publishing track",
  });

  try {
    const result = await addTrack(spotifyUrl);
    toast.style = Toast.Style.Success;
    toast.title = "Logged to Fluncle's Findings";
    toast.message = `${result.track.artists.join(", ")} — ${result.track.title}`;
    await closeMainWindow();
  } catch (error) {
    toast.style = Toast.Style.Failure;
    toast.title = "Failed to publish track";
    toast.message = error instanceof Error ? error.message : String(error);
  }
}
