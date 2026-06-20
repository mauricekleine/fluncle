import { describe, expect, test } from "bun:test";

import { digCommand, findCoordinates, safeHref, sshCommand, webUrl } from "./coordinate";

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

  test("matches a 4-digit sector (the post-2029 widening)", () => {
    expect(findCoordinates("fluncle://1024.7.3I")[0]?.id).toBe("1024.7.3I");
  });

  test("matches a 4-digit mixtape sector", () => {
    expect(findCoordinates("fluncle://1024.F.2C")[0]?.id).toBe("1024.F.2C");
  });

  test("preserves display casing", () => {
    expect(findCoordinates("fluncle://241.7.3a")[0]?.raw).toBe("fluncle://241.7.3a");
  });

  test("stops at sentence punctuation", () => {
    expect(findCoordinates("found it: fluncle://007.0.0Z.")[0]?.id).toBe("007.0.0Z");
  });

  test("rejects a run-on mark (the mark is exactly digit + one letter)", () => {
    // The canon mark is `\d[A-Z]` — two characters. The old `[0-9A-Z]+` greedily
    // swallowed the trailing letters; the tightened pattern must match nothing here
    // (no clean coordinate ⇒ no dead link, no wasted 404).
    expect(findCoordinates("fluncle://007.0.0Zzz")).toEqual([]);
  });

  test("rejects a 5-digit sector (over the canon width)", () => {
    expect(findCoordinates("fluncle://10240.7.3I")).toEqual([]);
  });

  test("rejects a mixtape mark outside A–F", () => {
    expect(findCoordinates("fluncle://019.F.1Z")).toEqual([]);
  });

  test("rejects a two-digit orbit (the orbit is one digit)", () => {
    expect(findCoordinates("fluncle://007.12.3I")).toEqual([]);
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

  test("web URL uppercases the Log ID (the case-sensitive lookup)", () => {
    expect(webUrl("241.7.3a")).toBe("https://www.fluncle.com/log/241.7.3A");
  });

  test("dig command lowercases the DNS label only", () => {
    expect(digCommand("007.0.0Z")).toBe("dig 007.0.0z.dig.fluncle.com TXT +short");
  });

  test("ssh command keeps the coordinate as written", () => {
    expect(sshCommand("007.0.0Z")).toBe("ssh rave.fluncle.com 007.0.0Z");
  });
});

describe("safeHref", () => {
  test("passes through a valid https href", () => {
    expect(safeHref("https://open.spotify.com/track/abc", "007.0.0Z")).toBe(
      "https://open.spotify.com/track/abc",
    );
  });

  test("falls back to the log page for a javascript: scheme", () => {
    expect(safeHref("javascript:alert(1)", "007.0.0Z")).toBe(
      "https://www.fluncle.com/log/007.0.0Z",
    );
  });

  test("falls back for http: (downgrade) and other non-https schemes", () => {
    expect(safeHref("http://example.com", "007.0.0Z")).toBe("https://www.fluncle.com/log/007.0.0Z");
  });

  test("falls back for a relative path (not an absolute URL)", () => {
    expect(safeHref("/log/evil", "007.0.0Z")).toBe("https://www.fluncle.com/log/007.0.0Z");
  });

  test("falls back when the href is undefined", () => {
    expect(safeHref(undefined, "007.0.0Z")).toBe("https://www.fluncle.com/log/007.0.0Z");
  });
});
