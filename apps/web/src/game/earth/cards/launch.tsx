import { earthPalette as c } from "../palette";
import { CardShell } from "./_chrome";
import { type CardEntry, type CardProps } from "./_types";

// The launch card — the rocket door opens this. "take the rocket up" doesn't
// navigate straight away: it triggers the launch cinematic (fire, shake,
// liftoff) via onLaunch, and the engine navigates to /galaxy when the rocket
// clears the frame. The Galaxy's own boot is "Earth falling away", so the
// liftoff hands off seamlessly. Canon voice: sentence case, no exclamation, no
// em dashes.

function LaunchCard({ onLaunch }: CardProps) {
  return (
    <CardShell label="the rocket">
      <div className="text-center">
        <p className="text-lg" style={{ color: c.creamBright }}>
          The Galaxy
        </p>
        <p className="mt-2 text-sm" style={{ color: c.creamMuted }}>
          the rocket takes you up. every banger out there is a star, waiting at its Log ID.
        </p>
        <button
          className="earth-cta mt-5 inline-block rounded-full px-5 py-2 text-sm font-medium"
          onClick={onLaunch}
          style={{ border: `1px solid ${c.gold}`, color: c.goldBright }}
          type="button"
        >
          take the rocket up
        </button>
        <style>{`.earth-cta{transition:background-color .15s,color .15s}.earth-cta:hover,.earth-cta:focus-visible{background:${c.gold};color:${c.inkOnGold};outline:none}`}</style>
      </div>
    </CardShell>
  );
}

export const cards: CardEntry[] = [{ Card: LaunchCard, id: "launch" }];
