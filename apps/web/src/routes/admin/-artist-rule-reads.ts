// The PAGE-LOCAL reads behind the two artist-rule admin surfaces (`/admin/labels` and
// `/admin/artists`). Every function here is a bounded aggregate over the rows the operator can
// actually see — never a whole-corpus fold — and none of them is a public operation: the rule
// WRITES all ride the oRPC ops (`replace_label_artist_rules`, `add_artist_rule`,
// `remove_artist_rule`), and the per-rule reads ride `list_label_artist_rules` /
// `list_artist_rules`. What lives here is exactly the board-shaped glue those ops do not carry:
// per-page counts, the queued-release read, and the artist typeahead.
//
// It sits beside the routes as a `-` sibling (the router ignores the prefix) because it is that
// station's own read, not a shared server module — the `-*-page-data.ts` precedent from
// docs/client-bundle.md.
//
// ── WHAT AN ARTIST RULE IS ──────────────────────────────────────────────────────────────────
// A label's `seed_state` is the default; an artist rule is an EXCEPTION to it. An enabled label
// with blocks reads "everything except these artists"; a skipped label with allows reads "only
// these artists". Both are ACQUISITION scope: they change what the next crawl takes and never
// touch a row already stored.

import { getDb, typedRows } from "@/lib/server/db";
import { type ArtistRuleVerdict } from "@/lib/server/artist-rules";
import { isMbid } from "./-artist-rule-identity";

/** The rule counts for one label, split by verdict — the board's chip reads the live half. */
export type LabelRuleCounts = { allow: number; block: number };

/** An artist's global-rule standing, plus the MBID a rule write needs as its match key. */
export type ArtistRuleState = {
  mbid: null | string;
  rule: null | { id: string; verdict: ArtistRuleVerdict };
};

/** One typeahead hit: the exact MusicBrainz identity a rule matches on, with its display name. */
export type RuleArtistMatch = { mbid: string; name: string };

const TYPEAHEAD_LIMIT = 8;

/** `in (?, ?, …)` for a bounded id set — the visible page, never a growing list. */
function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

// Escape LIKE metacharacters so a typed name matches as a literal substring, not as a pattern.
function likeContains(term: string): string {
  return `%${term.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

/**
 * The rule counts for the labels on ONE visible page, grouped in SQL over
 * `artist_rules_label_id_idx`. A label with no rules is simply absent from the map.
 */
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
          group by label_id, verdict`,
  });
  const counts: Record<string, LabelRuleCounts> = {};

  for (const row of typedRows<{
    label_id: string;
    total: number;
    verdict: ArtistRuleVerdict;
  }>(result.rows)) {
    const entry = (counts[row.label_id] ??= { allow: 0, block: 0 });
    entry[row.verdict] = Number(row.total);
  }

  return counts;
}

/**
 * How many labels carry an artist rule, per seed state — the number each settled section's intro
 * leads with. One grouped read over the whole `artist_rules` table, which is operator-authored
 * and small by construction (100 rules per label, a handful of labels).
 */
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

/**
 * Pending RELEASE nodes per label slug — the work a re-walk still owes, read once for the visible
 * page over `crawl_frontier_label_idx`. Enabling a label or changing its rules re-arms its release
 * nodes, and this is the only honest answer to "is anything actually coming?": a label with
 * nothing queued shows no number at all.
 */
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

/**
 * The rules dialog's artist typeahead, over the LOCAL `artists` table — never a live MusicBrainz
 * call from a dialog render (the crawler's MB budget is one request a second and a dialog is not
 * allowed to spend it). A pasted MBID resolves exactly; a typed name matches as a substring.
 *
 * Only artists carrying an `mbid` can be returned, because the MBID is what a rule matches on —
 * a name or a local `artists.id` is not an identity the crawler's gate can use.
 */
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

/**
 * The global-rule standing of the artists on ONE visible board page, plus each row's MBID.
 *
 * Both halves come from one indexed read (`artists_mbid_idx` on the left join): the MBID is what
 * the row's rule ACTION posts as its match key, and the joined rule is what the row's badge reads.
 * An artist with no MBID resolved yet carries a null one — that row cannot be ruled, and the menu
 * says so rather than offering an action that would be refused at the boundary.
 */
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
