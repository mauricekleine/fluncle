// Unit tests for the pure helpers in embed-sweep.ts — the box-script sweep is self-contained
// (it can't import the workspace) and lives outside any package's test runner, so this file
// uses `bun:test` and is run directly:
//
//   bun test docs/agents/hermes/scripts/embed-sweep.test.ts
//
// `main()` is guarded behind `import.meta.main` in the sweep, so importing it here is
// side-effect free (no R2 GET, no embedder spawn, no CLI). Keep this green when touching the
// source-selection or the temp-file extension logic.
import { describe, expect, test } from "bun:test";
import { chooseEmbedSource, sourceAudioExt } from "./embed-sweep";

describe("chooseEmbedSource", () => {
  test("embeds a finding with both a trackId and a captured key", () => {
    const source = chooseEmbedSource({
      logId: "004.7.2I",
      sourceAudioKey: "004.7.2I/abc123.webm",
      trackId: "track-1",
    });

    expect(source).toEqual({ key: "004.7.2I/abc123.webm", kind: "embed", trackId: "track-1" });
  });

  test("skips a finding with no captured full song — NEVER falls back to the preview", () => {
    // The queue is key-gated upstream, so this is the defensive path: no source_audio_key →
    // leave it queued, never preview-embed (the blind preview vectors are the thing we kill).
    const source = chooseEmbedSource({ logId: "004.7.2I", trackId: "track-1" });

    expect(source).toEqual({ kind: "skip", reason: "no_source_audio" });
  });

  test("skips a finding with no trackId (there is nothing to write the vector back to)", () => {
    const source = chooseEmbedSource({ logId: "004.7.2I", sourceAudioKey: "004.7.2I/abc.webm" });

    expect(source).toEqual({ kind: "skip", reason: "no_track_id" });
  });

  test("an empty-string key is treated as absent (skip, not embed)", () => {
    const source = chooseEmbedSource({ sourceAudioKey: "", trackId: "track-1" });

    expect(source).toEqual({ kind: "skip", reason: "no_source_audio" });
  });
});

describe("sourceAudioExt", () => {
  test("returns the captured container's extension, lowercased, with the leading dot", () => {
    expect(sourceAudioExt("004.7.2I/abc123.webm")).toBe(".webm");
    expect(sourceAudioExt("F-0001/deadbeef.OPUS")).toBe(".opus");
    expect(sourceAudioExt("010.2.9Z/hash.m4a")).toBe(".m4a");
  });

  test("falls back to .audio when the key has no usable extension", () => {
    // ffmpeg decodes by content, so the extension is hygiene, not load-bearing.
    expect(sourceAudioExt("004.7.2I/noext")).toBe(".audio");
    expect(sourceAudioExt("004.7.2I/trailingdot.")).toBe(".audio");
  });

  test("does not mistake a dotted logId directory for the extension", () => {
    // The logId "004.7.2I" carries dots, but the ext is parsed from the basename after the
    // last slash, so those dots never leak into the extension.
    expect(sourceAudioExt("004.7.2I/abcdef.mp3")).toBe(".mp3");
  });
});
