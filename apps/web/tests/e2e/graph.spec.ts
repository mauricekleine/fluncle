// The GRAPH spec: the entity pages (`/artist/<slug>`, `/label/<slug>`, `/album/<slug>`) and
// the three hubs that keep them from being orphans (`/artists`, `/labels`, `/albums`).
//
// The graph is the point of these pages — log ↔ artist ↔ label ↔ album — so every test here
// walks an EDGE and proves it lands somewhere real: the link is in the SSR HTML, it is visible
// on the rendered page, and the URL it points at answers 200. A cross-link that renders but
// 404s is exactly the failure this suite exists to catch, and it is invisible to a unit test.
//
// The shape is `home.spec.ts`'s (see `tests/e2e/README.md`): SSR → identity → hydration →
// cleanliness. Identity comes from the SEEDED fixtures, never from counts or marketing copy.
//
// The seeded world: one finding wired into the full graph — the artist that made it, the label
// that pressed it, and the record it sits on all resolve through `SEEDED_GRAPH_FINDING`.

import { expect, test, type ConsoleMessage, type Page } from "@playwright/test";
import { blockExternalRequests } from "./browser";
import { SEEDED_GRAPH_ENTITIES, SEEDED_GRAPH_FINDING } from "./seed";

const { album, artist, label } = SEEDED_GRAPH_ENTITIES;
const LOG_HREF = `/log/${SEEDED_GRAPH_FINDING.logId}`;

/** Collect every console error + page error for a fail-on-any assertion at the end. */
function watchForErrors(page: Page): string[] {
  const problems: string[] = [];

  page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
  page.on("console", (message: ConsoleMessage) => {
    if (message.type() === "error") {
      problems.push(`console.error: ${message.text()}`);
    }
  });

  return problems;
}

/** Fetch a path with no rendering — the crawler's view — and assert it served 200. */
async function serverHtml(page: Page, path: string): Promise<string> {
  const response = await page.request.get(path);

  expect(response.status(), `${path} should serve 200`).toBe(200);

  return response.text();
}

/**
 * An EDGE of the graph, proven end to end: the link is in the server HTML (a crawler follows
 * it), it renders on the page, and the URL behind it resolves. All three, or the edge is dead.
 */
async function expectEdge(page: Page, html: string, href: string): Promise<void> {
  expect(html, `SSR HTML should link to ${href}`).toContain(`href="${href}"`);
  await expect(page.locator(`a[href="${href}"]`).first()).toBeVisible();
  expect((await page.request.get(href)).status(), `${href} should resolve`).toBe(200);
}

test("the artist page SSRs its findings and walks the edge to the log", async ({ page }) => {
  await blockExternalRequests(page);

  const problems = watchForErrors(page);
  const path = `/artist/${artist.slug}`;
  const html = await serverHtml(page, path);

  // (1) SSR + (2) identity — the artist's name and the seeded finding it made are already in
  // the server HTML, before any client JS runs.
  expect(html).toContain(artist.name);
  expect(html).toContain(SEEDED_GRAPH_FINDING.title);

  const response = await page.goto(path, { waitUntil: "networkidle" });
  expect(response?.status()).toBe(200);

  await expect(page.getByRole("heading", { level: 1 })).toHaveText(artist.name);

  // The edge back into the archive: the findings grid links each cover to its coordinate.
  await expectEdge(page, html, LOG_HREF);

  // (4) Cleanliness.
  expect(problems, `expected a clean console, saw:\n${problems.join("\n")}`).toEqual([]);
});

test("the label page SSRs its findings and walks the edges to the log and the artist", async ({
  page,
}) => {
  await blockExternalRequests(page);

  const problems = watchForErrors(page);
  const path = `/label/${label.slug}`;
  const html = await serverHtml(page, path);

  expect(html).toContain(label.name);
  expect(html).toContain(SEEDED_GRAPH_FINDING.title);

  const response = await page.goto(path, { waitUntil: "networkidle" });
  expect(response?.status()).toBe(200);

  await expect(page.getByRole("heading", { level: 1 })).toHaveText(label.name);

  // Two edges: down to the finding, and across to the artist whose banger this label pressed.
  await expectEdge(page, html, LOG_HREF);
  await expectEdge(page, html, `/artist/${artist.slug}`);

  expect(problems, `expected a clean console, saw:\n${problems.join("\n")}`).toEqual([]);
});

test("the album page walks its edges, opens a graph card, and logs no errors", async ({ page }) => {
  await blockExternalRequests(page);

  const problems = watchForErrors(page);
  const path = `/album/${album.slug}`;
  const html = await serverHtml(page, path);

  expect(html).toContain(album.name);
  expect(html).toContain(SEEDED_GRAPH_FINDING.title);

  const response = await page.goto(path, { waitUntil: "networkidle" });
  expect(response?.status()).toBe(200);

  await expect(page.getByRole("heading", { level: 1 })).toHaveText(album.name);

  // Three edges meet on the record: the finding, the artist chip, and the album → label uplink
  // that closes the graph (docs/album-entity.md).
  await expectEdge(page, html, LOG_HREF);
  await expectEdge(page, html, `/artist/${artist.slug}`);
  await expectEdge(page, html, `/label/${label.slug}`);

  // (3) Hydration — the graph link's hover card. It is the genuinely client-only half of the
  // graph: the LINK ships in the SSR HTML (asserted above), while the CARD is fetched lazily on
  // hover-intent, so a card that opens proves React took over. State-safe retry: each attempt
  // moves the pointer away and presses Escape to reset to a known CLOSED state first, so every
  // attempt reads "closed → hover → expect open" rather than toggling forever.
  const uplink = page.locator(`a[href="/label/${label.slug}"]`).first();
  const card = page.locator(".graph-card").first();

  await expect(async () => {
    await page.mouse.move(0, 0);
    await page.keyboard.press("Escape");
    await expect(card).toBeHidden({ timeout: 2000 });
    await uplink.hover();
    await expect(card).toBeVisible({ timeout: 4000 });
  }).toPass({ timeout: 30_000 });

  // The card carries the entity's own name — it previews the label the uplink points at, never
  // a placeholder.
  await expect(card).toContainText(label.name);

  expect(problems, `expected a clean console, saw:\n${problems.join("\n")}`).toEqual([]);
});

// The three hubs. They exist to make the entity pages reachable by internal link rather than by
// sitemap alone, so the assertion IS the edge: each hub lists the seeded entity and links to it.
for (const hub of [
  { entity: artist, href: `/artist/${artist.slug}`, path: "/artists" },
  { entity: label, href: `/label/${label.slug}`, path: "/labels" },
  { entity: album, href: `/album/${album.slug}`, path: "/albums" },
]) {
  test(`${hub.path} SSRs the seeded entity and links to its page`, async ({ page }) => {
    await blockExternalRequests(page);

    const problems = watchForErrors(page);
    const html = await serverHtml(page, hub.path);

    expect(html).toContain(hub.entity.name);

    const response = await page.goto(hub.path, { waitUntil: "networkidle" });
    expect(response?.status()).toBe(200);

    await expect(page.getByText(hub.entity.name, { exact: false }).first()).toBeVisible();
    await expectEdge(page, html, hub.href);

    expect(problems, `expected a clean console, saw:\n${problems.join("\n")}`).toEqual([]);
  });
}
