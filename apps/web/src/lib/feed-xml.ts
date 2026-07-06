// Shared XML escaping for the syndication feeds (atom.xml / rss.xml / podcast.xml).
// One definition so the three feeds can't drift. Escapes the five chars that are
// unsafe in XML text + double-quoted attribute values (`"` rides along so the same
// helper is safe inside `href="…"`), leaving the feed bodies valid for every reader.

/** Escape a string for safe interpolation into XML text or a `"…"` attribute. */
export function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
