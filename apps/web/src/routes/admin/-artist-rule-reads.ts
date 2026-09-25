import { getDb, typedRows } from "@/lib/server/db";
import { type ArtistRuleVerdict, type LabelArtistRuleVerdict } from "@/lib/server/artist-rules";
import { isMbid } from "./-artist-rule-identity";

export type LabelRuleCounts = { allow: number; block: number };

export type ArtistRuleState = {
  mbid: null | string;
  rule: null | { id: string; verdict: ArtistRuleVerdict };
};

export type RuleArtistMatch = { mbid: string; name: string };

const TYPEAHEAD_LIMIT = 8;

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

function likeContains(term: string): string {
  return `%${term.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

export async function labelRuleCounts(
  labelIds: readonly string[],
): Promise<Record<string, LabelRuleCounts>> {
  if (labelIds.length === 0) {
    return {};
  }

  const db = await getDb();
  const result = await db.execute({
    args: [...labelIds],

    sql: `select label_id, verdict, count(*) as total
          from artist_rules
          where label_id in (${placeholders(labelIds.length)})
            and verdict in ('allow', 'block')
          group by label_id, verdict`,
  });
  const counts: Record<string, LabelRuleCounts> = {};

  for (const row of typedRows<{
    label_id: string;
    total: number;
    verdict: LabelArtistRuleVerdict;
  }>(result.rows)) {
    const entry = (counts[row.label_id] ??= { allow: 0, block: 0 });
    entry[row.verdict] = Number(row.total);
  }

  return counts;
}

export async function ruledLabelCounts(): Promise<Record<string, number>> {
  const db = await getDb();
  const result = await db.execute({
    args: [],
    sql: `select labels.seed_state as seed_state, count(distinct artist_rules.label_id) as total
          from artist_rules
          join labels on labels.id = artist_rules.label_id
          group by labels.seed_state`,
  });
  const counts: Record<string, number> = {};

  for (const row of typedRows<{ seed_state: string; total: number }>(result.rows)) {
    counts[row.seed_state] = Number(row.total);
  }

  return counts;
}

export async function queuedReleaseCounts(
  labelSlugs: readonly string[],
): Promise<Record<string, number>> {
  if (labelSlugs.length === 0) {
    return {};
  }

  const db = await getDb();
  const result = await db.execute({
    args: [...labelSlugs],
    sql: `select label_slug, count(*) as total
          from crawl_frontier
          where kind = 'release'
            and state = 'pending'
            and label_slug in (${placeholders(labelSlugs.length)})
          group by label_slug`,
  });
  const counts: Record<string, number> = {};

  for (const row of typedRows<{ label_slug: string; total: number }>(result.rows)) {
    counts[row.label_slug] = Number(row.total);
  }

  return counts;
}

export async function searchRuleArtists(query: string): Promise<RuleArtistMatch[]> {
  const term = query.trim();

  if (term.length < 2) {
    return [];
  }

  const db = await getDb();

  if (isMbid(term)) {
    const exact = await db.execute({
      args: [term],
      sql: `select mbid, name from artists where mbid = ? order by id limit 1`,
    });

    return typedRows<{ mbid: string; name: string }>(exact.rows).map((row) => ({
      mbid: row.mbid,
      name: row.name,
    }));
  }

  const result = await db.execute({
    args: [likeContains(term), TYPEAHEAD_LIMIT],
    sql: `select mbid, name from artists
          where mbid is not null and name like ? escape '\\'
          order by name collate nocase, id
          limit ?`,
  });
  const seen = new Set<string>();
  const matches: RuleArtistMatch[] = [];

  for (const row of typedRows<{ mbid: string; name: string }>(result.rows)) {
    if (seen.has(row.mbid)) {
      continue;
    }

    seen.add(row.mbid);
    matches.push({ mbid: row.mbid, name: row.name });
  }

  return matches;
}

export async function artistRuleStates(
  artistIds: readonly string[],
): Promise<Record<string, ArtistRuleState>> {
  if (artistIds.length === 0) {
    return {};
  }

  const db = await getDb();
  const result = await db.execute({
    args: [...artistIds],
    sql: `select artists.id as artist_id, artists.mbid as mbid,
                 artist_rules.id as rule_id, artist_rules.verdict as verdict
          from artists
          left join artist_rules
            on artist_rules.artist_mbid = artists.mbid and artist_rules.label_id is null
          where artists.id in (${placeholders(artistIds.length)})`,
  });
  const states: Record<string, ArtistRuleState> = {};

  for (const row of typedRows<{
    artist_id: string;
    mbid: null | string;
    rule_id: null | string;
    verdict: ArtistRuleVerdict | null;
  }>(result.rows)) {
    states[row.artist_id] = {
      mbid: row.mbid,
      rule: row.rule_id && row.verdict ? { id: row.rule_id, verdict: row.verdict } : null,
    };
  }

  return states;
}
