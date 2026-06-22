import { type NewsletterBody } from "@fluncle/contracts/orpc";
import { readEnv, readOptionalEnv } from "./env";
import { getPublicSession } from "./public-auth";
import { assertRateLimit } from "./rate-limit";
import { ApiError } from "./spotify";

const loopsApiUrl = "https://app.loops.so/api/v1";
const rateLimitWindowMs = 60 * 60 * 1000;
const rateLimitMaxAttempts = 5;
const maxEmailLength = 254;

// The subscribe body is the contract's inferred input (`@fluncle/contracts/orpc`),
// the single source of truth — no parallel hand-mirror to drift. LOOSE/all-unknown
// by design; `validateInput` narrows it.
export type NewsletterInput = NewsletterBody;

export async function subscribeToNewsletter(
  body: NewsletterInput,
  request: Request,
): Promise<void> {
  const email = validateInput(body);

  // The shared atomic, DB-backed limiter — the old per-isolate in-memory array
  // reset on every redeploy and was per-Worker-isolate, which is no limit at all
  // against an email-bombing flood. Keyed on the signed-in user when present, else
  // hash(cf-connecting-ip) (never x-forwarded-for, never the User-Agent).
  const publicUser = await getPublicSession(request);

  await assertRateLimit({
    action: "subscribe_newsletter",
    limit: rateLimitMaxAttempts,
    message: "Too many tries from this connection. Try again later.",
    request,
    userId: publicUser?.id,
    windowMs: rateLimitWindowMs,
  });

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
