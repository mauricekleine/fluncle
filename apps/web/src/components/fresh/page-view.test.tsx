import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const visit = vi.hoisted(() => ({ calls: [] as string[][] }));

vi.mock("@/lib/fresh-visit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/fresh-visit")>();

  return {
    ...actual,
    useFreshVisit: (keys: string[]) => {
      visit.calls.push(keys);

      return undefined;
    },
  };
});

import { type FreshPage } from "@/lib/fresh-releases";
import { freshJumpTarget, FreshPageView } from ".";

const EMPTY: FreshPage = {
  coverage: { kind: "complete" },
  releaseCount: 0,
  standouts: undefined,
  today: "2026-09-25",
  trackCount: 0,
  weeks: [],
  windowDays: 30,
};

describe("FreshPageView", () => {
  it("records the visit on an empty window too, so a release that lands next reads as new", () => {
    visit.calls = [];

    const html = renderToString(
      <FreshPageView onViewChange={() => undefined} page={EMPTY} view="all" />,
    );

    expect(html).toContain("No new releases in the last 30 days.");
    expect(visit.calls).toEqual([[]]);
  });
});

describe("freshJumpTarget", () => {
  function entry(controls: Record<string, string>): Pick<Element, "querySelector"> {
    return {
      querySelector: ((selector: string) =>
        selector in controls
          ? ({ id: controls[selector] } as unknown as Element)
          : null) as Element["querySelector"],
    };
  }

  it("lands on the entry's own link when it has one", () => {
    expect(
      freshJumpTarget(entry({ ".discovery-row-link": "link", ".fresh-release-toggle": "toggle" })),
    ).toEqual({ id: "link" });
  });

  it("lands on the fold toggle of a record with no album page", () => {
    expect(
      freshJumpTarget(
        entry({ ".fresh-release-toggle": "toggle", "[data-discovery-play]": "play" }),
      ),
    ).toEqual({ id: "toggle" });
  });

  it("lands on the play control when an entry has nothing else to focus", () => {
    expect(freshJumpTarget(entry({ "[data-discovery-play]": "play" }))).toEqual({ id: "play" });
  });
});
