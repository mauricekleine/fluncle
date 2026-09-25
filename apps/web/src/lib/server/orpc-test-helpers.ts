export async function readJson(response: Response | null | undefined): Promise<unknown> {
  if (!response) {
    throw new Error("expected a Response to read, but it was null/undefined");
  }

  return response.json();
}
