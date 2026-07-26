/**
 * Pull a human sentence out of a failed `fetch` Response — the one reader every
 * client-side admin mutation uses for its error toast.
 *
 * Prefers the API's own JSON `message` (the admin routes emit one with every
 * fault code), falls back to the raw body text, then the status line. Reads a
 * `clone()` so the caller can still consume the original body, and every step is
 * failure-tolerant: a fault must never fault again on its way to being reported.
 */
export async function readError(response: Response): Promise<string> {
  try {
    const body = (await response.clone().json()) as { message?: unknown };

    if (typeof body.message === "string" && body.message.trim()) {
      return body.message;
    }
  } catch {
    // Fall through to text/status below.
  }

  const text = await response.text().catch(() => "");

  return text.trim() || response.statusText || `Request failed (${response.status})`;
}
