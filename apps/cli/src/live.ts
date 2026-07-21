import { getApiBaseUrl } from "./env";

// The CLI's live-set callout: one quiet Nebula-Violet line at the top of every
// non-admin, human command while Fluncle is on the decks (the cross-surface
// live-on-Twitch beat). Read best-effort off /api/v1/status — it never blocks, never
// fails a command, and never prints when piped or in --json (TTY-gated), so it
// can't pollute scriptable output. Offline almost always, so it usually prints
// nothing at all.

// Nebula Violet (#ab7bff) as a 24-bit ANSI foreground — DESIGN.md "The Live
// Exception", the one sanctioned second light.
const NEBULA_VIOLET = "\x1b[38;2;171;123;255m";
const RESET = "\x1b[0m";

// How long to wait on /api/v1/status before giving up — short, since this is a
// best-effort flourish on top of the real command, not the command itself.
const TIMEOUT_MS = 1500;

type LiveStatus = {
  live?: { on: boolean; title: string | null; url: string } | null;
};

// Commands that should NOT carry the callout: the admin group (operator output),
// help, and the version/help flags. The callout rides human commands only.
function shouldSkip(args: string[]): boolean {
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

/** Strip the scheme + leading www. for a clean terminal readout. */
function displayUrl(url: string): string {
  return url.replace(/^https?:\/\/(www\.)?/, "");
}

/**
 * Print the live-set callout above a command's output when Fluncle is on the decks.
 * Best-effort and TTY-only: any failure (offline, timeout, non-TTY, admin/json)
 * silently prints nothing, so a command's behaviour is never affected.
 */
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

    // A trailing blank line separates the callout from the command's own output.
    console.log(`${line}\n`);
  } catch {
    // Best-effort — the callout never blocks or fails a command.
  }
}
