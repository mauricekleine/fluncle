import { describe, expect, it } from "vitest";
import {
  editionLogId,
  editionNumberFromLogId,
  editionTail,
  MAX_EDITION_NUMBER,
} from "./edition-log-id";
import { isEditionLogId, isLogId, isMixtapeLogId } from "./log-id";

describe("edition Log ID minting (the letter)", () => {
  it("encodes the 1A..9Z tail sequence", () => {
    expect(editionTail(1)).toBe("1A");
    expect(editionTail(26)).toBe("1Z");
    expect(editionTail(27)).toBe("2A");
    expect(editionTail(MAX_EDITION_NUMBER)).toBe("9Z");
    expect(() => editionTail(MAX_EDITION_NUMBER + 1)).toThrow("between 1 and 234");
  });

  it("mints a letter sent 2026-06-19 as its sector, the L marker, and its number", () => {
    expect(editionLogId("2026-06-19T13:00:00.000Z", 1)).toBe("020.L.1A");
    expect(editionLogId("2026-06-26T13:00:00.000Z", 2)).toBe("027.L.1B");
  });

  it("has no coordinate for a draft: no number, or no send date", () => {
    expect(editionLogId("2026-06-19T13:00:00.000Z", undefined)).toBe("");
    expect(editionLogId(undefined, 1)).toBe("");
    expect(editionLogId(undefined, undefined)).toBe("");
    // Past the cap the mark can't be written; better no coordinate than a wrong one.
    expect(editionLogId("2026-06-19T13:00:00.000Z", MAX_EDITION_NUMBER + 1)).toBe("");
  });

  it("round-trips the number through the mark (the /log resolver's read)", () => {
    for (const number of [1, 2, 26, 27, 100, MAX_EDITION_NUMBER]) {
      const logId = editionLogId("2026-06-19T13:00:00.000Z", number);

      expect(editionNumberFromLogId(logId)).toBe(number);
    }
  });

  it("reads no number out of a coordinate that isn't a letter", () => {
    expect(editionNumberFromLogId("004.7.2I")).toBeUndefined();
    expect(editionNumberFromLogId("019.F.1A")).toBeUndefined();
    expect(editionNumberFromLogId("020.l.1a")).toBeUndefined();
    expect(editionNumberFromLogId("garbage")).toBeUndefined();
  });

  // THE RAIL, at the grammar: a letter's coordinate can never be mistaken for a
  // finding's or a mixtape's — the marker slot alone keeps the three disjoint, so
  // /log can't serve a visitor the wrong kind of object.
  it("mints a coordinate no other kind of object can claim", () => {
    const logId = editionLogId("2026-06-19T13:00:00.000Z", 1);

    expect(isEditionLogId(logId)).toBe(true);
    expect(isLogId(logId)).toBe(false);
    expect(isMixtapeLogId(logId)).toBe(false);
  });
});
