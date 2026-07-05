import { describe, expect, test } from "bun:test";

import { createLineSplitter } from "./lines";

describe("createLineSplitter", () => {
  test("a chunk cut mid-line emits the line exactly once, whole", () => {
    const splitter = createLineSplitter();

    expect(splitter.push("hel")).toEqual([]);
    expect(splitter.push("lo\nwor")).toEqual(["hello"]);
    expect(splitter.push("ld\n")).toEqual(["world"]);
    expect(splitter.flush()).toBeUndefined();
  });

  test("one chunk carrying several lines emits them all in order", () => {
    const splitter = createLineSplitter();

    expect(splitter.push("a\nb\nc\n")).toEqual(["a", "b", "c"]);
  });

  test("an unterminated tail comes out on flush", () => {
    const splitter = createLineSplitter();

    expect(splitter.push("no newline")).toEqual([]);
    expect(splitter.flush()).toBe("no newline");
    expect(splitter.flush()).toBeUndefined();
  });

  test("CRLF output loses its carriage returns", () => {
    const splitter = createLineSplitter();

    expect(splitter.push("one\r\ntwo\r\n")).toEqual(["one", "two"]);
  });

  test("empty lines survive (a blank line is output too)", () => {
    const splitter = createLineSplitter();

    expect(splitter.push("a\n\nb\n")).toEqual(["a", "", "b"]);
  });
});
