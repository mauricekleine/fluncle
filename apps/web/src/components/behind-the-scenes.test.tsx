import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { type Track } from "@/lib/tracks";
import {
  effortLabel,
  hasVideoBehindTheScenes,
  humanizeGrain,
  humanizeModel,
  VideoBehindTheScenes,
} from "./behind-the-scenes";

// The behind-the-scenes trigger is a for-the-curious detail: it appears ONLY when a
// finding carries the video composition ledger (a rendered video AND the travelling
// vehicle, written together at upload). Older findings that predate the ledger get no
// trigger and no empty drawer. Assert the gate + that the trigger label ships in the
// server-rendered HTML (the drawer body is portalled + closed, so it stays out).

// The component reads only the video ledger fields + logId; a partial track is enough.
function track(overrides: Partial<Track>): Track {
  return overrides as Track;
}

const FULL = track({
  logId: "0042.A1",
  videoGrain: "grainCoarseSilver",
  videoModel: "anthropic/claude-opus-4-8",
  videoModelReasoning: "high",
  videoRegister: "abstract",
  videoUrl: "https://found.fluncle.com/0042.A1/footage.mp4",
  videoVehicle: "voronoi cellular",
});

describe("hasVideoBehindTheScenes", () => {
  it("is true only with a video AND a vehicle", () => {
    expect(hasVideoBehindTheScenes(FULL)).toBe(true);
    // A rendered video but no ledger (an older finding) — no trigger.
    expect(hasVideoBehindTheScenes(track({ ...FULL, videoVehicle: undefined }))).toBe(false);
    // A ledger but no video — nothing to explain.
    expect(hasVideoBehindTheScenes(track({ ...FULL, videoUrl: undefined }))).toBe(false);
  });
});

describe("copy transforms", () => {
  it("humanizes a grain family token into plain words", () => {
    expect(humanizeGrain("grainCoarseSilver")).toBe("coarse silver");
    expect(humanizeGrain("grainVhsScanline")).toBe("vhs scanline");
  });

  it("names a known model and degrades an unknown one to its slug", () => {
    expect(humanizeModel("anthropic/claude-opus-4-8")).toBe("Claude Opus 4.8");
    expect(humanizeModel("openai/gpt-5")).toBe("gpt-5");
  });

  it("labels the effort dial, falling back for an unknown level", () => {
    expect(effortLabel("high")).toBe("high reasoning");
    expect(effortLabel("medium")).toBe("medium reasoning");
    expect(effortLabel("ludicrous")).toBe("ludicrous reasoning");
  });
});

describe("VideoBehindTheScenes", () => {
  it("renders the trigger when the composition ledger is present", () => {
    const html = renderToString(<VideoBehindTheScenes track={FULL} />);

    expect(html).toContain("How I made it");
  });

  it("renders nothing when the finding predates the ledger", () => {
    const withoutVehicle = renderToString(
      <VideoBehindTheScenes track={track({ ...FULL, videoVehicle: undefined })} />,
    );
    const withoutVideo = renderToString(
      <VideoBehindTheScenes track={track({ ...FULL, videoUrl: undefined })} />,
    );

    expect(withoutVehicle).toBe("");
    expect(withoutVideo).toBe("");
  });
});
