import { FlameIcon } from "@phosphor-icons/react";

import { Badge } from "@/components/ui/badge";
import { findStreak, type PublishedPost } from "@/lib/find-streak";

// The find-streak chip on the board header: a quiet gamification of the daily
// publishing ritual, not a growth-hack banner. The streak counts consecutive days
// the day's video shipped to BOTH platforms (a published YouTube post AND a published
// TikTok post), read from the full published-post set (no DB column). It renders as a
// dark outline Badge whose flame + count heat to Eclipse Gold — The Ignition Rule
// (DESIGN.md): the streak is "live", so it catches a little of the One Sun, never a
// loud red web pill. When the streak is broken it renders nothing — no nagging
// empty state.

export function FindStreakChip({ posts }: { posts: ReadonlyArray<PublishedPost> }) {
  const streak = findStreak(posts);

  if (!streak.live || streak.days === 0) {
    return null;
  }

  return (
    <Badge
      aria-label={`${streak.days}-day publish streak`}
      className="border-primary/35 bg-primary/10 text-primary"
      variant="outline"
    >
      {/* Decorative — the accessible label above carries the meaning. */}
      <FlameIcon aria-hidden="true" weight="fill" />
      <span className="font-bold tabular-nums">{streak.days}</span>
    </Badge>
  );
}
