type EntityRow = { name: string; trackCount: number };

type PageInfo = { page: number; pageCount: number; total: number };

type Noun = { plural: string; singular: string };

const NAME_WIDTH = 40;

function entityRow(item: EntityRow): string {
  const count = `${item.trackCount} track${item.trackCount === 1 ? "" : "s"}`;

  return `${item.name.padEnd(NAME_WIDTH)}  ${count}`;
}

export function printEntityIndex(
  items: EntityRow[],
  page: PageInfo,
  noun: Noun,
  command: string,
): void {
  if (items.length === 0) {
    if (page.total === 0) {
      console.log(`No ${noun.plural} in the archive yet.`);
      return;
    }

    console.log(
      `Nothing on page ${page.page}. The archive holds ${page.total} ${noun.plural} across ${page.pageCount} pages.`,
    );
    return;
  }

  for (const item of items) {
    console.log(entityRow(item));
  }

  if (page.pageCount > 1) {
    const more =
      page.page < page.pageCount ? ` More with: fluncle ${command} --page ${page.page + 1}` : "";
    console.log("");
    console.log(`Page ${page.page} of ${page.pageCount}, ${page.total} ${noun.plural}.${more}`);
  }
}

export function entityDetailLines(
  name: string,
  slug: string,
  trackCount: number,
  findingCount: number,
): string[] {
  return [`${name}  (${slug})`, `Tracks: ${trackCount}`, `Findings: ${findingCount}`];
}
