import { describe, expect, test } from "bun:test";

import { sseComment, sseEvent } from "./sse";

describe("sse framing", () => {
  test("an event frames as event + one JSON data line + a blank line", () => {
    const frame = sseEvent("line", { seq: 3, stream: "stdout", text: "hello" });

    expect(frame).toBe('event: line\ndata: {"seq":3,"stream":"stdout","text":"hello"}\n\n');
  });

  test("data with newlines stays one line (JSON escapes them)", () => {
    const frame = sseEvent("line", { text: "a\nb" });

    // A raw newline inside `data:` would tear the SSE frame; JSON.stringify
    // escapes it, so the frame stays exactly two content lines + the blank
    // terminator (split: event, data, "", "").
    expect(frame.split("\n")).toHaveLength(4);
    expect(frame).toContain(String.raw`a\nb`);
  });

  test("a comment frames as a colon line", () => {
    expect(sseComment("hold")).toBe(": hold\n\n");
  });
});
