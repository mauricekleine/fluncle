import { getActiveSpan, type Span } from "@sentry/core";

const totals = new WeakMap<Span, { bytes: number; responses: number }>();

export async function databaseFetch(...args: Parameters<typeof fetch>): Promise<Response> {
  const span = getActiveSpan();
  const response = await fetch(...args);
  if (!span?.isRecording() || response.body === null) {
    return response;
  }

  let total = totals.get(span);
  if (total === undefined) {
    total = { bytes: 0, responses: 0 };
    totals.set(span, total);
  }
  total.responses += 1;
  span.setAttribute("fluncle.response_count", total.responses);
  const counter = total;
  const body = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        counter.bytes += chunk.byteLength;
        span.setAttribute("fluncle.response_body_bytes", counter.bytes);
        controller.enqueue(chunk);
      },
    }),
  );
  return new Response(body, {
    headers: response.headers,
    status: response.status,
    statusText: response.statusText,
  });
}
