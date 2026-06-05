export async function subscribeToNewsletter({
  email,
  honeypot,
}: {
  email: string;
  honeypot?: string;
}): Promise<void> {
  const response = await fetch("/api/newsletter", {
    body: JSON.stringify({ email, honeypot }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  const data = (await response.json()) as { ok?: boolean; message?: string };

  if (!response.ok || !data.ok) {
    throw new Error(data.message ?? `Subscribe failed: ${response.status}`);
  }
}
