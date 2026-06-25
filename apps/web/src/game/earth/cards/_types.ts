import { type FC } from "react";

// The card contract. A door opens a "surface" — a card overlay. Owned surfaces
// (in @fluncle/registry) render through the generic SurfaceCard; anything the
// registry doesn't cover (the terminal, the social channels) is a CUSTOM card
// registered by id under ../cards/*.tsx and auto-collected by ./registry.tsx.
//
// Canon vocabulary: a place in the Galaxy is a "surface", never a "room"
// (VOICE.md). The overlay the player opens IS that surface.

export type CardProps = {
  onClose: () => void;
};

export type CardEntry = {
  /** Matches a door's `card` id. */
  id: string;
  Card: FC<CardProps>;
};
