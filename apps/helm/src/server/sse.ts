// Server-sent-event framing. Data is always a single JSON line (JSON.stringify
// never emits a raw newline), so one `data:` field per event is sufficient and
// the frame is trivially parseable by EventSource. Pure and unit-tested.

/** Frame one named event. */
export function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Frame a comment — the keepalive EventSource ignores. */
export function sseComment(text: string): string {
  return `: ${text}\n\n`;
}

export const SSE_HEADERS = {
  "cache-control": "no-cache",
  connection: "keep-alive",
  "content-type": "text/event-stream",
} as const;
