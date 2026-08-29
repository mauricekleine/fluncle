// One input can name either the recording primary key or a finding's unique coordinate. These
// CTEs keep those identities as independent index seeks and make a raw track ID authoritative
// when it collides with another row's Log ID.
export const TRACK_OR_LOG_ID_CTE = `resolved_track(track_id) as (
  select tracks.track_id from tracks
  where tracks.track_id = ?
  union all
  select findings.track_id from findings
  join tracks on tracks.track_id = findings.track_id
  where findings.log_id = ?
    and not exists (
      select 1 from tracks as preferred_track where preferred_track.track_id = ?
    )
  limit 1
)`;

// Finding-scoped resolvers only give the raw ID branch precedence when it identifies a complete
// finding+track pair. An uncertified catalogue row must not hide a valid Log ID match.
export const FINDING_TRACK_OR_LOG_ID_CTE = `resolved_track(track_id) as (
  select tracks.track_id from tracks
  join findings on findings.track_id = tracks.track_id
  where tracks.track_id = ?
  union all
  select findings.track_id from findings
  join tracks on tracks.track_id = findings.track_id
  where findings.log_id = ?
    and not exists (
      select 1 from tracks as preferred_track
      join findings as preferred_finding on preferred_finding.track_id = preferred_track.track_id
      where preferred_track.track_id = ?
    )
  limit 1
)`;

// Identity-envelope references are deliberately plural: a value that is one row's primary key and
// another row's Log ID returns both, just as the former cross-table OR did. The second arm only
// removes the same-row duplicate that OR semantics would have collapsed.
export const ALL_TRACK_OR_LOG_ID_MATCHES_CTE = `resolved_tracks(track_id) as (
  select tracks.track_id from tracks
  where tracks.track_id = ?
  union all
  select findings.track_id from findings
  join tracks on tracks.track_id = findings.track_id
  where findings.log_id = ? and findings.track_id <> ?
)`;

export function bulkTrackOrLogIdCte(inputCount: number): string {
  if (!Number.isSafeInteger(inputCount) || inputCount < 1) {
    throw new Error("bulk track resolver requires at least one input");
  }

  return `input(value) as (values ${Array.from({ length: inputCount }, () => "(?)").join(", ")}),
    resolved_tracks(track_id, log_id) as (
      select tracks.track_id, findings.log_id
      from input
      join tracks on tracks.track_id = input.value
      left join findings on findings.track_id = tracks.track_id
      union all
      select tracks.track_id, findings.log_id
      from input
      join findings on findings.log_id = input.value
      join tracks on tracks.track_id = findings.track_id
      where not exists (
        select 1 from tracks as preferred_track
        where preferred_track.track_id = input.value
      )
        and not exists (
          select 1 from input as raw_input where raw_input.value = findings.track_id
        )
    )`;
}
