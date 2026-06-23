import { FlameIcon } from "@phosphor-icons/react";

import { Badge } from "@/components/ui/badge";
import { findStreak } from "@/lib/find-streak";

// The find-streak chip on the board header: a quiet gamification of the daily-
// discovery habit, not a growth-hack banner. It reads the streak straight from the
// findings the board already loaded (no DB column, no extra fetch) and renders as a
// dark outline Badge whose flame + count heat to Eclipse Gold — The Ignition Rule
// (DESIGN.md): the streak is "live", so it catches a little of the One Sun, never a
// loud red web pill. When the streak is broken it renders nothing — no nagging
// empty state.

export function FindStreakChip({ findings }: { findings: ReadonlyArray<{ addedAt: string }> }) {
  const streak = findStreak(findings);

  if (!streak.live || streak.days === 0) {
    return null;
  }

  return (
    <Badge
      aria-label={`${streak.days}-day find streak`}
      className="border-primary/35 bg-primary/10 text-primary"
      variant="outline"
    >
      {/* Decorative — the accessible label above carries the meaning. */}
      <FlameIcon aria-hidden="true" weight="fill" />
      <span className="font-bold tabular-nums">{streak.days}</span>
    </Badge>
  );
}
