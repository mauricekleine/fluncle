import { hashRequestPart } from "./public-auth";
import { consumeRateLimit, enforceRateLimit } from "./rate-limit";
import { jsonError } from "./env";

const HOUR_MS = 60 * 60 * 1000;

export const MAGIC_LINK_LIMIT_PER_IP = 10;
export const MAGIC_LINK_LIMIT_PER_EMAIL = 5;

const GMAIL_DOMAINS = new Set(["gmail.com", "googlemail.com"]);

export function mailboxAbuseKey(email: string): string {
  const normalized = email.trim().toLowerCase();
  const at = normalized.lastIndexOf("@");

  if (at <= 0) {
    return normalized;
  }

  const domain = normalized.slice(at + 1);
  const local = normalized.slice(0, at).split("+")[0] ?? "";

  if (GMAIL_DOMAINS.has(domain)) {
    return `${local.replaceAll(".", "")}@gmail.com`;
  }

  return `${local}@${domain}`;
}

async function readRequestEmail(request: Request): Promise<string | undefined> {
  try {
    const body = (await request.clone().json()) as { email?: unknown } | null;

    return typeof body?.email === "string" ? body.email.trim().toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

async function magicLinkRateLimit(request: Request): Promise<Response | undefined> {
  const perIp = await enforceRateLimit({
    action: "auth.magic-link",
    limit: MAGIC_LINK_LIMIT_PER_IP,
    request,
    windowMs: HOUR_MS,
  });

  if (perIp) {
    return perIp;
  }

  const email = await readRequestEmail(request);
  const emailHash = hashRequestPart(email === undefined ? undefined : mailboxAbuseKey(email));

  if (!emailHash) {
    return undefined;
  }

  const allowed = await consumeRateLimit({
    action: "auth.magic-link.email",
    bucket: emailHash,
    limit: MAGIC_LINK_LIMIT_PER_EMAIL,
    windowMs: HOUR_MS,
  });

  return allowed
    ? undefined
    : jsonError(429, "rate_limited", "Too many requests. Try again later.");
}

export async function authRateLimit(request: Request): Promise<Response | undefined> {
  const path = new URL(request.url).pathname;

  if (path.endsWith("/sign-up/email")) {
    return enforceRateLimit({
      action: "auth.signup",
      limit: 5,
      request,
      windowMs: HOUR_MS,
    });
  }

  if (path.endsWith("/sign-in/email") || path.endsWith("/sign-in/username")) {
    return enforceRateLimit({
      action: "auth.signin",
      limit: 20,
      request,
      windowMs: HOUR_MS,
    });
  }

  if (path.endsWith("/sign-in/magic-link")) {
    return magicLinkRateLimit(request);
  }

  return undefined;
}
