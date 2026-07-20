// Shared rendering for the catalogue-index CLI commands (`artists`, `albums`,
// `labels`). All three read the same `{ ok, <items>, page, pageCount, total }`
// envelope off their `list_*` op and render the same alphabetical shelf, so the
// row shape, the empty state, and the page footer live here once.
//
// The register is catalogue reference (VOICE.md §5): plain, no cosmos. A row
// shows a name and a bare track count — never a certified/tier marker, since the
// Unlit Rule keeps that distinction off the row (a certified entity has no
// coordinate of its own to show; `--json` carries `certified` and the finding
// count for anyone who needs them).

// One entity per line: its name, then how many renderable tracks sit under it.
// The name column is padded so the counts align down the shelf.
type EntityRow = { name: string; trackCount: number };

// The 1-based page position the `list_*` envelope carries, for the footer.
type PageInfo = { page: number; pageCount: number; total: number };

// The singular/plural nouns for a kind, used in the empty state and footer.
type Noun = { plural: string; singular: string };

const NAME_WIDTH = 40;

function entityRow(item: EntityRow): string {
  const count = `${item.trackCount} track${item.trackCount === 1 ? "" : "s"}`;

  return `${item.name.padEnd(NAME_WIDTH)}  ${count}`;
}

/**
 * Print one page of a catalogue index — the rows, then a footer when the list
 * runs past one page. `command` is the bare CLI verb (`artists`), used to spell
 * the "next page" hint. Empty is handled two ways: an empty archive says so,
 * while an empty page past the end points back at how many there really are.
 */
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

/**
 * The shared head of an entity detail read: the name + slug line and the two
 * counts. `trackCount` is every renderable track; `findingCount` is how many
 * of those Fluncle certified. A caller appends its own kind-specific lines
 * (an album's release date, a label's home) after these.
 */
export function entityDetailLines(
  name: string,
  slug: string,
  trackCount: number,
  findingCount: number,
): string[] {
  return [`${name}  (${slug})`, `Tracks: ${trackCount}`, `Findings: ${findingCount}`];
}
