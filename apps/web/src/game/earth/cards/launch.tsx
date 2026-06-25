import { Link } from "@tanstack/react-router";
import { earthPalette as c } from "../palette";
import { CardShell } from "./_chrome";
import { type CardEntry } from "./_types";

// The launch card — the rocket door in the Launch region opens this. It
// navigates into the Galaxy game with a typed client-side <Link>. The Galaxy's
// own boot sequence is "Earth falling away", so this card IS the launch.
// Canon voice: sentence case, no exclamation marks, no em dashes.

function LaunchCard() {
  return (
    <CardShell label="the rocket">
      <div className="text-center">
        <p className="text-lg" style={{ color: c.creamBright }}>
          The Galaxy
        </p>
        <p className="mt-2 text-sm" style={{ color: c.creamMuted }}>
          the rocket takes you up. every banger out there is a star, waiting at its Log ID.
        </p>
        <Link
          className="earth-cta mt-5 inline-block rounded-full px-5 py-2 text-sm font-medium"
          style={{ border: `1px solid ${c.gold}`, color: c.goldBright }}
          to="/galaxy"
        >
          take the rocket up
        </Link>
        <style>{`.earth-cta{transition:background-color .15s,color .15s}.earth-cta:hover,.earth-cta:focus-visible{background:${c.gold};color:${c.inkOnGold};outline:none}`}</style>
      </div>
    </CardShell>
  );
}

export const cards: CardEntry[] = [{ Card: LaunchCard, id: "launch" }];
