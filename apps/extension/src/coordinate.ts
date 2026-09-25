export const COORDINATE_PATTERN = /fluncle:\/\/(\d{3,4}\.(?:\d\.\d[A-Z]|F\.\d[A-F]))(?![0-9A-Z])/gi;

export type Coordinate = {
  id: string;

  raw: string;
};

export function findCoordinates(text: string): Coordinate[] {
  const found: Coordinate[] = [];
  const seen = new Set<string>();

  for (const match of text.matchAll(COORDINATE_PATTERN)) {
    const id = match[1];

    if (id && !seen.has(id)) {
      seen.add(id);
      found.push({ id, raw: match[0] });
    }
  }

  return found;
}

export function webUrl(id: string): string {
  return `https://www.fluncle.com/log/${id.toUpperCase()}`;
}

export function apiUrl(id: string): string {
  return `https://www.fluncle.com/api/v1/tracks/${id.toUpperCase()}`;
}

export function digCommand(id: string): string {
  return `dig ${id.toLowerCase()}.dig.fluncle.com TXT +short`;
}

export function sshCommand(id: string): string {
  return `ssh rave.fluncle.com ${id}`;
}

export function safeHref(href: string | undefined, id: string): string {
  if (href) {
    try {
      if (new URL(href).protocol === "https:") {
        return href;
      }
    } catch {}
  }

  return webUrl(id);
}
