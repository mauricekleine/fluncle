import { readOptionalEnv } from "./env";

const RESEND_API_URL = "https://api.resend.com";

export type NewsletterStatus = { available: false } | { available: true; subscribed: boolean };

type ResendContact = { unsubscribed?: boolean };

export function parseNewsletterStatus(
  httpStatus: number,
  body: ResendContact | undefined,
): { subscribed: boolean } | "error" {
  if (httpStatus === 200) {
    return { subscribed: body?.unsubscribed !== true };
  }

  if (httpStatus === 404) {
    return { subscribed: false };
  }

  return "error";
}

export async function readNewsletterStatus(email: string): Promise<NewsletterStatus> {
  const apiKey = await readOptionalEnv("RESEND_API_KEY");

  if (!apiKey) {
    return { available: false };
  }

  try {
    const response = await fetch(`${RESEND_API_URL}/contacts/${encodeURIComponent(email)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      method: "GET",
    });
    const body = (await response.json().catch(() => undefined)) as ResendContact | undefined;
    const verdict = parseNewsletterStatus(response.status, body);

    if (verdict === "error") {
      return { available: false };
    }

    return { available: true, subscribed: verdict.subscribed };
  } catch {
    return { available: false };
  }
}
