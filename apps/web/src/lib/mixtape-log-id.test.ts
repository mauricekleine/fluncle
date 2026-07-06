import { describe, expect, it } from "vitest";
import { mixtapeLogId, mixtapeTail } from "./mixtape-log-id";

describe("mixtape Log ID minting", () => {
  it("encodes the 1A..9F tail sequence", () => {
    expect(mixtapeTail(1)).toBe("1A");
    expect(mixtapeTail(6)).toBe("1F");
    expect(mixtapeTail(7)).toBe("2A");
    expect(mixtapeTail(54)).toBe("9F");
    expect(() => mixtapeTail(55)).toThrow("between 1 and 54");
  });

  it("mints the first recorded 2026-06-18 mixtape as 019.F.1A", () => {
    expect(mixtapeLogId("2026-06-18T20:00:00.000Z", 1)).toBe("019.F.1A");
  });
});
