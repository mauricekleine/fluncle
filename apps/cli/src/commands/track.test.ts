import { beforeEach, describe, expect, mock, test } from "bun:test";
import * as realApi from "../api";
import { CliError } from "../output";

// The re-render-contract guard must short-circuit BEFORE any network call, so the
// mock records every admin POST and (by default) throws a sentinel if the guard
// ever lets the flow reach the presign step. `bundle_incomplete` /
// `nothing_to_upload` cases must never reach it; the `--allow-partial` case must
// (and surface the sentinel). Tests that need the FULL flow (the plates-only
// pre-upload) swap `adminApiPostImpl` for a live presign fake.
let postCalls: string[] = [];

let adminApiPostImpl: (path: string, body?: unknown) => Promise<unknown> = async () => {
  throw new Error("PRESIGN_REACHED");
};

await mock.module("../api", () => ({
  ...realApi,
  adminApiPost: async (path: string, body?: unknown) => {
    postCalls.push(path);
    return adminApiPostImpl(path, body);
  },
}));

const { checkBundleCompleteness, isPlatesOnlyUpload, trackVideoCommand } = await import("./track");

// A resolved-files set with every re-render-contract + advisory file present. The
// guard checks truthiness only (the caller resolves paths), so placeholder paths are
// enough — no file needs to exist on disk.
const fullBundle = {
  composition: "/out/032.0.4L/composition.tsx",
  footage: "/out/032.0.4L/footage.mp4",
  footageSocial: "/out/032.0.4L/footage.social.mp4",
  intent: "/out/032.0.4L/intent.json",
  metrics: "/out/032.0.4L/metrics.json",
  poster: "/out/032.0.4L/poster.jpg",
  props: "/out/032.0.4L/props.json",
  render: "/out/032.0.4L/render.json",
  scene: "/out/032.0.4L/scene.json",
};

describe("checkBundleCompleteness", () => {
  test("a full bundle is complete — footage present, nothing missing", () => {
    const result = checkBundleCompleteness(fullBundle);

    expect(result.uploadingFootage).toBe(true);
    expect(result.missingContract).toEqual([]);
    expect(result.missingAdvisory).toEqual([]);
  });

  test("footage without the contract flags all three contract files (the regression)", () => {
    const result = checkBundleCompleteness({
      footage: "/out/x/footage.mp4",
      footageSocial: "/out/x/footage.social.mp4",
      poster: "/out/x/poster.jpg",
    });

    expect(result.uploadingFootage).toBe(true);
    expect(result.missingContract).toEqual(["composition.tsx", "props.json", "render.json"]);
    expect(result.missingAdvisory).toEqual(["intent.json", "metrics.json", "scene.json"]);
  });

  test("a footage master OTHER than the square cut still arms the contract check", () => {
    const result = checkBundleCompleteness({ footageSocial: "/out/x/footage.social.mp4" });

    expect(result.uploadingFootage).toBe(true);
    expect(result.missingContract).toEqual(["composition.tsx", "props.json", "render.json"]);
  });

  test("a poster-only refresh uploads no footage, so the contract is not armed", () => {
    const result = checkBundleCompleteness({ poster: "/out/x/poster.jpg" });

    expect(result.uploadingFootage).toBe(false);
    expect(result.missingContract).toEqual([]);
    expect(result.missingAdvisory).toEqual([]);
  });

  test("names only the contract file actually missing (render.json here)", () => {
    const result = checkBundleCompleteness({
      composition: "/out/x/composition.tsx",
      footage: "/out/x/footage.mp4",
      props: "/out/x/props.json",
    });

    expect(result.missingContract).toEqual(["render.json"]);
  });

  test("a plate-only upload (no footage) does not arm the contract — the guard passes", () => {
    const result = checkBundleCompleteness({
      plate: "/out/x/plate.png",
      plateBackground: "/out/x/plate.background.png",
    });

    expect(result.uploadingFootage).toBe(false);
    expect(result.missingContract).toEqual([]);
    expect(result.missingAdvisory).toEqual([]);
    expect(result.plateWarnings).toEqual([]);
  });

  test("a plate-less footage bundle is valid — plates are optional, no warnings", () => {
    const result = checkBundleCompleteness(fullBundle);

    expect(result.plateWarnings).toEqual([]);
  });

  test("a background WITHOUT its plate warns (advisory, never a block)", () => {
    const result = checkBundleCompleteness({ plateBackground: "/out/x/plate.background.png" });

    expect(result.missingContract).toEqual([]);
    expect(result.plateWarnings.length).toBe(1);
    expect(result.plateWarnings[0]).toContain("plate.background.png without plate.png");
  });

  test("a plate bundle missing its background is fine (no warning)", () => {
    const result = checkBundleCompleteness({ ...fullBundle, plate: "/out/x/plate.png" });

    expect(result.plateWarnings).toEqual([]);
  });
});

describe("isPlatesOnlyUpload", () => {
  test("plate alone, plate+background, and background alone are plates-only", () => {
    expect(isPlatesOnlyUpload({ plate: "/out/x/plate.png" })).toBe(true);
    expect(
      isPlatesOnlyUpload({
        plate: "/out/x/plate.png",
        plateBackground: "/out/x/plate.background.png",
      }),
    ).toBe(true);
    expect(isPlatesOnlyUpload({ plateBackground: "/out/x/plate.background.png" })).toBe(true);
  });

  test("a plate mixed with any other artifact is NOT plates-only", () => {
    expect(isPlatesOnlyUpload({ plate: "/out/x/plate.png", poster: "/out/x/poster.jpg" })).toBe(
      false,
    );
    expect(isPlatesOnlyUpload({ footage: "/out/x/footage.mp4", plate: "/out/x/plate.png" })).toBe(
      false,
    );
  });

  test("no plates at all is NOT plates-only (a poster-only refresh keeps its own path)", () => {
    expect(isPlatesOnlyUpload({ poster: "/out/x/poster.jpg" })).toBe(false);
    expect(isPlatesOnlyUpload({})).toBe(false);
  });
});

describe("trackVideoCommand bundle guard", () => {
  beforeEach(() => {
    postCalls = [];
  });

  // Await a call and return whatever it throws (or null) — bun's `.rejects` matcher
  // reads as a non-thenable to the type-aware linter, so capture the error directly.
  const capture = async (run: () => Promise<unknown>): Promise<unknown> => {
    try {
      await run();
      return null;
    } catch (error) {
      return error;
    }
  };

  test("a footage-only upload hard-errors (bundle_incomplete) BEFORE any network call", async () => {
    const error = await capture(() =>
      trackVideoCommand("032.0.4L", {
        footage: "/out/x/footage.mp4",
        footageSocial: "/out/x/footage.social.mp4",
        poster: "/out/x/poster.jpg",
      }),
    );

    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).code).toBe("bundle_incomplete");
    expect(postCalls).toEqual([]);
  });

  test("--allow-partial gets PAST the guard to the upload (proves the override works)", async () => {
    const error = await capture(() =>
      trackVideoCommand("032.0.4L", { footage: "/out/x/footage.mp4" }, undefined, {
        allowPartial: true,
      }),
    );

    // Not bundle_incomplete — it reaches the presign step (our sentinel).
    expect((error as Error).message).toContain("PRESIGN_REACHED");
    expect(postCalls.length).toBe(1);
  });

  test("a complete bundle passes the guard and reaches the upload", async () => {
    const error = await capture(() => trackVideoCommand("032.0.4L", fullBundle));

    expect((error as Error).message).toContain("PRESIGN_REACHED");
    expect(postCalls.length).toBe(1);
  });

  test("an empty upload set is refused (nothing_to_upload), no network call", async () => {
    const error = await capture(() => trackVideoCommand("032.0.4L", {}));

    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).code).toBe("nothing_to_upload");
    expect(postCalls).toEqual([]);
  });

  test("a plates-only upload passes the guard, PUTs the plates, and NEVER finalizes", async () => {
    // A finalize on a plate pre-upload would set video_url and dequeue the finding
    // from the render queue before it is filmed — the one call this flow must not make.
    adminApiPostImpl = async (path: string) => {
      if (!path.endsWith("/video/uploads")) {
        throw new Error(`FINALIZE_REACHED: ${path}`);
      }
      return {
        logId: "032.0.4L",
        ok: true,
        trackId: "track-1",
        uploads: [
          {
            contentType: "image/png",
            field: "plate",
            key: "032.0.4L/plate.png",
            url: "https://r2/put?sig=p",
          },
          {
            contentType: "image/png",
            field: "plate-background",
            key: "032.0.4L/plate.background.png",
            url: "https://r2/put?sig=b",
          },
        ],
      };
    };
    const realFetch = globalThis.fetch;
    const putUrls: string[] = [];
    globalThis.fetch = (async (url: unknown) => {
      putUrls.push(String(url));
      return new Response("", { status: 200 });
    }) as typeof fetch;

    try {
      const result = await trackVideoCommand("032.0.4L", {
        plate: "/out/x/plate.png",
        plateBackground: "/out/x/plate.background.png",
      });

      expect(result).toEqual({
        logId: "032.0.4L",
        ok: true,
        trackId: "track-1",
        urls: {
          plate: "https://found.fluncle.com/032.0.4L/plate.png",
          "plate-background": "https://found.fluncle.com/032.0.4L/plate.background.png",
        },
      });
      expect(putUrls).toEqual(["https://r2/put?sig=p", "https://r2/put?sig=b"]);
      // Exactly ONE admin POST — the presign; finalize was never called.
      expect(postCalls).toEqual(["/api/admin/tracks/032.0.4L/video/uploads"]);
    } finally {
      globalThis.fetch = realFetch;
      adminApiPostImpl = async () => {
        throw new Error("PRESIGN_REACHED");
      };
    }
  });
});
