import { badgeVariants } from "@fluncle/ui/components/badge";
import { buttonVariants } from "@fluncle/ui/components/button";
import { describe, expect, it } from "vitest";

const FADED_FILL_ON_HOVER = /(?:^|\s)\S*hover:bg-(?:primary|secondary)\/\d+(?:\s|$)/;

describe("the Ignition Rule on the shared filled controls", () => {
  it.each(["default", "secondary"] as const)(
    "a %s button heats on hover instead of fading its own fill",
    (variant) => {
      expect(buttonVariants({ variant })).not.toMatch(FADED_FILL_ON_HOVER);
    },
  );

  it.each(["default", "secondary"] as const)(
    "a %s badge rendered as a link heats on hover instead of fading its own fill",
    (variant) => {
      expect(badgeVariants({ variant })).not.toMatch(FADED_FILL_ON_HOVER);
    },
  );

  it("a gold badge rendered as a link ignites to Eclipse Glow, like the primary button", () => {
    expect(badgeVariants({ variant: "default" })).toContain("[a]:hover:bg-[var(--eclipse-glow)]");
    expect(buttonVariants({ variant: "default" })).toContain("hover:bg-[var(--eclipse-glow)]");
  });
});
