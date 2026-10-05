import { describe, expect, it } from "vitest";
import { bufferPendingKey, type PendingKey } from "./search-keystrokes";

function press(key: string, modifiers: Partial<PendingKey> = {}): PendingKey {
  return { altKey: false, ctrlKey: false, isComposing: false, key, metaKey: false, ...modifiers };
}

function typeAll(keys: string[]): string {
  return keys.reduce((buffer, key) => {
    const action = bufferPendingKey(buffer, press(key));

    return action.kind === "buffer" ? action.buffer : buffer;
  }, "");
}

describe("bufferPendingKey", () => {
  it("keeps the characters typed before the search field exists, spaces included", () => {
    expect(typeAll(["d", "a", "r", "k", " ", "r", "o", "l", "l", "e", "r", "s"])).toBe(
      "dark rollers",
    );
  });

  it("applies backspace to the buffered text, one character at a time", () => {
    expect(typeAll(["n", "o", "v", "x", "Backspace", "a"])).toBe("nova");
    expect(typeAll(["Backspace"])).toBe("");
    expect(typeAll(["ü", "🔊", "Backspace"])).toBe("ü");
  });

  it("swallows Enter so it cannot press the control focus was left on", () => {
    expect(bufferPendingKey("abc", press("Enter"))).toEqual({ kind: "swallow" });
  });

  it("closes on Escape", () => {
    expect(bufferPendingKey("abc", press("Escape"))).toEqual({ kind: "close" });
  });

  it("lets shortcuts, navigation keys and IME composition through untouched", () => {
    expect(bufferPendingKey("", press("k", { metaKey: true }))).toEqual({ kind: "pass" });
    expect(bufferPendingKey("", press("k", { ctrlKey: true }))).toEqual({ kind: "pass" });
    expect(bufferPendingKey("", press("e", { altKey: true }))).toEqual({ kind: "pass" });
    expect(bufferPendingKey("", press("Tab"))).toEqual({ kind: "pass" });
    expect(bufferPendingKey("", press("Shift"))).toEqual({ kind: "pass" });
    expect(bufferPendingKey("", press("a", { isComposing: true }))).toEqual({ kind: "pass" });
  });
});
