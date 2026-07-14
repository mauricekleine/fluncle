import { describe, expect, it } from "vitest";
import { buildSaveSetBody, canSaveSet } from "./mix-save";

// The Save-set dialog's two pure pieces. `canSaveSet` is the disabled gate the ruling
// mandates (Save blocked on an empty chain OR a blank name — never a server error after the
// fact); `buildSaveSetBody` assembles the `{ name, set, taste }` the POST/PATCH both send.

describe("canSaveSet — the dialog's disabled gate", () => {
  it("allows a save when there is a chain and a non-blank name", () => {
    expect(canSaveSet({ chainLength: 3, name: "Friday warmup" })).toBe(true);
  });

  it("blocks an actually-empty chain (the empty_set failure path, killed by construction)", () => {
    expect(canSaveSet({ chainLength: 0, name: "Friday warmup" })).toBe(false);
  });

  it("blocks a blank or whitespace-only name", () => {
    expect(canSaveSet({ chainLength: 3, name: "" })).toBe(false);
    expect(canSaveSet({ chainLength: 3, name: "   " })).toBe(false);
  });
});

describe("buildSaveSetBody — the request payload", () => {
  it("carries the trimmed name plus the serialized set and taste verbatim", () => {
    expect(
      buildSaveSetBody("  Friday warmup  ", "004.7.2I,4iV5W9uYEdYUVa79Axb7Rh", "netsky"),
    ).toEqual({
      name: "Friday warmup",
      set: "004.7.2I,4iV5W9uYEdYUVa79Axb7Rh",
      taste: "netsky",
    });
  });

  it("lets an empty taste ride (web + mobile parity — the server drops it)", () => {
    expect(buildSaveSetBody("Late roller", "004.7.2I", "").taste).toBe("");
  });
});
