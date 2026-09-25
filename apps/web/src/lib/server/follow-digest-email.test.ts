import { describe, expect, it } from "vitest";
import { renderFollowDigestEmail } from "./follow-digest-email";

describe("follow digest email", () => {
  it("escapes catalogue text and includes both signed links in HTML and text", () => {
    const result = renderFollowDigestEmail({
      items: [
        {
          artists: "A & B",
          coverUrl: "https://example.com/cover.jpg",
          followName: "<Label>",
          href: "https://www.fluncle.com/track/one",
          title: "<script>alert(1)</script>",
        },
      ],
      manageUrl: "https://www.fluncle.com/follows?token=abc",
      more: true,
      unsubscribeUrl: "https://www.fluncle.com/api/v1/follow-digest/unsubscribe?token=def",
    });
    expect(result.html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(result.html).toContain("A &amp; B");
    expect(result.html).toContain("&lt;Label&gt;");
    expect(result.html).not.toContain("<script>");
    expect(result.html).toContain("width:64px");
    expect(result.text).toContain("/follows?token=abc");
    expect(result.text).toContain("A & B — <script>alert(1)</script>");
    expect(result.html).toContain('lang="en"');
    expect(result.text).toContain("token=def");
  });
});
