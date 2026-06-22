// A bounded, cycle-guarded cursor paginator. The Galaxy catalogue load walks
// every page until the cursor runs out — but a misbehaving endpoint (a
// non-advancing or repeating cursor) must not hang the browser in an endless
// fetch loop. This collects pages until there's no next cursor, the cursor
// repeats, or a hard page cap is hit, whichever comes first.

export type CursorPage<T> = { items: T[]; nextCursor?: string };

export type CollectPagesOptions = {
  /** Hard cap on pages fetched, so a non-advancing cursor can't loop forever. */
  maxPages: number;
};

/**
 * Fetch and concatenate cursor-paginated items, stopping when the endpoint runs
 * out of pages, repeats a cursor (cycle), or hits `maxPages`. `fetchPage` is
 * called with `undefined` for the first page, then each returned `nextCursor`.
 */
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
