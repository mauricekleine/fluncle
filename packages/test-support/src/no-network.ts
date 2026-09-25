function isLoopback(urlString: string): boolean {
  try {
    const { hostname } = new URL(urlString);

    return (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "::1" ||
      hostname === "[::1]" ||
      hostname === "0.0.0.0" ||
      hostname.endsWith(".localhost")
    );
  } catch {
    return true;
  }
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }

  if (input instanceof URL) {
    return input.href;
  }

  return input.url;
}

export const BLOCKED_PREFIX = "Blocked outbound request to";

export function blockedRequestMessage(url: string): string {
  return (
    `${BLOCKED_PREFIX} ${url} — tests must not reach the network. ` +
    `Mock the wrapper module for this integration, or stub global fetch in this file.`
  );
}

const RAIL_MARKER = "__fluncleNoNetworkRail";

export function installNoNetworkRail(): () => void {
  const realFetch = globalThis.fetch;

  const wrapped = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = requestUrl(input);

    if (isLoopback(url)) {
      return realFetch(input, init);
    }

    return Promise.reject(new Error(blockedRequestMessage(url)));
  }) as typeof globalThis.fetch;

  Object.defineProperty(wrapped, RAIL_MARKER, { value: true });
  globalThis.fetch = wrapped;

  return () => {
    globalThis.fetch = realFetch;
  };
}

export function isRailArmed(): boolean {
  return RAIL_MARKER in globalThis.fetch;
}

export function assertRailArmed(suiteName: string): void {
  if (!isRailArmed()) {
    throw new Error(
      `${suiteName}: the no-network rail is NOT armed — this suite can reach the internet. ` +
        "Check this package's bunfig.toml `[test] preload`.",
    );
  }

  console.log(`no-network rail armed: ${suiteName}`);
}
