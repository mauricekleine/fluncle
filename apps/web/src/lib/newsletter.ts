export const SUBSCRIBE_FAILED_MESSAGE =
  "I couldn't add you to the newsletter just now. Try again in a moment.";

export async function subscribeToNewsletter({
  email,
  honeypot,
}: {
  email: string;
  honeypot?: string;
}): Promise<void> {
  const response = await fetch("/api/v1/newsletter", {
    body: JSON.stringify({ email, honeypot }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  const data = (await response.json().catch(() => ({}))) as { ok?: boolean; message?: string };

  if (!response.ok || !data.ok) {
    throw new Error(data.message ?? SUBSCRIBE_FAILED_MESSAGE);
  }
}
