import { CardShell, GatedBody } from "./_chrome";
import { type CardEntry } from "./_types";

// The Landing's custom cards — gated surfaces the registry doesn't carry yet.
// Both are honest: no CTA, no launch date promise. The logbook, the monolith,
// and the notice board are owned surfaces that read from @fluncle/registry via
// SurfaceCard — they need no card file here.

function MobileCard() {
  return (
    <CardShell label="The mobile app">
      <GatedBody
        blurb="a vertical-video feed in your pocket. built, not in the stores yet."
        title="The mobile app"
      />
    </CardShell>
  );
}

function LensCard() {
  return (
    <CardShell label="Fluncle Lens">
      <GatedBody
        blurb="a browser lens that surfaces findings hidden across the web. in review."
        title="Fluncle Lens"
      />
    </CardShell>
  );
}

export const cards: CardEntry[] = [
  { Card: MobileCard, id: "mobile" },
  { Card: LensCard, id: "lens" },
];
