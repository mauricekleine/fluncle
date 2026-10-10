export async function loadRowsUntil<T>(
  initialRows: T[],
  loadNextPage: () => Promise<T[] | undefined>,
  matches: (row: T) => boolean,
): Promise<T[]> {
  const rows = [...initialRows];

  while (!rows.some(matches)) {
    const nextPage = await loadNextPage();

    if (!nextPage?.length) {
      break;
    }

    rows.push(...nextPage);
  }

  return rows;
}
