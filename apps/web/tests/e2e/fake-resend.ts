import { MAIL_PORT, MAIL_URL } from "./stack";

export type CapturedEmail = {
  from: string;
  headers: Record<string, string>;
  html: string;
  id: string;
  idempotencyKey?: string;
  subject: string;
  text: string;
  to: string[];
};

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function recipients(value: unknown): string[] {
  if (typeof value === "string") {
    return [value.toLowerCase()];
  }

  return Array.isArray(value)
    ? value
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.toLowerCase())
    : [];
}

export function startFakeResend(): ReturnType<typeof Bun.serve> {
  const emails: CapturedEmail[] = [];

  return Bun.serve({
    fetch: async (request) => {
      const url = new URL(request.url);

      if (request.method === "GET" && url.pathname === "/captured") {
        const to = url.searchParams.get("to")?.toLowerCase();

        return json({ emails: to ? emails.filter((email) => email.to.includes(to)) : emails });
      }

      if (request.method === "POST" && url.pathname === "/emails") {
        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        const idempotencyKey = request.headers.get("idempotency-key") ?? undefined;
        const existing = idempotencyKey
          ? emails.find((email) => email.idempotencyKey === idempotencyKey)
          : undefined;

        if (existing) {
          return json({ id: existing.id });
        }

        const email: CapturedEmail = {
          from: typeof body.from === "string" ? body.from : "",
          headers:
            body.headers && typeof body.headers === "object"
              ? (body.headers as Record<string, string>)
              : {},
          html: typeof body.html === "string" ? body.html : "",
          id: `e2e-email-${emails.length + 1}`,
          idempotencyKey,
          subject: typeof body.subject === "string" ? body.subject : "",
          text: typeof body.text === "string" ? body.text : "",
          to: recipients(body.to),
        };

        emails.push(email);

        return json({ id: email.id });
      }

      return json({ id: "e2e-fake", object: "ok" });
    },
    hostname: "127.0.0.1",
    port: MAIL_PORT,
  });
}

export async function capturedEmails(to: string): Promise<CapturedEmail[]> {
  const response = await fetch(`${MAIL_URL}/captured?to=${encodeURIComponent(to)}`);
  const body = (await response.json()) as { emails: CapturedEmail[] };

  return body.emails;
}
