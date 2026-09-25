import oxanium400 from "./fonts/oxanium-400.ttf?inline";
import oxanium800 from "./fonts/oxanium-800.ttf?inline";
import spaceGrotesk400 from "./fonts/space-grotesk-400.ttf?inline";
import spaceGrotesk700 from "./fonts/space-grotesk-700.ttf?inline";

export const BRAND = "'Oxanium'";
export const BODY = "'Space Grotesk'";

export const OG_CACHE_CONTROL =
  "public, max-age=86400, s-maxage=604800, stale-while-revalidate=604800";

export type OgFont = {
  data: ArrayBuffer;
  name: string;
  style: "normal";
  weight: 400 | 700 | 800;
};

type FontSpec = {
  dataUri: string;
  name: string;
  weight: 400 | 700 | 800;
};

const OXANIUM: FontSpec[] = [
  { dataUri: oxanium400, name: "Oxanium", weight: 400 },
  { dataUri: oxanium800, name: "Oxanium", weight: 800 },
];

const SPACE_GROTESK: FontSpec[] = [
  { dataUri: spaceGrotesk400, name: "Space Grotesk", weight: 400 },
  { dataUri: spaceGrotesk700, name: "Space Grotesk", weight: 700 },
];

const decoded = new Map<string, ArrayBuffer>();

function toFont({ dataUri, name, weight }: FontSpec): OgFont {
  const key = `${name}:${weight}`;
  const cached = decoded.get(key);

  if (cached) {
    return { data: cached, name, style: "normal", weight };
  }

  const buffer = Buffer.from(dataUri.slice(dataUri.indexOf(",") + 1), "base64");
  const data = buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  ) as ArrayBuffer;

  decoded.set(key, data);

  return { data, name, style: "normal", weight };
}

export function brandFonts(): OgFont[] {
  return OXANIUM.map(toFont);
}

export function cardFonts(): OgFont[] {
  return [...OXANIUM, ...SPACE_GROTESK].map(toFont);
}

export const MAX_INLINE_IMAGE_BYTES = 10_000_000;

async function readBoundedBody(response: Response): Promise<undefined | Uint8Array> {
  const declared = Number(response.headers.get("content-length"));

  if (Number.isFinite(declared) && declared > MAX_INLINE_IMAGE_BYTES) {
    return undefined;
  }

  const body = response.body;

  if (!body) {
    return undefined;
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  for (;;) {
    const chunk = await reader.read();

    if (chunk.done || !chunk.value) {
      break;
    }

    total += chunk.value.byteLength;

    if (total > MAX_INLINE_IMAGE_BYTES) {
      await reader.cancel();

      return undefined;
    }

    chunks.push(chunk.value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return bytes;
}

export async function fetchImageDataUri(
  url: string,
  fallbackContentType = "image/jpeg",
): Promise<string | undefined> {
  try {
    const response = await fetch(url);

    if (!response.ok) {
      return undefined;
    }

    const contentType = response.headers.get("content-type") ?? fallbackContentType;
    const bytes = await readBoundedBody(response);

    if (!bytes) {
      return undefined;
    }

    return `data:${contentType};base64,${Buffer.from(bytes).toString("base64")}`;
  } catch {
    return undefined;
  }
}

export function satoriText(value: string): string {
  return value.replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
