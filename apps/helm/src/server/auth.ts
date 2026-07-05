// The helm's gatekeeping — the key, the loopback test, and the Host/Origin
// allowlist. The daemon is localhost-first: a request arriving over the loopback
// (verified by REMOTE ADDRESS, never by headers) needs no key. A non-loopback
// request — only possible when FLUNCLE_HELM_LAN=1 binds the LAN — must present
// the helm key (`Authorization: Bearer <key>`, or `?key=` because EventSource
// cannot set headers) or it gets a 401. On top of that, EVERY request's Host —
// and Origin, when a browser sends one — must sit on the daemon's own allowlist,
// which kills DNS-rebinding and cross-origin POSTs from pages the operator has
// open. The decisions are pure; only the key loading touches the disk.

import { timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Where the minted key persists (0600) when FLUNCLE_HELM_KEY is not set. */
export const HELM_KEY_FILE = join(homedir(), ".config/fluncle/helm.key");

export type HelmKey = {
  key: string;
  source: "env" | "file" | "minted";
};

/**
 * The helm key: FLUNCLE_HELM_KEY wins; otherwise the persisted key file; otherwise
 * mint one once and persist it 0600 so every boot presents the same key.
 */
export function loadHelmKey(
  env: Record<string, string | undefined> = process.env,
  file: string = HELM_KEY_FILE,
): HelmKey {
  const fromEnv = env.FLUNCLE_HELM_KEY?.trim();

  if (fromEnv) {
    return { key: fromEnv, source: "env" };
  }

  try {
    const fromFile = readFileSync(file, "utf8").trim();

    if (fromFile) {
      return { key: fromFile, source: "file" };
    }
  } catch {
    // No key on disk yet — mint below.
  }

  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const key = Buffer.from(bytes).toString("hex");

  mkdirSync(dirname(file), { mode: 0o700, recursive: true });
  writeFileSync(file, `${key}\n`, { mode: 0o600 });
  // writeFileSync's mode only applies on creation — pin it either way.
  chmodSync(file, 0o600);

  return { key, source: "minted" };
}

/** Is this REMOTE address the loopback? (The locality test — addresses, not headers.) */
export function isLoopbackAddress(address: string): boolean {
  return address === "::1" || address.startsWith("127.") || address.startsWith("::ffff:127.");
}

/** The daemon's non-internal IPv4 addresses — what a phone on the LAN dials. */
export function lanAddresses(): string[] {
  const found: string[] = [];

  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal) {
        found.push(address.address);
      }
    }
  }

  return found;
}

/**
 * The `host:port` values a request may name. Loopback names on both the daemon
 * port and the Vite dev port (the dev proxy forwards the browser's own Host and
 * Origin), plus — LAN mode only — the machine's LAN addresses on the daemon port.
 */
export function buildHostAllowlist(opts: {
  devPort: number;
  lanIps: readonly string[];
  port: number;
}): Set<string> {
  const allowed = new Set<string>();

  for (const port of [opts.port, opts.devPort]) {
    allowed.add(`127.0.0.1:${port}`);
    allowed.add(`localhost:${port}`);
    allowed.add(`[::1]:${port}`);
  }

  for (const ip of opts.lanIps) {
    allowed.add(`${ip}:${opts.port}`);
  }

  return allowed;
}

/** Host header check — exact `host:port` membership, case-insensitive. */
export function hostAllowed(host: string | null, allowlist: ReadonlySet<string>): boolean {
  return host !== null && allowlist.has(host.trim().toLowerCase());
}

/**
 * Origin header check. Absent means a non-browser client (curl, EventSource
 * polyfills) — the key and the Host check still stand, so absent passes. Present,
 * it must parse and its `host:port` must sit on the same allowlist.
 */
export function originAllowed(origin: string | null, allowlist: ReadonlySet<string>): boolean {
  if (origin === null) {
    return true;
  }

  let parsed: URL;

  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }

  return allowlist.has(parsed.host.toLowerCase());
}

/** The key a request presents: `Authorization: Bearer <key>` or `?key=`. */
export function presentedKey(authorization: string | null, url: URL): string | null {
  if (authorization !== null) {
    const match = /^Bearer\s+(\S+)$/i.exec(authorization.trim());

    if (match?.[1] !== undefined) {
      return match[1];
    }
  }

  return url.searchParams.get("key");
}

/**
 * The auth decision: loopback needs no key; anything else must present the helm
 * key. Constant-time comparison — a LAN peer never learns the key a byte at a time.
 */
export function authorizeRequest(opts: {
  isLocal: boolean;
  key: string;
  presented: string | null;
}): boolean {
  if (opts.isLocal) {
    return true;
  }

  if (opts.presented === null) {
    return false;
  }

  const expected = Buffer.from(opts.key);
  const given = Buffer.from(opts.presented);

  return expected.length === given.length && timingSafeEqual(expected, given);
}
