type HopFetchResponse = { readonly url: string };
export type HopFetcher = (url: string) => Promise<HopFetchResponse>;

const HOP_HOSTS = new Set(["fluncle.com", "www.fluncle.com"]);
const HOP_PATH_PREFIX = "/out/";

const HTTP_URL = /^(https?):\/\/([^/?#]*)([^?#]*)/i;

type ParsedUrl = { readonly host: string; readonly path: string };

function parseHttpUrl(url: string): ParsedUrl | undefined {
  if (typeof url !== "string") {
    return undefined;
  }
  const match = HTTP_URL.exec(url.trim());
  if (!match) {
    return undefined;
  }

  const authority = match[2] ?? "";

  const hostAndPort = authority.slice(authority.lastIndexOf("@") + 1);
  const host = hostAndPort.replace(/:\d*$/, "").toLowerCase();
  if (!host) {
    return undefined;
  }

  const path = match[3] === "" ? "/" : match[3];
  return { host, path };
}

export function isHttpUrl(url: string): boolean {
  return parseHttpUrl(url) !== undefined;
}

export function isHopUrl(url: string): boolean {
  const parsed = parseHttpUrl(url);
  if (!parsed) {
    return false;
  }
  return HOP_HOSTS.has(parsed.host) && parsed.path.startsWith(HOP_PATH_PREFIX);
}

export async function resolveHopUrl(url: string, fetcher: HopFetcher): Promise<string> {
  try {
    const response = await fetcher(url);
    const final = typeof response?.url === "string" ? response.url.trim() : "";
    if (!final) {
      return url;
    }
    if (!isHttpUrl(final)) {
      return url;
    }

    if (isHopUrl(final)) {
      return url;
    }
    return final;
  } catch {
    return url;
  }
}

export async function openTarget(url: string, fetcher: HopFetcher): Promise<string> {
  if (!isHopUrl(url)) {
    return url;
  }
  return await resolveHopUrl(url, fetcher);
}
