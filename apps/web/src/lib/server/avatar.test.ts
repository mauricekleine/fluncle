import { describe, expect, it } from "vitest";
import {
  AVATAR_MAX_BYTES,
  readAvatarBody,
  validateAvatarUpload,
  verifyAvatarMutation,
} from "./avatar";
import { createCsrfToken, type PublicUser } from "./public-auth";

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

function streamedUpload(totalBytes: number, chunkBytes = 64 * 1024): Request {
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= totalBytes) {
        controller.close();
        return;
      }

      const size = Math.min(chunkBytes, totalBytes - sent);
      sent += size;
      controller.enqueue(new Uint8Array(size));
    },
  });

  const init = { body, duplex: "half", method: "POST" };

  return new Request("https://fluncle.com/api/me/avatar", init);
}

describe("readAvatarBody", () => {
  it("reads a body exactly at the cap", async () => {
    const result = await readAvatarBody(streamedUpload(AVATAR_MAX_BYTES));

    expect(result.ok).toBe(true);
    expect(result.ok && result.bytes.byteLength).toBe(AVATAR_MAX_BYTES);
  });

  it("rejects a streamed body one byte past the cap without a declared length", async () => {
    const result = await readAvatarBody(streamedUpload(AVATAR_MAX_BYTES + 1));

    expect(result).toMatchObject({ code: "too_large", ok: false, status: 413 });
  });

  it("rejects a declared content-length past the cap before reading the body", async () => {
    const request = new Request("https://fluncle.com/api/me/avatar", {
      body: new Uint8Array(16),
      headers: { "content-length": String(AVATAR_MAX_BYTES + 1) },
      method: "POST",
    });

    const result = await readAvatarBody(request);

    expect(result).toMatchObject({ code: "too_large", ok: false, status: 413 });
    expect(request.bodyUsed).toBe(false);
  });

  it("returns an empty buffer for a request with no body", async () => {
    const result = await readAvatarBody(
      new Request("https://fluncle.com/api/me/avatar", { method: "POST" }),
    );

    expect(result.ok && result.bytes.byteLength).toBe(0);
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
