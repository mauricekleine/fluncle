import { type MixtapeMember } from "@fluncle/contracts";
import { type MixcloudSection, mixcloudSections } from "@fluncle/contracts/util";

export type MixtapeChapters = {
  cuedCount: number;
  mixcloudSections: MixcloudSection[];

  totalCount: number;

  youtubeChapters: string | null;
};

const MIN_CHAPTERS = 3;
const MIN_CHAPTER_GAP_S = 10;

const artistOf = (member: MixtapeMember): string => member.artists.join(", ");

export function formatTimestamp(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;
  const ss = String(seconds).padStart(2, "0");

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${ss}`;
  }

  return `${minutes}:${ss}`;
}

export function mixtapeChapters(members: MixtapeMember[]): MixtapeChapters {
  const cued = members
    .filter((member): member is MixtapeMember & { startMs: number } => member.startMs != null)
    .sort((a, b) => a.startMs - b.startMs);

  const sections = mixcloudSections(members);

  const lines: string[] = [];
  let prevSeconds = -MIN_CHAPTER_GAP_S;

  cued.forEach((member, index) => {
    const seconds = index === 0 ? 0 : Math.floor(member.startMs / 1000);

    if (seconds - prevSeconds < MIN_CHAPTER_GAP_S) {
      return;
    }

    prevSeconds = seconds;
    lines.push(`${formatTimestamp(seconds)} ${artistOf(member)} - ${member.title}`);
  });

  return {
    cuedCount: cued.length,
    mixcloudSections: sections,
    totalCount: members.length,
    youtubeChapters: lines.length >= MIN_CHAPTERS ? lines.join("\n") : null,
  };
}

export function mixtapeDescription(note: string, logId: string): string {
  return `${note.trim()}\n\nfluncle://${logId}`;
}

export function youtubeDescription(note: string, logId: string, members: MixtapeMember[]): string {
  const base = mixtapeDescription(note, logId);
  const { youtubeChapters } = mixtapeChapters(members);

  return youtubeChapters ? `${base}\n\n${youtubeChapters}` : base;
}
