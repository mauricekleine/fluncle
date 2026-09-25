import { type NewsletterBody } from "@fluncle/contracts/orpc";
import { getPublicSession } from "./public-auth";
import { assertRateLimit } from "./rate-limit";
import { addContactToSegment } from "./resend";
import { ApiError } from "./spotify";

const rateLimitWindowMs = 60 * 60 * 1000;
const rateLimitMaxAttempts = 5;
const maxEmailLength = 254;

export type NewsletterInput = NewsletterBody;

export async function subscribeToNewsletter(
  body: NewsletterInput,
  request: Request,
): Promise<void> {
  const email = validateInput(body);

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

  const looksLikeEmail =
    email.length >= 6 &&
    email.length <= maxEmailLength &&
    /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);

  if (!looksLikeEmail) {
    throw new ApiError("invalid_email", "Enter a valid email address.", 400);
  }

  return email;
}
