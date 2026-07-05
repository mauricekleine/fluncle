import { describe, expect, test } from "bun:test";

import { parseMachine } from "./machine";

// AGENTS.md "Which machine am I on?": key loosely off the chip generation — the
// brand string reads like "Apple M5 Pro" / "Apple M2".
describe("parseMachine", () => {
  test("the streaming machine reads m5", () => {
    expect(parseMachine("Apple M5 Pro")).toBe("m5");
    expect(parseMachine("Apple M5 Max")).toBe("m5");
    expect(parseMachine("Apple M5")).toBe("m5");
  });

  test("the mixing machine reads m2", () => {
    expect(parseMachine("Apple M2")).toBe("m2");
    expect(parseMachine("Apple M2 Ultra")).toBe("m2");
  });

  test("anything else reads unknown", () => {
    expect(parseMachine("Intel(R) Core(TM) i7-9750H CPU @ 2.60GHz")).toBe("unknown");
    expect(parseMachine("Apple M1 Pro")).toBe("unknown");
    expect(parseMachine("")).toBe("unknown");
  });
});
