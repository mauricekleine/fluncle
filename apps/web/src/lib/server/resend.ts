import { readEnv, readOptionalEnv } from "./env";
import { ApiError } from "./spotify";

const resendApiUrl = "https://api.resend.com";

type ResendErrorBody = { message?: string; name?: string };

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function resolveResendApiUrl({
  e2e,
  override,
  production,
}: {
  e2e: string | undefined;
  override: string | undefined;
  production: boolean;
}): string {
  if (production || e2e !== "1" || !override) {
    return resendApiUrl;
  }

  try {
    return LOOPBACK_HOSTS.has(new URL(override).hostname)
      ? override.replace(/\/$/, "")
      : resendApiUrl;
  } catch {
    return resendApiUrl;
  }
}

async function resendFetch(
  path: string,
  init: { body?: unknown; idempotencyKey?: string; method: "GET" | "POST" },
): Promise<Response> {
  const apiKey = await readEnv("RESEND_API_KEY");
  const [override, e2e] = await Promise.all([
    readOptionalEnv("RESEND_API_URL"),
    readOptionalEnv("FLUNCLE_E2E"),
  ]);
  const baseUrl = resolveResendApiUrl({ e2e, override, production: !import.meta.env.DEV });
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };

  if (init.idempotencyKey) {
    headers["Idempotency-Key"] = init.idempotencyKey;
  }

  return fetch(`${baseUrl}${path}`, {
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    headers,
    method: init.method,
  });
}

async function readError(response: Response): Promise<string> {
  const body = (await response.json().catch(() => undefined)) as ResendErrorBody | undefined;

  return body?.message ?? body?.name ?? `${response.status} ${response.statusText}`;
}

export async function addContactToSegment(email: string): Promise<void> {
  const segmentId = await readEnv("RESEND_SEGMENT_ID");

  const createResponse = await resendFetch("/contacts", {
    body: { email, unsubscribed: false },
    method: "POST",
  });

  if (!createResponse.ok && createResponse.status !== 409 && createResponse.status !== 422) {
    if (createResponse.status === 429) {
      throw new ApiError("rate_limited", "Try again in a minute.", 503);
    }

    throw new ApiError(
      "subscribe_failed",
      `Could not subscribe (${await readError(createResponse)})`,
      502,
    );
  }

  const segmentResponse = await resendFetch(
    `/contacts/${encodeURIComponent(email)}/segments/${encodeURIComponent(segmentId)}`,
    { method: "POST" },
  );

  if (!segmentResponse.ok && segmentResponse.status !== 409 && segmentResponse.status !== 422) {
    if (segmentResponse.status === 429) {
      throw new ApiError("rate_limited", "Try again in a minute.", 503);
    }

    throw new ApiError(
      "subscribe_failed",
      `Could not subscribe (${await readError(segmentResponse)})`,
      502,
    );
  }
}

export async function createBroadcast(params: {
  editionId: string;
  html: string;
  name: string;
  subject: string;
}): Promise<{ id: string }> {
  const segmentId = await readEnv("RESEND_SEGMENT_ID");
  const from = await readOptionalEnv("RESEND_FROM");

  if (!from) {
    throw new ApiError(
      "send_misconfigured",
      "RESEND_FROM is not configured — set the verified sender before sending an edition.",
      500,
    );
  }

  const response = await resendFetch("/broadcasts", {
    body: {
      from,
      html: params.html,
      name: params.name,
      segment_id: segmentId,
      subject: params.subject,
    },
    idempotencyKey: `edition-broadcast/${params.editionId}`,
    method: "POST",
  });

  if (!response.ok) {
    throw new ApiError(
      "broadcast_create_failed",
      `Resend could not create the broadcast (${await readError(response)})`,
      502,
    );
  }

  const data = (await response.json().catch(() => undefined)) as { id?: string } | undefined;

  if (!data?.id) {
    throw new ApiError("broadcast_create_failed", "Resend did not return a broadcast id", 502);
  }

  return { id: data.id };
}

export async function countSegmentRecipients(): Promise<number | null> {
  try {
    const segmentId = await readEnv("RESEND_SEGMENT_ID");
    const response = await resendFetch(`/segments/${encodeURIComponent(segmentId)}/contacts`, {
      method: "GET",
    });

    if (!response.ok) {
      return null;
    }

    const body = (await response.json().catch(() => undefined)) as
      | { data?: { data?: unknown[] } | unknown[] }
      | undefined;
    const data = body?.data;

    if (Array.isArray(data)) {
      return data.length;
    }

    const nested = data?.data;

    return Array.isArray(nested) ? nested.length : null;
  } catch {
    return null;
  }
}

export async function sendBroadcast(
  broadcastId: string,
  options: { scheduledAt?: string } = {},
): Promise<void> {
  const response = await resendFetch(`/broadcasts/${encodeURIComponent(broadcastId)}/send`, {
    body: options.scheduledAt ? { scheduled_at: options.scheduledAt } : undefined,
    idempotencyKey: `edition-send/${broadcastId}`,
    method: "POST",
  });

  if (!response.ok) {
    throw new ApiError(
      "broadcast_send_failed",
      `Resend could not send the broadcast (${await readError(response)})`,
      502,
    );
  }
}

async function sendTransactionalEmail(params: {
  headers?: Record<string, string>;
  html: string;
  idempotencyKey?: string;
  subject: string;
  text: string;
  to: string;
}): Promise<void> {
  const from = await readOptionalEnv("RESEND_FROM");

  if (!from) {
    throw new ApiError(
      "send_misconfigured",
      "RESEND_FROM is not configured — set the verified sender before sending.",
      500,
    );
  }

  const response = await resendFetch("/emails", {
    body: {
      from,
      headers: params.headers,
      html: params.html,
      subject: params.subject,
      text: params.text,
      to: params.to,
    },
    idempotencyKey: params.idempotencyKey,
    method: "POST",
  });

  if (!response.ok) {
    throw new ApiError(
      "email_send_failed",
      `Resend could not send the email (${await readError(response)})`,
      502,
    );
  }
}

export async function sendFollowDigestEmail(params: {
  headers: Record<string, string>;
  html: string;
  idempotencyKey: string;
  subject: string;
  text: string;
  to: string;
}): Promise<void> {
  await sendTransactionalEmail(params);
}

export async function sendPasswordResetEmail(params: { to: string; url: string }): Promise<void> {
  const text = [
    "Someone asked to reset the password on your Fluncle account. If that was you, open this link to set a new one:",
    "",
    params.url,
    "",
    "The link works for one hour. If it wasn't you, ignore this and nothing changes.",
    "",
    "Fluncle",
  ].join("\n");

  const html = [
    "<p>Someone asked to reset the password on your Fluncle account. If that was you, open this link to set a new one:</p>",
    `<p><a href="${escapeHtmlAttribute(params.url)}">Set a new password</a></p>`,
    "<p>The link works for one hour. If it wasn&rsquo;t you, ignore this and nothing changes.</p>",
    "<p>Fluncle</p>",
  ].join("\n");

  await sendTransactionalEmail({
    html,
    subject: "Reset your Fluncle password",
    text,
    to: params.to,
  });
}

export async function sendVerificationEmail(params: { to: string; url: string }): Promise<void> {
  const text = [
    "Welcome aboard. Confirm this is your email so I can keep your Fluncle account yours. Open this link:",
    "",
    params.url,
    "",
    "You are already signed in and nothing is locked behind this. Verifying just keeps the door yours. If you didn't create a Fluncle account, ignore this and nothing happens.",
    "",
    "Fluncle",
  ].join("\n");

  const html = [
    "<p>Welcome aboard. Confirm this is your email so I can keep your Fluncle account yours. Open this link:</p>",
    `<p><a href="${escapeHtmlAttribute(params.url)}">Verify your email</a></p>`,
    "<p>You are already signed in and nothing is locked behind this. Verifying just keeps the door yours. If you didn&rsquo;t create a Fluncle account, ignore this and nothing happens.</p>",
    "<p>Fluncle</p>",
  ].join("\n");

  await sendTransactionalEmail({
    html,
    subject: "Verify your Fluncle email",
    text,
    to: params.to,
  });
}

export async function sendMagicLinkEmail(params: {
  followName?: string;
  to: string;
  url: string;
}): Promise<void> {
  const name = params.followName;
  const safeName = name ? escapeHtmlAttribute(name) : undefined;
  const opener = name
    ? `Hey, good to have you with the crew. Open this link and you're in, following ${name}:`
    : "Hey, good to have you with the crew. Open this link and you're in:";
  const htmlOpener = safeName
    ? `Hey, good to have you with the crew. Open this link and you&rsquo;re in, following ${safeName}:`
    : "Hey, good to have you with the crew. Open this link and you&rsquo;re in:";
  const closing = name
    ? `Every Friday I'll email you ${name}'s new releases. Nothing new, no email.`
    : "Save any banger that gets you moving and I'll keep it for you, wherever you sign in.";
  const htmlClosing = safeName
    ? `Every Friday I&rsquo;ll email you ${safeName}&rsquo;s new releases. Nothing new, no email.`
    : "Save any banger that gets you moving and I&rsquo;ll keep it for you, wherever you sign in.";
  const text = [
    opener,
    "",
    params.url,
    "",
    "It works once, for the next 15 minutes. If you didn't ask for it, ignore this and nothing happens.",
    "",
    closing,
    "",
    "Happy raving,",
    "Fluncle",
  ].join("\n");

  const html = [
    `<p>${htmlOpener}</p>`,
    `<p><a href="${escapeHtmlAttribute(params.url)}">${safeName ? `Sign in and follow ${safeName}` : "Sign in to Fluncle"}</a></p>`,
    "<p>It works once, for the next 15 minutes. If you didn&rsquo;t ask for it, ignore this and nothing happens.</p>",
    `<p>${htmlClosing}</p>`,
    "<p>Happy raving,<br>Fluncle</p>",
  ].join("\n");

  await sendTransactionalEmail({
    html,
    subject: name ? `Your link to follow ${name}` : "Your Fluncle sign-in link",
    text,
    to: params.to,
  });
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
