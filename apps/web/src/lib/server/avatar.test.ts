import { describe, expect, it } from "vitest";
import {
  AVATAR_MAX_BYTES,
  readAvatarBody,
  sniffAvatarType,
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

function jpegBytes(width: number, height: number): ArrayBuffer {
  const buffer = new ArrayBuffer(32);
  const view = new DataView(buffer);

  view.setUint16(0, 0xffd8);
  view.setUint8(2, 0xff);
  view.setUint8(3, 0xc0);
  view.setUint16(4, 17);
  view.setUint8(6, 8);
  view.setUint16(7, height);
  view.setUint16(9, width);

  return buffer;
}

function webpBytes(width: number, height: number): ArrayBuffer {
  const buffer = new ArrayBuffer(30);
  const view = new DataView(buffer);

  view.setUint32(0, 0x52494646);
  view.setUint32(8, 0x57454250);
  view.setUint32(12, 0x56503858);
  view.setUint16(24, (width - 1) & 0xffff, true);
  view.setUint8(26, ((width - 1) >> 16) & 0xff);
  view.setUint16(27, (height - 1) & 0xffff, true);
  view.setUint8(29, ((height - 1) >> 16) & 0xff);

  return buffer;
}

function bytesOf(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer as ArrayBuffer;
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
    expect(validateAvatarUpload("image/jpeg", jpegBytes(64, 64))).toEqual({
      ext: "jpg",
      mime: "image/jpeg",
      ok: true,
    });
    expect(validateAvatarUpload("image/png", pngBytes(512, 512))).toEqual({
      ext: "png",
      mime: "image/png",
      ok: true,
    });

    expect(validateAvatarUpload("image/webp; charset=binary", webpBytes(200, 200))).toEqual({
      ext: "webp",
      mime: "image/webp",
      ok: true,
    });
  });

  it("rejects bytes whose image signature does not match the declared content-type", () => {
    expect(validateAvatarUpload("image/jpeg", pngBytes(64, 64))).toMatchObject({
      code: "unsupported_type",
      ok: false,
      status: 415,
    });
    expect(validateAvatarUpload("image/png", webpBytes(64, 64))).toMatchObject({
      code: "unsupported_type",
      status: 415,
    });
  });

  it("rejects a body that is not a readable image under an image content-type", () => {
    const html = bytesOf("<!doctype html><script>alert(1)</script>");

    expect(validateAvatarUpload("image/png", html)).toMatchObject({
      code: "unsupported_type",
      ok: false,
      status: 415,
    });
    expect(validateAvatarUpload("image/jpeg", new ArrayBuffer(64))).toMatchObject({
      code: "unsupported_type",
      status: 415,
    });
  });

  it("rejects a GIF even when it is labelled as an allowed type", () => {
    const gif = new ArrayBuffer(32);
    new DataView(gif).setUint32(0, 0x47494638);

    expect(sniffAvatarType(gif)).toBeUndefined();
    expect(validateAvatarUpload("image/png", gif)).toMatchObject({ code: "unsupported_type" });
  });

  it("sniffs the three accepted formats from their signatures", () => {
    expect(sniffAvatarType(pngBytes(1, 1))).toBe("image/png");
    expect(sniffAvatarType(jpegBytes(1, 1))).toBe("image/jpeg");
    expect(sniffAvatarType(webpBytes(1, 1))).toBe("image/webp");
    expect(sniffAvatarType(new ArrayBuffer(0))).toBeUndefined();
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
    expect(validateAvatarUpload("image/jpeg", jpegBytes(64, 513))).toMatchObject({
      code: "dimensions_too_large",
    });
  });

  it("accepts an image exactly 512px on a side", () => {
    const result = validateAvatarUpload("image/webp", webpBytes(512, 512));

    expect(result).toMatchObject({ ok: true });
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
