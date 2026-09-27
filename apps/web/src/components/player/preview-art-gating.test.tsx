import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SavesDoor } from "@/components/account/saves-door";
import { type SavedFinding } from "@/components/account/shared";
import { RecommendedPanel } from "@/components/recommendations/recommended-panel";
import { type RecommendationFindingItem } from "@/components/recommendations/shared";

async function render(node: ReactNode): Promise<string> {
  const rootRoute = createRootRoute({ component: () => node });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: rootRoute.addChildren(
      ["/", "/log/$logId", "/track/$trackId"].map((path) =>
        createRoute({ getParentRoute: () => rootRoute, path }),
      ),
    ),
  });

  await router.load();

  return renderToString(<RouterProvider router={router} />);
}

function saved(previewable: boolean, title: string): SavedFinding {
  return {
    artists: ["Nova Kestrel"],
    href: `/log/701.1.0${title[0]}`,
    logId: `701.1.0${title[0]}`,
    previewable,
    savedAt: "2026-01-01T00:00:00.000Z",
    title,
    trackId: `track-${title}`,
  };
}

function recommended(previewable: boolean, title: string): RecommendationFindingItem {
  return {
    artists: ["Cobalt Mirage"],
    logId: `702.2.0${title[0]}`,
    previewable,
    similarity: 0.9,
    title,
    trackId: `track-${title}`,
  };
}

const noop = () => Promise.resolve();

describe("preview controls on saved and recommended findings", () => {
  it("draws a saved finding's play control only when its preview can sound", async () => {
    const html = await render(
      <SavesDoor
        csrfToken="csrf"
        data={{
          follows: [],
          followsEmail: { subscribed: false, token: "" },
          saved: [saved(true, "Audible"), saved(false, "Silent")],
          sets: [],
          submissions: [],
          tab: "saves",
        }}
        refresh={noop}
      />,
    );

    expect(html).toContain('aria-label="Play the preview of Audible"');
    expect(html).not.toContain("Play the preview of Silent");
    expect(html.match(/class="preview-art-btn"/g)).toHaveLength(1);
    expect(html).toContain('aria-label="Open the log page for Nova Kestrel — Silent"');
  });

  it("draws a recommended finding's play control only when its preview can sound", async () => {
    const html = await render(
      <RecommendedPanel
        catalogue={[]}
        findings={[recommended(true, "Audible"), recommended(false, "Silent")]}
        onAdd={noop}
        onRemove={noop}
        seeds={[]}
        seedsSkipped={[]}
      />,
    );

    expect(html).toContain('aria-label="Play the preview of Audible"');
    expect(html).not.toContain("Play the preview of Silent");
    expect(html.match(/class="preview-art-btn"/g)).toHaveLength(1);
    expect(html).toContain("Cobalt Mirage — Silent");
  });
});
