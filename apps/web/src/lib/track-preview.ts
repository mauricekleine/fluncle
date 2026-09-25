export function hasPreviewSource(row: {
  isrc?: string | null;
  previewUrl?: string | null;
}): boolean {
  return Boolean(row.previewUrl?.trim() || row.isrc?.trim());
}
