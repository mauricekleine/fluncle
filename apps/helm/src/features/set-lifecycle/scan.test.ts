import { describe, expect, test } from "bun:test";

import {
  isMasterAudioFile,
  isSetVideoFile,
  type MovieEntry,
  parseFfprobeDurationMs,
  sortMoviesNewestFirst,
  takeDefaultsFromFilename,
} from "./scan";

describe("file classification", () => {
  test("admits real captures, rejects dotfiles and non-video", () => {
    expect(isSetVideoFile("2026-07-05 11-29-50.mov")).toBe(true);
    expect(isSetVideoFile("set.MP4")).toBe(true);
    expect(isSetVideoFile("clip.mkv")).toBe(true);
    expect(isSetVideoFile(".DS_Store")).toBe(false);
    expect(isSetVideoFile("mixtape-2026-06-28.mp3")).toBe(false);
    expect(isSetVideoFile("notes.txt")).toBe(false);
  });

  test("admits audio masters for distribution", () => {
    expect(isMasterAudioFile("fluncle-mixtape-2026-06-28.mp3")).toBe(true);
    expect(isMasterAudioFile("mixtape.m4a")).toBe(true);
    expect(isMasterAudioFile("2026-07-05 11-29-50.mov")).toBe(false);
    expect(isMasterAudioFile(".localized")).toBe(false);
  });
});

describe("sortMoviesNewestFirst", () => {
  test("orders by modified time, newest first", () => {
    const entries: MovieEntry[] = [
      { modifiedMs: 100, name: "old.mov", path: "/m/old.mov", sizeBytes: 1 },
      { modifiedMs: 300, name: "new.mov", path: "/m/new.mov", sizeBytes: 1 },
      { modifiedMs: 200, name: "mid.mov", path: "/m/mid.mov", sizeBytes: 1 },
    ];

    expect(sortMoviesNewestFirst(entries).map((entry) => entry.name)).toEqual([
      "new.mov",
      "mid.mov",
      "old.mov",
    ]);
  });

  test("does not mutate the input", () => {
    const entries: MovieEntry[] = [
      { modifiedMs: 1, name: "a", path: "/a", sizeBytes: 1 },
      { modifiedMs: 2, name: "b", path: "/b", sizeBytes: 1 },
    ];
    sortMoviesNewestFirst(entries);

    expect(entries[0]?.name).toBe("a");
  });
});

describe("parseFfprobeDurationMs", () => {
  test("reads format.duration seconds into rounded ms", () => {
    const stdout = JSON.stringify({ format: { duration: "3612.480000" } });

    expect(parseFfprobeDurationMs(stdout)).toBe(3612480);
  });

  test("absent (not a throw) on missing, zero, or unparseable output", () => {
    expect(parseFfprobeDurationMs("")).toBeUndefined();
    expect(parseFfprobeDurationMs("not json")).toBeUndefined();
    expect(parseFfprobeDurationMs(JSON.stringify({ format: {} }))).toBeUndefined();
    expect(parseFfprobeDurationMs(JSON.stringify({ format: { duration: "0" } }))).toBeUndefined();
  });
});

describe("takeDefaultsFromFilename", () => {
  test("reads the OBS capture stamp into a recorded instant + a titled default", () => {
    // The operator's real set file (the live-proof anchor).
    const defaults = takeDefaultsFromFilename("2026-07-05 11-29-50.mov", 0);

    expect(defaults.title).toBe("Set — 2026-07-05");
    // 11:29:50 local wall-clock → a real ISO instant on that date.
    expect(defaults.recordedAt.startsWith("2026-07-05")).toBe(true);
    expect(Number.isNaN(Date.parse(defaults.recordedAt))).toBe(false);
  });

  test("also reads an underscore-separated stamp", () => {
    expect(takeDefaultsFromFilename("2026-01-02_03-04-05.mkv", 0).title).toBe("Set — 2026-01-02");
  });

  test("falls back to the file's modified date when the name has no stamp", () => {
    const modifiedMs = Date.UTC(2026, 5, 18, 12, 0, 0);
    const defaults = takeDefaultsFromFilename("rave-master.mov", modifiedMs);

    expect(defaults.title).toBe("Set — 2026-06-18");
    expect(defaults.recordedAt).toBe(new Date(modifiedMs).toISOString());
  });
});
