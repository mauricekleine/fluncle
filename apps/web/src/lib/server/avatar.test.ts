import { describe, expect, it } from "vitest";
import { AVATAR_MAX_BYTES, validateAvatarUpload, verifyAvatarMutation } from "./avatar";
import { createCsrfToken, type PublicUser } from "./public-auth";

// A minimal PNG header buffer with the intrinsic width/height in the IHDR fields, so
// `readImageSize` (shared with the cover-master parser) reads the dimensions. 24 bytes
// is its minimum; width @16 and height @20 are big-endian u32.
function pngBytes(width: number, height: number): ArrayBuffer {
  const buffer = new ArrayBuffer(24);
  const view = new DataView(buffer);

  view.setUint32(0, 0x89504e47);
  view.setUint32(4, 0x0d0a1a0a);
  view.setUint32(16, width);
  view.setUint32(20, height);

  return buffer;
}

const user: PublicUser = {
  createdAt: new Date().toISOString(),
  email: "raver@example.com",
  emailVerified: true,
  id: "user_1",
  name: "Raver",
};

describe("validateAvatarUpload", () => {
  it("accepts a supported, small, in-bounds image and derives the extension", () => {
    expect(validateAvatarUpload("image/jpeg", pngBytes(64, 64))).toEqual({ ext: "jpg", ok: true });
    expect(validateAvatarUpload("image/png", pngBytes(512, 512))).toEqual({ ext: "png", ok: true });
    // A content-type with parameters still resolves to the base mime.
    expect(validateAvatarUpload("image/webp; charset=binary", pngBytes(200, 200))).toEqual({
      ext: "webp",
      ok: true,
    });
  });

  it("rejects an unsupported content-type", () => {
    const result = validateAvatarUpload("image/gif", pngBytes(64, 64));

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ code: "unsupported_type", status: 415 });
  });

  it("rejects an empty upload", () => {
    const result = validateAvatarUpload("image/jpeg", new ArrayBuffer(0));

    expect(result).toMatchObject({ code: "empty_upload", ok: false, status: 400 });
  });

  it("rejects an oversized upload before reading dimensions", () => {
    const result = validateAvatarUpload("image/jpeg", new ArrayBuffer(AVATAR_MAX_BYTES + 1));

    expect(result).toMatchObject({ code: "too_large", ok: false, status: 413 });
  });

  it("rejects an image larger than 512px on a side", () => {
    const result = validateAvatarUpload("image/png", pngBytes(513, 64));

    expect(result).toMatchObject({ code: "dimensions_too_large", ok: false, status: 422 });
  });
});

describe("verifyAvatarMutation", () => {
  function request(headers: Record<string, string>): Request {
    return new Request("https://www.fluncle.com/api/me/avatar", { headers, method: "POST" });
  }

  it("passes a same-origin request carrying a valid CSRF token", () => {
    const result = verifyAvatarMutation(
      request({ origin: "https://www.fluncle.com", "x-fluncle-csrf": createCsrfToken(user) }),
      user,
    );

    expect(result).toBeUndefined();
  });

  it("blocks a cross-origin request", () => {
    const result = verifyAvatarMutation(
      request({ origin: "https://evil.example.com", "x-fluncle-csrf": createCsrfToken(user) }),
      user,
    );

    expect(result?.status).toBe(403);
  });

  it("blocks a same-origin request missing the CSRF token", () => {
    const result = verifyAvatarMutation(request({ origin: "https://www.fluncle.com" }), user);

    expect(result?.status).toBe(403);
  });

  it("blocks a request with neither origin nor referer", () => {
    const result = verifyAvatarMutation(request({ "x-fluncle-csrf": createCsrfToken(user) }), user);

    expect(result?.status).toBe(403);
  });

  it("rejects a forged CSRF token", () => {
    const result = verifyAvatarMutation(
      request({ origin: "https://www.fluncle.com", "x-fluncle-csrf": "user_1.0.deadbeef" }),
      user,
    );

    expect(result?.status).toBe(403);
  });
});
