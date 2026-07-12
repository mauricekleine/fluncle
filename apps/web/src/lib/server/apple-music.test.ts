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

// ── The catalog oracle (RFC musickit-second-authority, U0) ─────────────────────

// A `{w}x{h}bb.jpg`-templated artwork block, the shape Apple returns on a song and
// on an album alike (native 3000², palette fields).
function artworkFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    bgColor: "202020",
    height: 3000,
    textColor1: "aea6f6",
    textColor2: "b68ef6",
    textColor3: "918bcb",
    textColor4: "9878cb",
    url: "https://is1-ssl.mzstatic.com/image/thumb/Music/v4/ab/cd/ef/x.png/{w}x{h}bb.jpg",
    width: 3000,
    ...overrides,
  };
}

// A song datum with an ISRC, a share URL, artwork, a preview, and album refs.
function songFixture(options: {
  albumIds: string[];
  id: string;
  isrc: string;
  url?: string;
}): Record<string, unknown> {
  return {
    attributes: {
      artwork: artworkFixture(),
      isrc: options.isrc,
      previews: [{ url: `https://audio-ssl.itunes.apple.com/mzaf_${options.id}.m4a` }],
      url: options.url ?? `https://music.apple.com/us/album/x/${options.id}?i=${options.id}`,
    },
    href: `/v1/catalog/us/songs/${options.id}`,
    id: options.id,
    relationships: {
      albums: {
        data: options.albumIds.map((albumId) => ({
          href: `/v1/catalog/us/albums/${albumId}`,
          id: albumId,
          type: "albums",
        })),
      },
    },
    type: "songs",
  };
}

// An album resource for `included[]`.
function albumFixture(options: {
  id: string;
  isCompilation?: boolean;
  isSingle?: boolean;
  recordLabel?: string;
  releaseDate?: string;
  standardNote?: string;
  upc?: string;
}): Record<string, unknown> {
  return {
    attributes: {
      artwork: artworkFixture(),
      editorialNotes: options.standardNote ? { standard: options.standardNote } : undefined,
      isCompilation: options.isCompilation ?? false,
      isSingle: options.isSingle ?? false,
      name: `Album ${options.id}`,
      recordLabel: options.recordLabel,
      releaseDate: options.releaseDate,
      upc: options.upc,
    },
    href: `/v1/catalog/us/albums/${options.id}`,
    id: options.id,
    type: "albums",
  };
}

describe("appleArtworkUrl", () => {
  it("substitutes {w}x{h}", async () => {
    const { appleArtworkUrl } = await import("./apple-music");
    const art = {
      height: 3000,
      urlTemplate: "https://example.com/{w}x{h}bb.jpg",
      width: 3000,
    };

    expect(appleArtworkUrl(art, 1920, 1920)).toBe("https://example.com/1920x1920bb.jpg");
  });

  it("clamps the request to the artwork's native max (never upscales)", async () => {
    const { appleArtworkUrl } = await import("./apple-music");
    const art = {
      height: 1400,
      urlTemplate: "https://example.com/{w}x{h}bb.jpg",
      width: 1400,
    };

    // Asking for 3000 on a 1400-native source clamps to 1400 — the render-defect fix.
    expect(appleArtworkUrl(art, 3000, 3000)).toBe("https://example.com/1400x1400bb.jpg");
  });
});

describe("pickCanonicalAlbum", () => {
  it("returns undefined for an empty candidate set", async () => {
    const { pickCanonicalAlbum } = await import("./apple-music");

    expect(pickCanonicalAlbum([])).toBeUndefined();
  });

  it("prefers a non-compilation even when the compilation is EARLIER (compilation loses first)", async () => {
    const { pickCanonicalAlbum } = await import("./apple-music");

    const picked = pickCanonicalAlbum([
      { id: "comp", isCompilation: true, recordLabel: "Believe", releaseDate: "2018-01-01" },
      { id: "orig", isCompilation: false, recordLabel: "Hospital", releaseDate: "2019-03-15" },
    ]);

    expect(picked?.id).toBe("orig");
  });

  it("breaks a non-compilation tie by earliest releaseDate", async () => {
    const { pickCanonicalAlbum } = await import("./apple-music");

    const picked = pickCanonicalAlbum([
      { id: "late", isCompilation: false, releaseDate: "2020-06-01" },
      { id: "early", isCompilation: false, releaseDate: "2017-02-02" },
    ]);

    expect(picked?.id).toBe("early");
  });

  it("prefers a non-single over a single at equal date, then a stable id tiebreak", async () => {
    const { pickCanonicalAlbum } = await import("./apple-music");

    expect(
      pickCanonicalAlbum([
        { id: "single", isSingle: true, releaseDate: "2019-01-01" },
        { id: "album", isSingle: false, releaseDate: "2019-01-01" },
      ])?.id,
    ).toBe("album");

    // Fully-tied: deterministic ascending id, regardless of input order.
    expect(
      pickCanonicalAlbum([
        { id: "b222", releaseDate: "2019-01-01" },
        { id: "a111", releaseDate: "2019-01-01" },
      ])?.id,
    ).toBe("a111");
  });
});

describe("buildCatalogBundle", () => {
  it("returns null when the ISRC matched nothing", async () => {
    const { buildCatalogBundle } = await import("./apple-music");

    expect(buildCatalogBundle({ data: [] })).toBeNull();
    expect(buildCatalogBundle({})).toBeNull();
    expect(buildCatalogBundle(null)).toBeNull();
  });

  it("THE REAL SHAPE: albums arrive INLINED in relationships.albums.data with attributes — no included[] at all", async () => {
    // Verified live 2026-07-12: Apple does NOT send a top-level `included[]` (contra
    // generic JSON:API). The full album objects ride inside the relationship array.
    // The first pilot read 0 albums on 43/43 hits against the included[]-only join —
    // this is that bug, pinned.
    const { buildCatalogBundle } = await import("./apple-music");

    const body = {
      data: [
        {
          attributes: {
            artwork: { height: 3000, url: "https://a.mzstatic.com/img/{w}x{h}bb.jpg", width: 3000 },
            isrc: "GBBGL2400001",
            previews: [{ url: "https://audio-ssl.itunes.apple.com/preview.m4a" }],
            url: "https://music.apple.com/us/song/1",
          },
          id: "song1",
          relationships: {
            albums: {
              data: [
                {
                  attributes: {
                    isCompilation: true,
                    recordLabel: "Believe",
                    releaseDate: "2018-01-01",
                  },
                  id: "comp1",
                  type: "albums",
                },
                {
                  attributes: {
                    isCompilation: false,
                    recordLabel: "Hospital Records",
                    releaseDate: "2019-03-15",
                    upc: "originalupc",
                  },
                  id: "orig1",
                  type: "albums",
                },
              ],
            },
          },
          type: "songs",
        },
      ],
    };

    const bundle = buildCatalogBundle(body);

    expect(bundle?.canonicalAlbum?.id).toBe("orig1");
    expect(bundle?.canonicalAlbum?.recordLabel).toBe("Hospital Records");
  });

  it("THE ADVERSARIAL CASE: data[0]'s first album is a distributor compilation, the correct original is deeper in included[]", async () => {
    const { buildCatalogBundle } = await import("./apple-music");

    // The primary song belongs to BOTH a compilation (listed first, EARLIER release,
    // carrying the distributor "Believe") and its original album (deeper in included[],
    // carrying the real imprint "Hospital Records"). The picker must land on the original.
    const body = {
      data: [songFixture({ albumIds: ["comp1", "orig1"], id: "song1", isrc: "GB1234567890" })],
      included: [
        albumFixture({
          id: "comp1",
          isCompilation: true,
          recordLabel: "Believe",
          releaseDate: "2018-01-01",
          upc: "compilationupc",
        }),
        albumFixture({
          id: "orig1",
          isCompilation: false,
          recordLabel: "Hospital Records",
          releaseDate: "2019-03-15",
          standardNote: "The original release.",
          upc: "originalupc",
        }),
      ],
    };

    const bundle = buildCatalogBundle(body);

    expect(bundle?.songId).toBe("song1");
    expect(bundle?.songUrl).toBe("https://music.apple.com/us/album/x/song1?i=song1");
    expect(bundle?.songArtwork?.width).toBe(3000);
    expect(bundle?.preview?.url).toBe("https://audio-ssl.itunes.apple.com/mzaf_song1.m4a");
    // The distributor compilation's label never surfaces; the real imprint does.
    expect(bundle?.canonicalAlbum?.id).toBe("orig1");
    expect(bundle?.canonicalAlbum?.recordLabel).toBe("Hospital Records");
    expect(bundle?.canonicalAlbum?.upc).toBe("originalupc");
    expect(bundle?.canonicalAlbum?.editorialNotesStandard).toBe("The original release.");
  });

  it("HONEST MISS: a compilation-only set yields canonicalAlbum undefined (no distributor laundering)", async () => {
    const { buildCatalogBundle } = await import("./apple-music");

    const body = {
      data: [songFixture({ albumIds: ["comp1"], id: "song2", isrc: "GB0000000000" })],
      included: [albumFixture({ id: "comp1", isCompilation: true, recordLabel: "Believe" })],
    };

    const bundle = buildCatalogBundle(body);

    // The song facts are still returned — only the album provenance is withheld.
    expect(bundle?.songId).toBe("song2");
    expect(bundle?.songArtwork).toBeDefined();
    expect(bundle?.canonicalAlbum).toBeUndefined();
  });

  it("surfaces a clean single-album match with its imprint", async () => {
    const { buildCatalogBundle } = await import("./apple-music");

    const body = {
      data: [songFixture({ albumIds: ["album1"], id: "song3", isrc: "USABC1234567" })],
      included: [
        albumFixture({
          id: "album1",
          isCompilation: false,
          recordLabel: "Mom+Pop",
          releaseDate: "2022-07-22",
          upc: "810090090962",
        }),
      ],
    };

    expect(buildCatalogBundle(body)?.canonicalAlbum?.recordLabel).toBe("Mom+Pop");
  });
});

describe("buildBatchBundles", () => {
  it("maps each requested ISRC to its data[] primary via meta.filters.isrc; a miss is absent", async () => {
    const { buildBatchBundles } = await import("./apple-music");

    const body = {
      data: [
        songFixture({ albumIds: [], id: "s1", isrc: "AAA" }),
        songFixture({ albumIds: [], id: "s2", isrc: "BBB" }),
      ],
      meta: {
        filters: {
          isrc: {
            AAA: [{ id: "s1", type: "songs" }],
            BBB: [{ id: "s2", type: "songs" }],
          },
        },
      },
    };

    const bundles = buildBatchBundles(body, ["AAA", "BBB", "ZZZ"]);

    expect(bundles.get("AAA")?.songId).toBe("s1");
    expect(bundles.get("BBB")?.songId).toBe("s2");
    expect(bundles.get("AAA")?.preview?.url).toBe("https://audio-ssl.itunes.apple.com/mzaf_s1.m4a");
    // The unmatched ISRC is an honest miss, not a wrong entry.
    expect(bundles.has("ZZZ")).toBe(false);
  });

  it("falls back to the song's stamped attributes.isrc when meta is absent", async () => {
    const { buildBatchBundles } = await import("./apple-music");

    const body = { data: [songFixture({ albumIds: [], id: "s9", isrc: "CCC" })] };

    expect(buildBatchBundles(body, ["CCC"]).get("CCC")?.songId).toBe("s9");
  });
});

describe("appleCatalogLookupByIsrc / appleCatalogLookupByIsrcs — wired", () => {
  // Provision the three MusicKit secrets so the configured path runs.
  function configureCredentials(): void {
    readOptionalEnv.mockImplementation(async (key: string) => {
      if (key === "APPLE_MUSIC_TEAM_ID") {
        return "TEAM";
      }
      if (key === "APPLE_MUSIC_KEY_ID") {
        return "KEY";
      }
      if (key === "APPLE_MUSIC_PRIVATE_KEY") {
        return await pemForTests();
      }
      return undefined;
    });
  }

  let cachedPem: string | undefined;

  async function pemForTests(): Promise<string> {
    if (!cachedPem) {
      cachedPem = (await generatePkcs8Pem()).pem;
    }

    return cachedPem;
  }

  function mockFetchJson(status: number, payload: unknown): typeof fetch {
    return vi.fn(async () => ({
      json: async () => payload,
      ok: status >= 200 && status < 300,
      status,
      statusText: "",
    })) as unknown as typeof fetch;
  }

  it("configured single-ISRC lookup returns the built bundle and hits include=albums", async () => {
    configureCredentials();
    const fetchMock = mockFetchJson(200, {
      data: [songFixture({ albumIds: ["a1"], id: "song1", isrc: "GB1111111111" })],
      included: [albumFixture({ id: "a1", isCompilation: false, recordLabel: "Shogun Audio" })],
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);

    const { appleCatalogLookupByIsrc } = await import("./apple-music");
    const result = await appleCatalogLookupByIsrc("GB1111111111");

    expect(result).toMatchObject({ configured: true, ok: true });
    if (result.configured && result.ok) {
      expect(result.bundle?.canonicalAlbum?.recordLabel).toBe("Shogun Audio");
    }

    const calledUrl = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as string;
    expect(calledUrl).toContain("filter%5Bisrc%5D=GB1111111111");
    expect(calledUrl).toContain("include=albums");
  });

  it("propagates a 429 as rateLimited", async () => {
    configureCredentials();
    vi.spyOn(globalThis, "fetch").mockImplementation(mockFetchJson(429, {}));

    const { appleCatalogLookupByIsrc } = await import("./apple-music");
    const result = await appleCatalogLookupByIsrc("GB2222222222");

    expect(result).toMatchObject({ configured: true, ok: false, rateLimited: true });
  });

  it("returns { configured: false } (no fetch) when unprovisioned", async () => {
    readOptionalEnv.mockResolvedValue(undefined);
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const { appleCatalogLookupByIsrc, appleCatalogLookupByIsrcs } = await import("./apple-music");

    expect(await appleCatalogLookupByIsrc("GB3333333333")).toEqual({ configured: false });
    expect(await appleCatalogLookupByIsrcs(["GB3333333333"])).toEqual({ configured: false });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("batched lookup validates + chunks ≤25 per request", async () => {
    configureCredentials();
    // 30 distinct ISRCs → two requests (25 + 5). Each request echoes its chunk as data.
    const isrcs = Array.from({ length: 30 }, (_, i) => `GB${String(i).padStart(10, "0")}`);

    const fetchMock = vi.fn(async (url: string) => {
      const match = url.match(/filter%5Bisrc%5D=([^&]+)/);
      const chunk = (match?.[1] ?? "").split(",").map(decodeURIComponent);

      return {
        json: async () => ({
          data: chunk.map((isrc, idx) =>
            songFixture({ albumIds: [], id: `id-${isrc}-${idx}`, isrc }),
          ),
          meta: {
            filters: {
              isrc: Object.fromEntries(chunk.map((isrc) => [isrc, [{ id: `id-${isrc}-0` }]])),
            },
          },
        }),
        ok: true,
        status: 200,
        statusText: "",
      };
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as unknown as typeof fetch);

    const { appleCatalogLookupByIsrcs } = await import("./apple-music");
    const result = await appleCatalogLookupByIsrcs(isrcs);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ configured: true, ok: true });
    if (result.configured && result.ok) {
      expect(result.bundles.size).toBe(30);
    }
  });

  it("batched lookup no-ops an all-empty input without a fetch", async () => {
    configureCredentials();
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const { appleCatalogLookupByIsrcs } = await import("./apple-music");
    const result = await appleCatalogLookupByIsrcs(["  ", ""]);

    expect(result).toMatchObject({ configured: true, ok: true });
    if (result.configured && result.ok) {
      expect(result.bundles.size).toBe(0);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
