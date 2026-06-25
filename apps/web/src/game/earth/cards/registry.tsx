import { type FC } from "react";
import { type CardEntry, type CardProps } from "./_types";

// Auto-registration for CUSTOM cards (the terminal, the social channels, gated
// surfaces) — anything @fluncle/registry doesn't cover. Each region's card file
// (./workshop.tsx, ./comms.tsx, …) exports a `cards: CardEntry[]`; this collects
// them by id. Adding a region's cards is adding a file — no edit here — so card
// builds fan out without collisions. Vite-only (import.meta.glob); never
// imported by unit tests.

const modules = import.meta.glob<{ cards?: CardEntry[] }>("./*.tsx", { eager: true });

export const CARD_REGISTRY: Record<string, FC<CardProps>> = {};

for (const [path, mod] of Object.entries(modules)) {
  if (path.includes("/_") || path.includes("registry") || path.includes("surface-card")) {
    continue;
  }
  for (const entry of mod.cards ?? []) {
    CARD_REGISTRY[entry.id] = entry.Card;
  }
}
