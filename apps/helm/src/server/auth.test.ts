import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  authorizeRequest,
  buildHostAllowlist,
  hostAllowed,
  isLoopbackAddress,
  loadHelmKey,
  originAllowed,
  presentedKey,
} from "./auth";

describe("the helm key", () => {
  test("FLUNCLE_HELM_KEY wins over everything", () => {
    const loaded = loadHelmKey({ FLUNCLE_HELM_KEY: "  from-env  " }, "/nonexistent/helm.key");

    expect(loaded).toEqual({ key: "from-env", source: "env" });
  });

  test("mints once, persists 0600, and reads the same key back", () => {
    const dir = mkdtempSync(join(tmpdir(), "helm-key-"));
    const file = join(dir, "nested", "helm.key");

    const minted = loadHelmKey({}, file);

    expect(minted.source).toBe("minted");
    expect(minted.key).toMatch(/^[0-9a-f]{64}$/);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf8").trim()).toBe(minted.key);

    const reread = loadHelmKey({}, file);

    expect(reread).toEqual({ key: minted.key, source: "file" });
  });
});

describe("the loopback test (addresses, never headers)", () => {
  test("loopback forms pass", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("127.0.0.53")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
  });

  test("LAN and public addresses do not", () => {
    expect(isLoopbackAddress("192.168.1.20")).toBe(false);
    expect(isLoopbackAddress("10.0.0.5")).toBe(false);
    expect(isLoopbackAddress("fe80::1")).toBe(false);
    expect(isLoopbackAddress("1.2.7.1")).toBe(false);
  });
});

describe("the Host/Origin allowlist", () => {
  const allowlist = buildHostAllowlist({ devPort: 4191, lanIps: ["192.168.1.20"], port: 4190 });

  test("loopback hosts on the daemon and dev ports pass", () => {
    expect(hostAllowed("127.0.0.1:4190", allowlist)).toBe(true);
    expect(hostAllowed("localhost:4190", allowlist)).toBe(true);
    expect(hostAllowed("LOCALHOST:4191", allowlist)).toBe(true);
    expect(hostAllowed("[::1]:4190", allowlist)).toBe(true);
  });

  test("the LAN address passes only on the daemon port", () => {
    expect(hostAllowed("192.168.1.20:4190", allowlist)).toBe(true);
    expect(hostAllowed("192.168.1.20:4191", allowlist)).toBe(false);
  });

  test("a rebinding Host is refused", () => {
    expect(hostAllowed("evil.example:4190", allowlist)).toBe(false);
    expect(hostAllowed("evil.example", allowlist)).toBe(false);
    expect(hostAllowed(null, allowlist)).toBe(false);
  });

  test("no LAN mode means no LAN hosts", () => {
    const localOnly = buildHostAllowlist({ devPort: 4191, lanIps: [], port: 4190 });

    expect(hostAllowed("192.168.1.20:4190", localOnly)).toBe(false);
  });

  test("Origin: absent passes, matching passes, foreign is refused", () => {
    expect(originAllowed(null, allowlist)).toBe(true);
    expect(originAllowed("http://127.0.0.1:4190", allowlist)).toBe(true);
    expect(originAllowed("http://localhost:4191", allowlist)).toBe(true);
    expect(originAllowed("http://192.168.1.20:4190", allowlist)).toBe(true);
    expect(originAllowed("https://evil.example", allowlist)).toBe(false);
    expect(originAllowed("null", allowlist)).toBe(false);
    expect(originAllowed("not a url", allowlist)).toBe(false);
  });
});

describe("the auth decision", () => {
  const key = "0".repeat(64);

  test("loopback needs no key", () => {
    expect(authorizeRequest({ isLocal: true, key, presented: null })).toBe(true);
  });

  test("a LAN peer must present the exact key", () => {
    expect(authorizeRequest({ isLocal: false, key, presented: key })).toBe(true);
    expect(authorizeRequest({ isLocal: false, key, presented: null })).toBe(false);
    expect(authorizeRequest({ isLocal: false, key, presented: "" })).toBe(false);
    expect(authorizeRequest({ isLocal: false, key, presented: `${key}x` })).toBe(false);
    expect(authorizeRequest({ isLocal: false, key, presented: "1".repeat(64) })).toBe(false);
  });

  test("the key arrives as Bearer or ?key= (EventSource cannot set headers)", () => {
    const url = new URL("http://127.0.0.1:4190/api/runs");

    expect(presentedKey("Bearer abc", url)).toBe("abc");
    expect(presentedKey("bearer abc", url)).toBe("abc");
    expect(presentedKey("Basic abc", url)).toBeNull();
    expect(presentedKey(null, url)).toBeNull();
    expect(presentedKey(null, new URL("http://127.0.0.1:4190/api/runs?key=xyz"))).toBe("xyz");
    expect(presentedKey("Bearer abc", new URL("http://x/api?key=xyz"))).toBe("abc");
  });
});
