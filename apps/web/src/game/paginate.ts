export type CursorPage<T> = { items: T[]; nextCursor?: string };

export type CollectPagesOptions = {
  maxPages: number;
};

export async function collectPages<T>(
  fetchPage: (cursor: string | undefined) => Promise<CursorPage<T>>,
  options: CollectPagesOptions,
): Promise<T[]> {
  const items: T[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;

  for (let page = 0; page < options.maxPages; page++) {
    const result = await fetchPage(cursor);

    items.push(...result.items);

    const nextCursor = result.nextCursor;

    if (!nextCursor || seenCursors.has(nextCursor)) {
      break;
    }

    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }

  return items;
}
