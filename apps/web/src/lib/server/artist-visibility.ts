export function listedArtistWhere(alias = "artists", tablePrefix = ""): string {
  return `${alias}.slug not in (
    select unlisted_artist.slug
    from ${tablePrefix}artist_rules as unlisted_rule
    join ${tablePrefix}artists as unlisted_artist on unlisted_artist.mbid = unlisted_rule.artist_mbid
    where unlisted_rule.label_id is null and unlisted_rule.verdict = 'unlisted'
  )`;
}
