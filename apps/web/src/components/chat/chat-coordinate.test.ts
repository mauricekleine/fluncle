import { describe, expect, it } from "vitest";
import { splitOnCoordinates } from "./chat-coordinate";

// The pure half of the chat coordinate linkifier: prose in, segments out. The accept/reject
// grammar itself lives in @fluncle/contracts/log-id (isLogId / isMixtapeLogId) — these tests
// pin the SCANNING: what gets found inside running text, what the fences reject, and that the
// plain runs survive byte-exact so `whitespace-pre-wrap` keeps working.

describe("splitOnCoordinates", () => {
  it("finds a coordinate inside parens, keeping the surrounding prose byte-exact", () => {
    expect(splitOnCoordinates("Let's Leave Tomorrow (012.4.4D), from 2010.")).toEqual([
      { kind: "text", text: "Let's Leave Tomorrow (" },
      { kind: "coordinate", logId: "012.4.4D", mixtape: false },
      { kind: "text", text: "), from 2010." },
    ]);
  });

  it("finds several coordinates in one paragraph, in order", () => {
    const segments = splitOnCoordinates("I found 011.1.6E and then 004.4.3L the same week.");
    const coordinates = segments.filter((segment) => segment.kind === "coordinate");

    expect(coordinates).toEqual([
      { kind: "coordinate", logId: "011.1.6E", mixtape: false },
      { kind: "coordinate", logId: "004.4.3L", mixtape: false },
    ]);
  });

  it("marks a mixtape coordinate (the F galaxy) as such", () => {
    expect(splitOnCoordinates("The whole night is 023.F.1A.")).toEqual([
      { kind: "text", text: "The whole night is " },
      { kind: "coordinate", logId: "023.F.1A", mixtape: true },
      { kind: "text", text: "." },
    ]);
  });

  it("accepts a 4-digit sector (the post-2029 widening)", () => {
    const segments = splitOnCoordinates("Deep out at 1042.7.3A now.");

    expect(segments).toContainEqual({ kind: "coordinate", logId: "1042.7.3A", mixtape: false });
  });

  it("rejects near-misses: run-on marks, over-wide sectors, out-of-range mixtape marks", () => {
    for (const text of [
      "not 012.4.4DX a coordinate",
      "not 10042.7.3A either",
      "nor 023.F.1G (mixtape marks stop at F)",
      "nor 12.4.4D (too few digits)",
    ]) {
      expect(splitOnCoordinates(text)).toEqual([{ kind: "text", text }]);
    }
  });

  it("does not bite into a longer dotted number", () => {
    expect(splitOnCoordinates("version 1.012.4.4D of nothing")).toEqual([
      { kind: "text", text: "version 1.012.4.4D of nothing" },
    ]);
  });

  it("returns one plain segment for prose with no coordinate", () => {
    expect(splitOnCoordinates("Netsky is Boris Daenen, a Belgian producer.")).toEqual([
      { kind: "text", text: "Netsky is Boris Daenen, a Belgian producer." },
    ]);
  });

  it("handles a coordinate at the very start and very end", () => {
    expect(splitOnCoordinates("012.4.4D opens it")).toEqual([
      { kind: "coordinate", logId: "012.4.4D", mixtape: false },
      { kind: "text", text: " opens it" },
    ]);
    expect(splitOnCoordinates("it closes on 012.4.4D")).toEqual([
      { kind: "text", text: "it closes on " },
      { kind: "coordinate", logId: "012.4.4D", mixtape: false },
    ]);
  });
});
