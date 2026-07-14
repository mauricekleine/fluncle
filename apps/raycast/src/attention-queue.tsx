import { Color, Icon, MenuBarExtra, open } from "@raycast/api";
import { useEffect, useState } from "react";
import { type AttentionQueue, getAttentionQueue } from "./fluncle";

// The operator's `/admin` attention queue, in the menu bar. The title shows the
// waiting count (quiet — just an icon — when zero); the dropdown leads with the day's
// dispatch, then the waiting rows grouped by source, each opening its exact
// fluncle.com/admin deep link. It polls the CLI in the background (the `interval` in
// package.json) and on the manual Refresh action. Every count comes from the same
// `admin queue` read the CLI prints — Raycast never talks to the API itself.

const SITE = "https://www.fluncle.com";

type Source = AttentionQueue["rows"][number]["source"];

// A section header + a row glyph per source, in the same priority order the digest
// emits its counts. Interface glyphs only (the Raycast set) — no brand marks.
const SOURCE_META: Record<Source, { icon: Icon; title: string }> = {
  "artist-review": { icon: Icon.Person, title: "Artist links" },
  "attach-cues": { icon: Icon.BulletPoints, title: "Attach cues" },
  "capture-suspect": { icon: Icon.Waveform, title: "Capture checks" },
  distribute: { icon: Icon.Globe, title: "Distribute" },
  "drip-empty": { icon: Icon.Image, title: "Clip drip" },
  "label-review": { icon: Icon.Tag, title: "Labels" },
  newsletter: { icon: Icon.Envelope, title: "Newsletter" },
  "note-rejected": { icon: Icon.QuoteBlock, title: "Held notes" },
  "observation-rejected": { icon: Icon.Microphone, title: "Held observations" },
  "post-tiktok": { icon: Icon.Upload, title: "Push to TikTok" },
  "post-youtube": { icon: Icon.Upload, title: "Post to YouTube" },
  submission: { icon: Icon.Tray, title: "Submissions" },
  "tiktok-draft": { icon: Icon.Clock, title: "TikTok drafts" },
};

export default function Command() {
  const [isLoading, setIsLoading] = useState(true);
  const [queue, setQueue] = useState<AttentionQueue | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [reloads, setReloads] = useState(0);

  useEffect(() => {
    setIsLoading(true);
    void getAttentionQueue()
      .then((next) => {
        setQueue(next);
        setError(undefined);
      })
      .catch((caught) => {
        setError(caught instanceof Error ? caught.message : String(caught));
      })
      .finally(() => setIsLoading(false));
  }, [reloads]);

  const total = queue?.total ?? 0;
  const refresh = () => setReloads((count) => count + 1);

  return (
    <MenuBarExtra
      icon={menuBarIcon(total, error !== undefined)}
      isLoading={isLoading}
      title={total > 0 ? String(total) : undefined}
      tooltip="Fluncle attention queue"
    >
      {error !== undefined ? (
        <MenuBarExtra.Item icon={Icon.Warning} title={error} />
      ) : queue !== undefined ? (
        <>
          <MenuBarExtra.Section>
            <MenuBarExtra.Item
              icon={Icon.Stars}
              onAction={() => open(`${SITE}/admin`)}
              title={compactBrief(queue.brief)}
              tooltip={queue.brief}
            />
          </MenuBarExtra.Section>
          {queue.counts.map(({ source }) => (
            <MenuBarExtra.Section
              key={source}
              title={SOURCE_META[source].title}
            >
              {queue.rows
                .filter((row) => row.source === source)
                .map((row, index) => (
                  <MenuBarExtra.Item
                    icon={SOURCE_META[source].icon}
                    key={`${source}-${index}`}
                    onAction={() => open(`${SITE}${row.path}`)}
                    title={row.title}
                  />
                ))}
            </MenuBarExtra.Section>
          ))}
        </>
      ) : null}
      <MenuBarExtra.Section>
        <MenuBarExtra.Item
          icon={Icon.ArrowClockwise}
          onAction={refresh}
          shortcut={{ key: "r", modifiers: ["cmd"] }}
          title="Refresh"
        />
        <MenuBarExtra.Item
          icon={Icon.Window}
          onAction={() => open(`${SITE}/admin`)}
          title="Open the cockpit"
        />
      </MenuBarExtra.Section>
    </MenuBarExtra>
  );
}

// Quiet when zero (a muted tray icon, no number); a tinted tray once something waits;
// a warning glyph when the read failed.
// The dropdown-header dispatch, compacted: the full brief is a whole sentence of
// phrases and reads hella long as a menu item, so show the first phrase plus a
// count and keep the full dispatch in the item tooltip. "All clear. Quiet sector."
// has no comma-joined phrases and passes through untouched.
function compactBrief(brief: string): string {
  const phrases = brief.replace(/\.$/, "").split(", ");

  if (phrases.length <= 2) {
    return brief;
  }

  return `${phrases[0]}, +${phrases.length - 1} more.`;
}

function menuBarIcon(
  total: number,
  failed: boolean,
): { source: Icon; tintColor?: Color } {
  if (failed) {
    return { source: Icon.Warning, tintColor: Color.Red };
  }

  return total > 0
    ? { source: Icon.Tray, tintColor: Color.Orange }
    : { source: Icon.Tray };
}
