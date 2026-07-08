// The Resend client surface — the newsletter's send-of-record.
// The Worker owns `RESEND_API_KEY`;
// the agent box never holds it (the agent calls the admin send op; the Worker
// creates + sends the broadcast). Raw `fetch` against the REST API, mirroring the
// repo's other vendor clients (`./postiz`) — no SDK, so the workerd bundle stays
// small and the surface is exactly what we call.
//
// The two halves:
//   - Contacts: the subscribe path adds an email to the Fluncle SEGMENT
//     (`RESEND_SEGMENT_ID`) — `POST /contacts` then `POST /contacts/{email}/segments/{id}`.
//   - Broadcasts: `send_edition` creates a broadcast to that segment, then sends it
//     (the two-step create-draft → send lifecycle, the operator the human gate).

import { readEnv, readOptionalEnv } from "./env";
import { ApiError } from "./spotify";

const resendApiUrl = "https://api.resend.com";

type ResendErrorBody = { message?: string; name?: string };

async function resendFetch(
  path: string,
  init: { body?: unknown; idempotencyKey?: string; method: "GET" | "POST" },
): Promise<Response> {
  const apiKey = await readEnv("RESEND_API_KEY");
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };

  // Idempotency keys (24h window) guard against duplicate sends on retry — the
  // resend skill's first gotcha. A same-key + same-payload retry returns the
  // original response without re-sending; a same-key + different-payload is a 409.
  if (init.idempotencyKey) {
    headers["Idempotency-Key"] = init.idempotencyKey;
  }

  return fetch(`${resendApiUrl}${path}`, {
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    headers,
    method: init.method,
  });
}

async function readError(response: Response): Promise<string> {
  const body = (await response.json().catch(() => undefined)) as ResendErrorBody | undefined;

  return body?.message ?? body?.name ?? `${response.status} ${response.statusText}`;
}

/**
 * Add an email to the Fluncle segment (the subscribe path). Two REST calls:
 * create/ensure the contact, then attach it to the segment. Both are idempotent for
 * our purposes — a re-subscribe of an existing contact is success, not an error (a
 * 409 on an existing contact is treated as success). Returns silently on success;
 * throws `ApiError` on a real
 * upstream fault so the route emits the same `subscribe_failed`/`rate_limited`
 * codes the caller already maps.
 */
export async function addContactToSegment(email: string): Promise<void> {
  const segmentId = await readEnv("RESEND_SEGMENT_ID");

  // Create the contact. Resend returns 201 for a new contact; an already-present
  // email is a 409 (or a 422 "already exists") which is success for us — the
  // contact is on the account, we just need it in the segment below.
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

  // Attach the contact to the Fluncle segment by email (the segment endpoint
  // accepts an email OR a contact id). Already-in-segment is success.
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

/**
 * Create a broadcast (a DRAFT) to the Fluncle segment. Per the resend skill, only
 * broadcasts CREATED via the API can be SENT via the API — which is satisfied
 * here. Returns the broadcast id the caller stores + sends. `editionId` keys the
 * idempotency so a retried create against the same edition returns the original
 * broadcast rather than minting a duplicate.
 */
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
      // Resend's REST API is snake_case — `segmentId` is silently ignored and the
      // create fails "Missing segment_id or audience_id". (The Node SDK camelCases
      // for you; we use raw fetch, so we send snake_case.)
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

/**
 * Best-effort count of the Fluncle segment's recipients — the billable quantity
 * for a broadcast send (COST-01: Resend bills per email, and a broadcast mails the
 * whole segment). Resend exposes no count field on the broadcast, so we read the
 * segment's contact list and count it. Returns `null` on any failure — the caller
 * emits no cost row rather than a wrong one, and this NEVER throws (it is a
 * cost-ledger read, not part of the send). One page (the list is not paginated
 * through here), so a very large list would undercount — acceptable for an
 * `estimated` figure.
 */
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
    // Resend nests the array under `data` (and some list shapes double-nest it).
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

/**
 * Send a previously-created broadcast (the operator's explicit human send gate).
 * An optional `scheduledAt` (ISO 8601 or Resend natural
 * language like "in 1 hour") defers the send. Idempotency-keyed on the broadcast id
 * so a retried send does not double-fire.
 */
export async function sendBroadcast(
  broadcastId: string,
  options: { scheduledAt?: string } = {},
): Promise<void> {
  const response = await resendFetch(`/broadcasts/${encodeURIComponent(broadcastId)}/send`, {
    // snake_case for Resend's REST API (see createBroadcast). Immediate send omits
    // the body entirely; only a scheduled send carries `scheduled_at`.
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
