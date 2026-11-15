import { slugify } from "@fluncle/contracts/util/galaxy-slug";
import { TRACK_ID_PATTERN } from "./track-id-pattern";

export function isMalformedEntityPagePath(pathname: string): boolean {
  const match = /^\/(album|artist|label|track)\/(.*)$/.exec(pathname);

  if (!match) {
    return false;
  }

  let value: string;

  try {
    value = decodeURIComponent((match[2] ?? "").replace(/\/$/, ""));
  } catch {
    return true;
  }

  if (/[/=:]|https/i.test(value)) {
    return true;
  }

  if (match[1] === "track") {
    return !TRACK_ID_PATTERN.test(value);
  }

  if ((match[1] === "artist" || match[1] === "label") && value.endsWith(".fresh.xml")) {
    value = value.slice(0, -10);
  }

  return !value || slugify(value) !== value;
}
