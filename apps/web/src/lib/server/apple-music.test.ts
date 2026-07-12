import { beforeEach, describe, expect, it, vi } from "vitest";

// The Apple Music resolve side: the ES256 developer-token minting (the load-bearing,
// easy-to-get-wrong bit — verified by a real WebCrypto round-trip), the response
// parsing, and the no-op-until-configured discipline. The env is mocked so a test can
// flip the leg between configured and unconfigured; `logEvent` is stubbed to keep the
// error path side-effect free.

const readOptionalEnv = vi.fn(async (_key: string): Promise<string | undefined> => undefined);

vi.mock("./env", () => ({ readOptionalEnv: (key: string) => readOptionalEnv(key) }));
vi.mock("./log", () => ({ logEvent: vi.fn() }));

// base64url → bytes, for verifying the signature the module produced.
function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const b64 = value
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes;
}

function decodeJwtSegment(segment: string): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(base64UrlToBytes(segment)));
}

// A throwaway EC P-256 key in PKCS#8 PEM — the shape a real MusicKit `.p8` carries.
async function generatePkcs8Pem(): Promise<{ pem: string; publicKey: CryptoKey }> {
  const keyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", keyPair.privateKey));
  let binary = "";

  for (const byte of der) {
    binary += String.fromCharCode(byte);
  }

  const base64 = btoa(binary).replace(/(.{64})/g, "$1\n");
  const pem = `-----BEGIN PRIVATE KEY-----\n${base64}\n-----END PRIVATE KEY-----\n`;

  return { pem, publicKey: keyPair.publicKey };
}

beforeEach(() => {
  vi.clearAllMocks();
  readOptionalEnv.mockResolvedValue(undefined);
});

describe("extractAppleMusicUrl", () => {
  it("pulls the first datum's attributes.url", async () => {
    const { extractAppleMusicUrl } = await import("./apple-music");

    expect(
      extractAppleMusicUrl({
        data: [{ attributes: { url: "https://music.apple.com/us/song/x/1" } }],
      }),
    ).toBe("https://music.apple.com/us/song/x/1");
  });

  it("returns null for an empty result set (the ISRC matched nothing)", async () => {
    const { extractAppleMusicUrl } = await import("./apple-music");

    expect(extractAppleMusicUrl({ data: [] })).toBeNull();
    expect(extractAppleMusicUrl({})).toBeNull();
    expect(extractAppleMusicUrl(null)).toBeNull();
    expect(extractAppleMusicUrl({ data: [{ attributes: {} }] })).toBeNull();
  });
});

describe("buildAppleMusicJwt", () => {
  it("mints an ES256 JWT whose header/payload are correct and whose signature verifies", async () => {
    const { buildAppleMusicJwt } = await import("./apple-music");
    const { pem, publicKey } = await generatePkcs8Pem();

    const jwt = await buildAppleMusicJwt(
      { keyId: "KEY123", privateKeyPem: pem, teamId: "TEAM456" },
      1_000_000,
    );

    const [headerB64, payloadB64, signatureB64] = jwt.split(".");
    expect(headerB64 && payloadB64 && signatureB64).toBeTruthy();

    expect(decodeJwtSegment(headerB64 ?? "")).toEqual({ alg: "ES256", kid: "KEY123", typ: "JWT" });

    const payload = decodeJwtSegment(payloadB64 ?? "");
    expect(payload.iss).toBe("TEAM456");
    expect(payload.iat).toBe(1_000_000);
    // ~150 days, comfortably under Apple's 6-month cap.
    expect(payload.exp).toBe(1_000_000 + 150 * 24 * 60 * 60);

    const verified = await crypto.subtle.verify(
      { hash: "SHA-256", name: "ECDSA" },
      publicKey,
      base64UrlToBytes(signatureB64 ?? ""),
      new Uint8Array(new TextEncoder().encode(`${headerB64}.${payloadB64}`)),
    );
    expect(verified, "the ES256 signature verifies against the matching public key").toBe(true);
  });

  it("tolerates a private key stored with escaped newlines (the single-line env form)", async () => {
    const { buildAppleMusicJwt } = await import("./apple-music");
    const { pem, publicKey } = await generatePkcs8Pem();
    const escaped = pem.replace(/\n/g, "\\n");

    const jwt = await buildAppleMusicJwt({ keyId: "K", privateKeyPem: escaped, teamId: "T" });
    const [headerB64, payloadB64, signatureB64] = jwt.split(".");

    const verified = await crypto.subtle.verify(
      { hash: "SHA-256", name: "ECDSA" },
      publicKey,
      base64UrlToBytes(signatureB64 ?? ""),
      new Uint8Array(new TextEncoder().encode(`${headerB64}.${payloadB64}`)),
    );
    expect(verified).toBe(true);
  });
});

describe("appleMusicLookupByIsrc — no-op until configured", () => {
  it("returns { configured: false } when the MusicKit secrets are unset (no fetch)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { appleMusicLookupByIsrc } = await import("./apple-music");

    const result = await appleMusicLookupByIsrc("GBABC1234567");

    expect(result).toEqual({ configured: false });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("short-circuits an empty ISRC as a clean no-match before reading any secret", async () => {
    const { appleMusicLookupByIsrc } = await import("./apple-music");

    expect(await appleMusicLookupByIsrc("  ")).toEqual({ configured: true, ok: true, url: null });
    expect(readOptionalEnv).not.toHaveBeenCalled();
  });
});
