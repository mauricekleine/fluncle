// Helpers for the preview player journeys: a hermetic `/api/preview` relay.
//
// The synthetic seed carries no real preview sources, and the relay would reach Deezer/iTunes for
// them anyway, so every player spec answers the relay itself with a generated silent WAV. Its
// length is the spec's to choose: long enough to pause and resume, or short enough that `ended`
// arrives inside the spec and the queue has to advance.

import { type Page } from "@playwright/test";

/** A mono 8 kHz 8-bit PCM WAV of silence (the midpoint sample value, 128). */
export function silentWav(seconds: number): Buffer {
  const sampleRate = 8000;
  const samples = Math.max(1, Math.round(seconds * sampleRate));
  const header = Buffer.alloc(44);

  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + samples, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate, 28);
  header.writeUInt16LE(1, 32);
  header.writeUInt16LE(8, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(samples, 40);

  return Buffer.concat([header, Buffer.alloc(samples, 128)]);
}

/**
 * Answer every preview request with silence of `seconds`, except the ids in `missing`, which
 * answer the relay's real miss (404 `no_preview`). Returns the ids requested, in order.
 */
export async function routePreviews(
  page: Page,
  options: { missing?: string[]; seconds: number },
): Promise<string[]> {
  const requested: string[] = [];
  const body = silentWav(options.seconds);
  const missing = new Set(options.missing ?? []);

  await page.route("**/api/preview/**", async (route) => {
    const id = decodeURIComponent(new URL(route.request().url()).pathname.split("/").pop() ?? "");

    requested.push(id);

    if (missing.has(id)) {
      await route.fulfill({
        body: JSON.stringify({ error: "no_preview", ok: false }),
        contentType: "application/json",
        status: 404,
      });

      return;
    }

    await route.fulfill({ body, contentType: "audio/wav", status: 200 });
  });

  return requested;
}

/** The Media Session state the lock screen reads (`none` before the first play). */
export async function mediaSessionState(page: Page): Promise<string> {
  return page.evaluate(() => navigator.mediaSession?.playbackState ?? "none");
}
