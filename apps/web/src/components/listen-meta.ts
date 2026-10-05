import {
  siApplemusic,
  siBeatport,
  siDeezer,
  siSpotify,
  siYoutube,
  type SimpleIcon,
} from "simple-icons";
import { type ListenKind } from "@/lib/track-page";

export const LISTEN_META: Record<ListenKind, { icon: SimpleIcon; label: string }> = {
  apple: { icon: siApplemusic, label: "Listen on Apple Music" },
  beatport: { icon: siBeatport, label: "Buy on Beatport" },
  deezer: { icon: siDeezer, label: "Listen on Deezer" },
  spotify: { icon: siSpotify, label: "Listen on Spotify" },
  youtube: { icon: siYoutube, label: "Watch on YouTube" },
};
