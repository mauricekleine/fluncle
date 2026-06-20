import { describe, expect, test } from "bun:test";

import { digCommand, findCoordinates, sshCommand, webUrl } from "./coordinate";

describe("findCoordinates", () => {
  test("pulls a single coordinate, scheme and all", () => {
    expect(findCoordinates("Listen: fluncle://007.0.0Z and tell me")).toEqual([
      { id: "007.0.0Z", raw: "fluncle://007.0.0Z" },
    ]);
  });

  test("pulls several from one run", () => {
    const found = findCoordinates("fluncle://018.8.9J fluncle://005.3.6C");

    expect(found.map((f) => f.id)).toEqual(["018.8.9J", "005.3.6C"]);
  });

  test("matches a mixtape coordinate (F in the middle slot)", () => {
    expect(findCoordinates("the mix at fluncle://019.F.1A")[0]?.id).toBe("019.F.1A");
  });

  test("preserves display casing", () => {
    expect(findCoordinates("fluncle://241.7.3a")[0]?.raw).toBe("fluncle://241.7.3a");
  });

  test("stops at sentence punctuation", () => {
    expect(findCoordinates("found it: fluncle://007.0.0Z.")[0]?.id).toBe("007.0.0Z");
  });

  test("does not run the last segment into a trailing word char", () => {
    // No boundary after the Z, so the whole thing reads as one long segment and
    // never matches a clean coordinate.
    expect(findCoordinates("fluncle://007.0.0Zzz")[0]?.id).toBe("007.0.0Zzz");
  });

  test("rejects a malformed coordinate (too few leading digits)", () => {
    expect(findCoordinates("fluncle://7.0.0Z")).toEqual([]);
  });

  test("dedupes repeats", () => {
    const found = findCoordinates("fluncle://007.0.0Z again fluncle://007.0.0Z");

    expect(found).toHaveLength(1);
  });

  test("finds nothing in plain text", () => {
    expect(findCoordinates("just a normal sentence")).toEqual([]);
  });
});

describe("derivations", () => {
  test("web URL points at the log page", () => {
    expect(webUrl("007.0.0Z")).toBe("https://www.fluncle.com/log/007.0.0Z");
  });

  test("dig command lowercases the DNS label only", () => {
    expect(digCommand("007.0.0Z")).toBe("dig 007.0.0z.dig.fluncle.com TXT +short");
  });

  test("ssh command keeps the coordinate as written", () => {
    expect(sshCommand("007.0.0Z")).toBe("ssh rave.fluncle.com 007.0.0Z");
  });
});
