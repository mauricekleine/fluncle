import { type NewsletterBody } from "@fluncle/contracts/orpc";
import { getPublicSession } from "./public-auth";
import { assertRateLimit } from "./rate-limit";
import { addContactToSegment } from "./resend";
import { ApiError } from "./spotify";

const rateLimitWindowMs = 60 * 60 * 1000;
const rateLimitMaxAttempts = 5;
const maxEmailLength = 254;

// The subscribe body is the contract's inferred input (`@fluncle/contracts/orpc`),
// the single source of truth — no parallel hand-mirror to drift. LOOSE/all-unknown
// by design; `validateInput` narrows it.
export type NewsletterInput = NewsletterBody;

// Repointed Loops → Resend. The public
// contract/endpoint shape is UNCHANGED — same `POST /newsletter`, same validation,
// same rate limit, same bare `{ ok: true }` — only the list-of-record backend
// swaps: the email is added to the Fluncle Resend SEGMENT instead of the Loops
// contacts list. Resend is now the sole list-of-record (the clean mirror of the old
// Loops-only design; no local subscribers table). The on-subscribe confirmation
// transactional is dropped for now: single-opt-in stays (RFC §1 non-goals keep
// today's posture), and every broadcast carries the managed RFC-8058 unsubscribe.
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

  await addContactToSegment(email);
}

function validateInput(body: NewsletterInput): string {
  if (typeof body.honeypot === "string" && body.honeypot.trim()) {
    throw new ApiError("invalid_request", "Invalid request", 400);
  }

  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";

  // Deliberately loose shape check; Resend validates properly on its side.
  const looksLikeEmail =
    email.length >= 6 &&
    email.length <= maxEmailLength &&
    /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);

  if (!looksLikeEmail) {
    throw new ApiError("invalid_email", "Enter a valid email address.", 400);
  }

  return email;
}
