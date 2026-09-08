import { createClient, type Client } from "@libsql/client";

import { LOCAL_DB_CONCURRENCY } from "../lib/database-concurrency";

/**
 * The projection control-plane schema as the integration suites see it: every table the bounded
 * maintenance, repair, audit, and anchor paths touch, in an in-memory libSQL client.
 */
export const PROJECTION_TEST_SCHEMA = `
create table settings (key text primary key, value text not null);
create table due_work (
  work_kind text not null, subject_type text not null, subject_id text not null default '',
  state text not null, sort_key text not null default '', next_due_at text not null default '',
  claim_expires_at text, generation text not null default '', updated_at text not null default '',
  primary key (work_kind, subject_type, subject_id)
);
create index due_work_ready_idx on due_work(work_kind, state, sort_key, subject_id)
  where state = 'ready';
create index due_work_scheduled_idx on due_work(work_kind, state, next_due_at, subject_id)
  where state = 'scheduled';
create index due_work_repair_idx on due_work(state, subject_type, subject_id)
  where state = 'repair';
create index due_work_lease_idx on due_work(state, claim_expires_at, work_kind, subject_id)
  where state = 'leased';
create table due_work_rebuilds (
  work_kind text not null, subject_type text not null, state text not null,
  scanned_count integer not null, projected_count integer not null,
  generation text not null default 'complete', cursor text,
  started_at text not null default '', updated_at text not null default '', completed_at text,
  primary key (work_kind, subject_type)
);
create table crawl_frontier (
  id text primary key, kind text not null default 'release', hop integer not null default 0,
  demand_rank integer not null default 0, created_at text not null default '',
  label_slug text, parent_id text, updated_at text not null default ''
);
create table crawl_due_work (
  node_id text primary key, state text not null, hop integer not null default 0,
  demand_rank integer not null default 0, created_at text not null default '',
  next_due_at text, claim_expires_at text, generation text not null default '',
  updated_at text not null default '', claim_position integer, claim_token text,
  claimed_by text, label_slug text, node_kind text not null default 'release',
  parent_id text, source_version text not null default '', storable_rank integer not null default 0
);
create index crawl_due_work_ready_idx
  on crawl_due_work(state, hop, demand_rank, created_at, node_id) where state = 'ready';
create index crawl_due_work_scheduled_idx
  on crawl_due_work(state, next_due_at, node_id) where state = 'scheduled';
create index crawl_due_work_repair_idx
  on crawl_due_work(state, node_id) where state = 'repair';
create index crawl_due_work_lease_idx
  on crawl_due_work(state, claim_expires_at, node_id) where state = 'leased';
create table crawl_projection_repairs (
  source_epoch integer not null default 0, source_type text not null default '',
  source_id text not null, source_version text not null default '',
  created_at text not null default '', updated_at text not null default ''
);
create index crawl_projection_repairs_order_idx
  on crawl_projection_repairs(source_epoch, source_type, source_id);
create table crawl_due_work_rebuilds (
  scope text primary key, state text not null, scanned_count integer not null,
  projected_count integer not null, source_digest text, projected_digest text,
  generation text not null default 'complete', cursor text,
  started_at text not null default '', updated_at text not null default '', completed_at text
);
create table projection_repairs (
  projection text not null, source_epoch integer not null default 0,
  subject_type text not null default '', subject_id text not null default '',
  source_version text not null default '', created_at text not null default '',
  updated_at text not null default '',
  primary key (projection, subject_type, subject_id)
);
create index projection_repairs_order_idx
  on projection_repairs(projection, source_epoch, subject_type, subject_id);
create table tracks (
  track_id text primary key, release_date text, key text, label_id text,
  has_embedding integer not null default 0
);
create index tracks_release_date_track_id_idx on tracks(release_date desc, track_id desc);
create index tracks_label_id_idx on tracks(label_id, track_id);
create table track_artists (
  track_id text not null, artist_id text not null, role text,
  primary key (track_id, artist_id)
);
create index track_artists_artist_id_idx on track_artists(artist_id);
create table findings (track_id text primary key);
create table labels (id text primary key, seed_state text);
create table artists (id text primary key);
create table artist_qualification_contributions (
  track_id text not null, artist_id text not null,
  certified_contribution integer not null, enabled_credit_half_units integer not null,
  primary key (track_id, artist_id)
);
create table artist_qualification (
  artist_id text primary key, certified_finding_count integer not null,
  enabled_credit_half_units integer not null, is_qualified integer not null
);
create table public_aggregate_membership (
  track_id text primary key, release_date_bucket text, key_bucket text,
  generation text not null default 'live', source_version text not null default '',
  updated_at text not null default ''
);
create table public_aggregate_counts (
  aggregate_kind text not null, bucket text not null, track_count integer not null,
  generation text not null default 'live', source_version text not null default '',
  updated_at text not null default '',
  primary key (aggregate_kind, bucket)
);
create table public_aggregate_state (
  scope text primary key, state text not null, scanned_count integer not null,
  projected_entry_count integer not null, source_digest text, projected_digest text,
  source_epoch integer not null, aggregate_epoch integer not null,
  default_track_total integer not null, release_hub_order_epoch integer not null,
  generation text not null, cursor text, source_entry_count integer not null default 0,
  rebuild_start_epoch integer not null default 0, started_at text not null default '',
  updated_at text not null default '', completed_at text
);
create table artist_qualification_state (
  scope text primary key, state text not null, scanned_count integer not null,
  projected_qualified_count integer not null, source_digest text, projected_digest text,
  source_epoch integer not null, projection_epoch integer not null,
  generation text not null default 'complete', cursor text,
  source_qualified_count integer not null default 0,
  rebuild_start_epoch integer not null default 0, started_at text not null default '',
  updated_at text not null default '', completed_at text
);
create table hub_page_anchor_validity (
  hub text not null, clause_hash text not null, anchor_format_version integer not null,
  order_epoch integer not null, generation text not null, published_at text,
  primary key (hub, clause_hash)
);
create table hub_page_anchors (
  hub text not null, clause_hash text not null, anchors_json text not null,
  fingerprint text not null default '', computed_at text not null default '',
  primary key (hub, clause_hash)
);
`;

export async function createProjectionTestDb(): Promise<Client> {
  const db = createClient({ concurrency: LOCAL_DB_CONCURRENCY, url: ":memory:" });
  await db.executeMultiple(PROJECTION_TEST_SCHEMA);
  return db;
}
