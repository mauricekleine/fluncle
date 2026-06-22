// Shared helpers for the oRPC handler tests. `handleOrpc` is typed
// `Response | null`; every handler test expects a real Response, so reading the
// body through here turns a stray `null` into a clear test failure instead of a
// downstream `TypeError` on `null.json()` — and keeps the unsafe `response!.json()`
// non-null assertion out of the test files.
export async function readJson(response: Response | null | undefined): Promise<unknown> {
  if (!response) {
    throw new Error("expected a Response to read, but it was null/undefined");
  }

  return response.json();
}
