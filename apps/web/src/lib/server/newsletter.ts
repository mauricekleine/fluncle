import { readEnv, readOptionalEnv } from "./env";
import { ApiError } from "./spotify";
import { hashSubmitter } from "./submissions";

const loopsApiUrl = "https://app.loops.so/api/v1";
const rateLimitWindowMs = 60 * 60 * 1000;
const rateLimitMaxAttempts = 5;
const maxEmailLength = 254;

export type NewsletterInput = {
  email?: unknown;
  honeypot?: unknown;
};

// Best-effort per-connection limiter. In-memory by design: Loops is the store
// of record, duplicate subscribes are idempotent (409 reads as success), and
// the confirmation send is deduped by Loops' own Idempotency-Key, so a reset
// on redeploy costs nothing.
const attemptsByConnection = new Map<string, number[]>();

export async function subscribeToNewsletter(
  body: NewsletterInput,
  request: Request,
): Promise<void> {
  const email = validateInput(body);
  enforceRateLimit(hashSubmitter(request));

  const apiKey = await readEnv("LOOPS_API_KEY");
  const created = await createContact(apiKey, email);

  if (!created) {
    return;
  }

  const transactionalId = await readOptionalEnv("LOOPS_TRANSACTIONAL_ID");

  if (transactionalId) {
    await sendConfirmation(apiKey, transactionalId, email);
  }
}

function validateInput(body: NewsletterInput): string {
  if (typeof body.honeypot === "string" && body.honeypot.trim()) {
    throw new ApiError("invalid_request", "Invalid request", 400);
  }

  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";

  // Deliberately loose shape check; Loops validates properly on its side.
  const looksLikeEmail =
    email.length >= 6 &&
    email.length <= maxEmailLength &&
    /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);

  if (!looksLikeEmail) {
    throw new ApiError("invalid_email", "Enter a valid email address.", 400);
  }

  return email;
}

function enforceRateLimit(connectionHash: string): void {
  const now = Date.now();
  const windowStart = now - rateLimitWindowMs;
  const attempts = (attemptsByConnection.get(connectionHash) ?? []).filter(
    (timestamp) => timestamp >= windowStart,
  );

  if (attempts.length >= rateLimitMaxAttempts) {
    throw new ApiError(
      "rate_limited",
      "Too many tries from this connection. Try again later.",
      429,
    );
  }

  attempts.push(now);
  attemptsByConnection.set(connectionHash, attempts);

  // Drop stale connections so the map cannot grow without bound.
  if (attemptsByConnection.size > 10_000) {
    for (const [key, timestamps] of attemptsByConnection) {
      if (timestamps.every((timestamp) => timestamp < windowStart)) {
        attemptsByConnection.delete(key);
      }
    }
  }
}

// Returns true when the contact is on the list (newly created or already
// there); Loops returns 409 for an existing email, which is success for us.
async function createContact(apiKey: string, email: string): Promise<boolean> {
  const response = await fetch(`${loopsApiUrl}/contacts/create`, {
    body: JSON.stringify({
      email,
      source: "fluncle.com",
      subscribed: true,
    }),
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    method: "POST",
  });

  if (response.ok || response.status === 409) {
    return true;
  }

  if (response.status === 429) {
    throw new ApiError("rate_limited", "Try again in a minute.", 503);
  }

  const data = (await response.json().catch(() => undefined)) as { message?: string } | undefined;

  throw new ApiError(
    "subscribe_failed",
    data?.message ?? `Could not subscribe (${response.status})`,
    502,
  );
}

// Confirmation is a courtesy on top of a successful subscribe; a failure here
// (missing template, transient error) must not unsubscribe the outcome, so it
// logs and returns. Loops dedupes resends for 24h via the Idempotency-Key.
async function sendConfirmation(
  apiKey: string,
  transactionalId: string,
  email: string,
): Promise<void> {
  const response = await fetch(`${loopsApiUrl}/transactional`, {
    body: JSON.stringify({
      email,
      transactionalId,
    }),
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "Idempotency-Key": `newsletter-confirm:${email}`,
    },
    method: "POST",
  });

  if (!response.ok && response.status !== 409) {
    const data = (await response.json().catch(() => undefined)) as { message?: string } | undefined;
    console.error(
      `Newsletter confirmation send failed (${response.status}): ${data?.message ?? "unknown"}`,
    );
  }
}
