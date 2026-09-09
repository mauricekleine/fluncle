// The LAN address pick. Two surfaces are opened from someone else's phone — the operator's
// remote and the crew wall's upload page — and both are useless if this returns the wrong
// interface, so the choice is pinned here against the shapes a real machine reports.

import { describe, expect, test } from "bun:test";

import { lanBase, pickLanAddress } from "./lan";

type Iface = { address: string; family: string; internal: boolean };

const v4 = (address: string, internal = false): Iface => ({ address, family: "IPv4", internal });
const v6 = (address: string): Iface => ({ address, family: "IPv6", internal: false });

describe("pickLanAddress", () => {
  test("takes the private address a venue or home router hands out", () => {
    expect(pickLanAddress({ en0: [v4("192.168.1.42")] })).toBe("192.168.1.42");
    expect(pickLanAddress({ en0: [v4("10.0.0.7")] })).toBe("10.0.0.7");
    expect(pickLanAddress({ en0: [v4("172.16.31.200")] })).toBe("172.16.31.200");
  });

  test("skips loopback and IPv6 — a phone reaches neither", () => {
    expect(
      pickLanAddress({ en0: [v6("fe80::1"), v4("192.168.1.42")], lo0: [v4("127.0.0.1", true)] }),
    ).toBe("192.168.1.42");
  });

  test("skips link-local autoconfiguration, which is on the wire but not routable", () => {
    expect(pickLanAddress({ en0: [v4("169.254.10.4"), v4("192.168.1.42")] })).toBe("192.168.1.42");
  });

  test("prefers the private range over a public address on another interface", () => {
    expect(pickLanAddress({ en0: [v4("81.204.7.11")], en1: [v4("192.168.1.42")] })).toBe(
      "192.168.1.42",
    );
  });

  test("172.15 and 172.32 are NOT private — only 172.16 through 172.31 are", () => {
    expect(pickLanAddress({ en0: [v4("172.15.0.1")], en1: [v4("10.1.2.3")] })).toBe("10.1.2.3");
    expect(pickLanAddress({ en0: [v4("172.32.0.1")], en1: [v4("10.1.2.3")] })).toBe("10.1.2.3");
  });

  test("with nothing private, any routable address beats nothing at all", () => {
    expect(pickLanAddress({ en0: [v4("81.204.7.11")] })).toBe("81.204.7.11");
  });

  test("a machine off the network reports null rather than a wrong guess", () => {
    expect(pickLanAddress({})).toBeNull();
    expect(pickLanAddress({ en0: undefined, lo0: [v4("127.0.0.1", true)] })).toBeNull();
    expect(pickLanAddress({ en0: [v4("169.254.10.4")] })).toBeNull();
  });
});

describe("lanBase", () => {
  test("builds an http base on the given port", () => {
    expect(lanBase(4180)).toMatch(/^http:\/\/[\d.]+:4180$|^http:\/\/localhost:4180$/);
  });
});
