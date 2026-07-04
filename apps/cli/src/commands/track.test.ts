import { beforeEach, describe, expect, mock, test } from "bun:test";
import * as realApi from "../api";
import { CliError } from "../output";

// The re-render-contract guard must short-circuit BEFORE any network call, so the
// mock records every admin POST and throws a sentinel if the guard ever lets the
// flow reach the presign step. `bundle_incomplete` / `nothing_to_upload` cases must
// never reach it; the `--allow-partial` case must (and surface the sentinel).
let postCalls: string[] = [];

await mock.module("../api", () => ({
  ...realApi,
  adminApiPost: async (path: string) => {
    postCalls.push(path);
    throw new Error("PRESIGN_REACHED");
  },
}));

const { checkBundleCompleteness, trackVideoCommand } = await import("./track");

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
});
