import { parseArtistsJson } from "./artists";
import { getDb, typedRows } from "./db";
import { listEditions } from "./editions";
import { editionFindingCount } from "../editions";
import { logPageUrl } from "../fluncle-links";

// The spine's syndication feed, as one list — read once here and formatted three ways
// (`/rss.xml`, `/atom.xml`, `/feed.json`), which previously each carried their own copy
// of the same union query.
//
// Three kinds of object share the spine and so share the feed: a finding (the banger
// Fluncle logged), a mixtape (him dreaming), and a letter (the edition he posted home).
// They ride the SAME chronological list, each tagged with its kind, so a reader gets the
// journey in order and nothing shouts.
//
// QUIET, deliberately: a letter is weekly and a finding is not, so a letter is a row
// among many and never a section. It also does not lead — the feed's title stays
// "Fluncle's Findings", and the letter is an item in it, tagged so a reader (or a
// crawler) knows what it is rather than mistaking it for a track.

export type FeedEntry = {
  /** The chronological key — a finding's found date, a mixtape's, a letter's send date. */
  addedAt: string;
  /** A stable, non-URL id: the coordinate for a mixtape/letter, the track id for a finding. */
  guid: string;
  kind: "edition" | "finding" | "mixtape";
  /** Where the item points: a finding at Spotify, a mixtape and a letter at their /log page. */
  link: string;
  /** The body: the title, then the note (a finding/mixtape) or the intro (a letter). */
  summary: string;
  title: string;
};

type SpineRow = {
  added_at: string;
  artists_json: string;
  item_type: "finding" | "mixtape";
  note: string | null;
  spotify_url: string | null;
  title: string;
  track_id: string;
};

/**
 * The newest `limit` items across the three kinds, newest first. The findings and
 * mixtapes come out of one union (they live in the same shape); the letters are read
 * through `listEditions` because their coordinate is DERIVED from the row rather than
 * stored (see lib/edition-log-id.ts), and only the DTO mapping knows how to derive it.
 * Over-read each side by `limit`, merge, then trim — so the merged head is exact.
 */
export async function listFeedEntries(limit: number): Promise<FeedEntry[]> {
  const db = await getDb();

  const [spineResult, editions] = await Promise.all([
    db.execute({
      args: [limit],
      sql: `select * from (
            select
              'finding' as item_type,
              tracks.track_id,
              tracks.spotify_url,
              tracks.title,
              tracks.artists_json,
              findings.note,
              findings.added_at
            from findings join tracks on tracks.track_id = findings.track_id
            union all
            select
              'mixtape' as item_type,
              log_id as track_id,
              null as spotify_url,
              title,
              '["Fluncle"]' as artists_json,
              note,
              added_at
            from mixtapes
            where status = 'published' and log_id is not null and added_at is not null
          )
            order by added_at desc, track_id desc
            limit ?`,
    }),
    listEditions({ limit }),
  ]);

  const spineEntries = typedRows<SpineRow>(spineResult.rows).map((row): FeedEntry => {
    const artists = parseArtistsJson(row.artists_json);
    const title = row.item_type === "mixtape" ? row.title : `${artists.join(", ")} - ${row.title}`;

    return {
      addedAt: row.added_at,
      guid: row.track_id,
      kind: row.item_type,
      link: row.item_type === "mixtape" ? logPageUrl(row.track_id) : (row.spotify_url ?? ""),
      summary: row.note?.trim() ? `${title}\n\n${row.note.trim()}` : title,
      title,
    };
  });

  const editionEntries = editions.reduce<FeedEntry[]>((entries, edition) => {
    const logId = edition.logId;
    const addedAt = edition.sentAt ?? edition.addedAt;

    // A letter with no coordinate never went out; it is not on the spine and not in
    // the feed.
    if (!logId || !addedAt) {
      return entries;
    }

    const count = editionFindingCount(edition.content);
    const title = `Letter No. ${edition.number}: ${edition.subject ?? "the week's findings"}`;
    const intro =
      edition.content.intro?.trim() ??
      `${count} ${count === 1 ? "finding" : "findings"} I sent the crew.`;

    entries.push({
      addedAt,
      guid: logId,
      kind: "edition",
      link: logPageUrl(logId),
      summary: `${title}\n\n${intro}`,
      title,
    });

    return entries;
  }, []);

  return [...spineEntries, ...editionEntries]
    .sort((a, b) =>
      a.addedAt < b.addedAt ? 1 : a.addedAt > b.addedAt ? -1 : a.guid < b.guid ? 1 : -1,
    )
    .slice(0, limit);
}
