import { waitUntil } from "cloudflare:workers";
import { type FetchImpl } from "./env";
import { logEvent } from "./log";
import { SA_HOSTNAME } from "./simple-analytics";

const SA_BEACON_TIMEOUT_MS = 3000;

async function sendSpotifyOutbound(ua: string, fetchImpl: FetchImpl): Promise<void> {
  try {
    const response = await fetchImpl("https://queue.simpleanalyticscdn.com/events", {
      body: JSON.stringify({
        event: "discovery_outbound",
        hostname: SA_HOSTNAME,
        metadata: { service: "spotify" },
        type: "event",
        ua,
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
      signal: AbortSignal.timeout(SA_BEACON_TIMEOUT_MS),
    });

    if (!response.ok) {
      logEvent("warn", "analytics.spotify-outbound-failed");
    }
  } catch {
    logEvent("warn", "analytics.spotify-outbound-failed");
  }
}

export function beaconSpotifyOutbound(request: Request, fetchImpl: FetchImpl = fetch): void {
  const { hostname } = new URL(request.url);
  const ua = request.headers.get("User-Agent");

  if (!ua || (hostname !== SA_HOSTNAME && !hostname.endsWith(`.${SA_HOSTNAME}`))) {
    return;
  }

  waitUntil(sendSpotifyOutbound(ua, fetchImpl));
}
