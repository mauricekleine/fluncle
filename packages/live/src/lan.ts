// WHERE THE ROOM REACHES US — the rig's LAN address.
//
// Two surfaces are meant to be opened from someone else's phone: the operator's remote and
// the crew wall's upload page. `localhost` is useless for both, so this resolves the address
// a phone on the same WiFi can actually reach.
//
// It lives at the package root rather than under `bridge/` because BOTH the bridge (which
// prints the crew URL and encodes it into a QR) and `show.ts` (which prints the boot table)
// need it, and `show.ts` deliberately imports no unit source. It is NOT in `contract.ts`:
// that module is bundled into the glass's browser client, where `node:os` does not exist.

import { networkInterfaces } from "node:os";

/**
 * The rig's LAN IPv4 address, or null when there is no non-loopback interface up (a machine
 * off the network — the caller then prints the bare port and says so). Prefers the ordinary
 * private ranges a venue or home router hands out over anything else, and skips link-local
 * `169.254.x.x` autoconfiguration addresses, which no phone will reach.
 */
export function lanAddress(): string | null {
  return pickLanAddress(networkInterfaces());
}

/**
 * The pick, split out from the lookup so it is pure and unit-tested: skip loopback and IPv6,
 * skip link-local `169.254.x.x` (on the wire, but no phone will reach it), then prefer an
 * ordinary private address — the venue or home router's range — over anything else.
 */
export function pickLanAddress(
  interfaces: Record<
    string,
    Array<{ address: string; family: string; internal: boolean }> | undefined
  >,
): string | null {
  const candidates: string[] = [];
  for (const addresses of Object.values(interfaces)) {
    for (const address of addresses ?? []) {
      if (address.family !== "IPv4" || address.internal) {
        continue;
      }
      if (address.address.startsWith("169.254.")) {
        continue;
      }
      candidates.push(address.address);
    }
  }
  const private4 = candidates.find(
    (ip) =>
      ip.startsWith("192.168.") || ip.startsWith("10.") || /^172\.(1[6-9]|2\d|3[01])\./.test(ip),
  );
  return private4 ?? candidates[0] ?? null;
}

/** The `http://<host>:<port>` base a phone on the same WiFi should open, LAN address resolved. */
export function lanBase(port: number): string {
  const host = lanAddress();
  return `http://${host ?? "localhost"}:${port}`;
}
