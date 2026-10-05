import { type HubOrder } from "./hub-order";

export const INDEXED_PAGE_DEPTH = 5;

export function shouldNoindexPage(options: {
  nonDefaultSort?: boolean;
  page: number;
  upcomingPage?: number;
}): boolean {
  if (options.page > INDEXED_PAGE_DEPTH) {
    return true;
  }

  if (options.nonDefaultSort === true) {
    return true;
  }

  if (options.upcomingPage !== undefined && options.upcomingPage > 1) {
    return true;
  }

  return false;
}

export function pagedCanonical(base: string, page: number): string {
  return page <= 1 ? base : `${base}?page=${page}`;
}

export function formatNameRange(
  firstName: string | undefined,
  lastName: string | undefined,
): string {
  if (firstName === undefined || lastName === undefined) {
    return "";
  }

  if (firstName === lastName) {
    return firstName;
  }

  return `${firstName} to ${lastName}`;
}

export function formatNameList(names: string[], remaining: number): string {
  if (names.length === 0) {
    return "";
  }

  const listed = names.join(", ");

  if (remaining <= 0) {
    return listed;
  }

  return `${listed} and ${remaining} more`;
}

export function formatHubTitleSnippet(names: string[], order: HubOrder): string {
  if (names.length === 0) {
    return "";
  }

  if (order === "az") {
    return formatNameRange(names[0], names[names.length - 1]);
  }

  const head = names.slice(0, 2).join(", ");

  return names.length > 2 ? `${head} and more` : head;
}

const ISO_DATE_RE = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/;

export function isDatedRelease(dateStr: string): boolean {
  const match = ISO_DATE_RE.exec(dateStr);
  if (match === null) {
    return false;
  }

  const year = Number(match[1]);
  const month = match[2] !== undefined ? Number(match[2]) : 1;
  const day = match[3] !== undefined ? Number(match[3]) : 1;

  const date = new Date(Date.UTC(year, month - 1, day));

  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

function formatDateLabel(dateStr: string): string {
  if (/^\d{4}$/.test(dateStr)) {
    return dateStr;
  }

  const date = new Date(dateStr);
  const month = date.toLocaleString("en-US", { month: "long", timeZone: "UTC" });
  const year = date.getUTCFullYear();

  return `${month} ${year}`;
}

export function formatReleaseSpan(
  earliest: string | undefined,
  latest: string | undefined,
): string {
  const validEarliest = earliest !== undefined && isDatedRelease(earliest) ? earliest : undefined;
  const validLatest = latest !== undefined && isDatedRelease(latest) ? latest : undefined;

  if (validEarliest === undefined && validLatest === undefined) {
    return "";
  }

  if (validEarliest === undefined || validLatest === undefined) {
    const single = validEarliest ?? validLatest;

    return single ? `released ${formatDateLabel(single)}` : "";
  }

  const earliestFormatted = formatDateLabel(validEarliest);
  const latestFormatted = formatDateLabel(validLatest);

  if (earliestFormatted === latestFormatted) {
    return `released ${earliestFormatted}`;
  }

  return `released ${earliestFormatted} to ${latestFormatted}`;
}
