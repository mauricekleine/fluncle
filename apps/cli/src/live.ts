import { getApiBaseUrl } from "./env";

const NEBULA_VIOLET = "\x1b[38;2;171;123;255m";
const RESET = "\x1b[0m";

const TIMEOUT_MS = 1500;

type LiveStatus = {
  live?: { on: boolean; title: string | null; url: string } | null;
};

export function shouldSkip(args: string[]): boolean {
  if (process.env.FLUNCLE_NO_LIVE_CALLOUT === "1") {
    return true;
  }

  if (process.env.CI) {
    return true;
  }

  if (args.length === 0) {
    return true;
  }

  const first = args[0];

  if (first === "admin" || first === "help") {
    return true;
  }

  return args.some(
    (arg) =>
      arg === "--json" || arg === "--help" || arg === "-h" || arg === "--version" || arg === "-V",
  );
}

function displayUrl(url: string): string {
  return url.replace(/^https?:\/\/(www\.)?/, "");
}

export async function maybePrintLiveCallout(args: string[]): Promise<void> {
  if (shouldSkip(args) || process.stdout.isTTY !== true) {
    return;
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    let data: LiveStatus;
    try {
      const response = await fetch(`${getApiBaseUrl()}/api/v1/status`, {
        signal: controller.signal,
      });

      if (!response.ok) {
        return;
      }

      data = (await response.json()) as LiveStatus;
    } finally {
      clearTimeout(timer);
    }

    const live = data.live;

    if (!live?.on) {
      return;
    }

    const text = `On the decks, live now: ${displayUrl(live.url)}`;
    const line = process.env.NO_COLOR ? text : `${NEBULA_VIOLET}${text}${RESET}`;

    console.log(`${line}\n`);
  } catch {}
}
