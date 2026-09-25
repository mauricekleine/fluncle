export const FILL_ISRC_SQL = `isrc = coalesce(isrc, ?),
              has_isrc = (trim(coalesce(isrc, ?, '')) <> '')`;

export function hasIsrc(isrc: null | string | undefined): 0 | 1 {
  return isrc?.trim() ? 1 : 0;
}
