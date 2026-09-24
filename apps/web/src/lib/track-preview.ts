/** A row can play when it carries a stored preview URL or an ISRC (the relay's live sources). */
export function hasPreviewSource(row: {
  isrc?: string | null;
  previewUrl?: string | null;
}): boolean {
  return Boolean(row.previewUrl?.trim() || row.isrc?.trim());
}
