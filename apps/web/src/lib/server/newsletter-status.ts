// The signed-in user's newsletter subscription state, read from Resend for the
// Settings → Newsletter row (the account redesign brief §4 / operator ruling #5:
// signing up auto-subscribes, and Settings shows the status with a re-subscribe
// option for the unsubscribed). Resend is the list-of-record — there is no local
// subscribers table — so the status is a live read of the contact by email.
//
// Raw `fetch` against the REST API, mirroring resend.ts's client style (which this
// slice must NOT edit). This module only READS a contact's status; the re-subscribe
// ACTION reuses the existing public `subscribeToNewsletter` path in-process (see the
// door's serverFn), so both halves share one code path to Resend.
//
// DEGRADES to `{ available: false }` — the row hides — whenever RESEND_* is absent
// or the read faults, so an unprovisioned Worker (and local dev) shows no dead row.

import { readOptionalEnv } from "./env";

const RESEND_API_URL = "https://api.resend.com";

/** `available: false` hides the row (env absent / read faulted); otherwise the live state. */
export type NewsletterStatus = { available: false } | { available: true; subscribed: boolean };

type ResendContact = { unsubscribed?: boolean };

/**
 * Interpret a Resend `GET /contacts/{email}` response into a subscription verdict.
 * Pure (no I/O), so the mapping is unit-testable:
 *   - 200 → subscribed iff the contact is NOT unsubscribed;
 *   - 404 → the email is not a contact at all → not subscribed;
 *   - anything else (401/429/5xx) → `"error"` → the caller degrades (hides the row).
 */
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

/**
 * Read the signed-in user's newsletter status by email. Returns `{ available: false }`
 * when Resend is unprovisioned or the read faults (the row hides); otherwise the live
 * subscribed/unsubscribed verdict. Never throws — a status read is advisory chrome,
 * never on any critical path.
 */
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
