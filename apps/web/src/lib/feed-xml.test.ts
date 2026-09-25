import { describe, expect, it } from "vitest";
import { escapeXml } from "./feed-xml";

describe("escapeXml", () => {
  it('escapes the four characters that break XML text and "…" attributes', () => {
    expect(escapeXml('&<>"')).toBe("&amp;&lt;&gt;&quot;");
  });

  it("escapes the ampersand first, so an escape is never double-escaped", () => {
    expect(escapeXml("<b>")).toBe("&lt;b&gt;");
    expect(escapeXml("&amp;")).toBe("&amp;amp;");
  });

  it("escapes every occurrence, not just the first", () => {
    expect(escapeXml("a & b & c")).toBe("a &amp; b &amp; c");
  });

  it("leaves the apostrophe alone — every call site is text or a double-quoted attribute", () => {
    expect(escapeXml("Don't Stop")).toBe("Don't Stop");
  });

  it("passes plain text and the empty string through untouched", () => {
    expect(escapeXml("Break the Silence")).toBe("Break the Silence");
    expect(escapeXml("")).toBe("");
  });

  it("keeps a real feed value safe in both positions it is used in", () => {
    const title = 'Rollers & "Bangers" <live>';

    expect(`<title>${escapeXml(title)}</title>`).toBe(
      "<title>Rollers &amp; &quot;Bangers&quot; &lt;live&gt;</title>",
    );
    expect(`<img alt="${escapeXml(title)}"/>`).toBe(
      '<img alt="Rollers &amp; &quot;Bangers&quot; &lt;live&gt;"/>',
    );
  });
});
