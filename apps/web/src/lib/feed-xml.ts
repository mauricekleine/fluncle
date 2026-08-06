// Shared XML escaping for the syndication feeds (atom.xml / rss.xml / podcast.xml /
// fresh.xml). One definition so the feeds can't drift. Escapes the four chars that are
// unsafe in XML text + double-quoted attribute values (`"` rides along so the same
// helper is safe inside `href="…"`), leaving the feed bodies valid for every reader.
// `'` is deliberately left alone — no call site interpolates into a `'…'` attribute,
// so escaping it would only put `&apos;` in front of readers (see feed-xml.test.ts).

/** Escape a string for safe interpolation into XML text or a `"…"` attribute. */
export function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
