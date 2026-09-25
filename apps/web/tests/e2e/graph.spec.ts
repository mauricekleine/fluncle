import { expect, test, type ConsoleMessage, type Page } from "@playwright/test";
import { blockExternalRequests } from "./browser";
import { SEEDED_GRAPH_ENTITIES, SEEDED_GRAPH_FINDING } from "./seed";

const { album, artist, label } = SEEDED_GRAPH_ENTITIES;
const LOG_HREF = `/log/${SEEDED_GRAPH_FINDING.logId}`;

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

async function serverHtml(page: Page, path: string): Promise<string> {
  const response = await page.request.get(path);

  expect(response.status(), `${path} should serve 200`).toBe(200);

  return response.text();
}

async function expectEdge(page: Page, html: string, href: string): Promise<void> {
  expect(html, `SSR HTML should link to ${href}`).toContain(`href="${href}"`);
  await expect(page.locator(`a[href="${href}"]`).first()).toBeVisible();
  await expect(async () => {
    expect((await page.request.get(href)).status(), `${href} should resolve`).toBe(200);
  }).toPass({ intervals: [250, 500, 1000], timeout: 10_000 });
}

test("the artist page SSRs its findings and walks the edge to the log", async ({ page }) => {
  await blockExternalRequests(page);

  const problems = watchForErrors(page);
  const path = `/artist/${artist.slug}`;
  const html = await serverHtml(page, path);

  expect(html).toContain(artist.name);
  expect(html).toContain(SEEDED_GRAPH_FINDING.title);

  const response = await page.goto(path, { waitUntil: "networkidle" });
  expect(response?.status()).toBe(200);

  await expect(page.getByRole("heading", { level: 1 })).toHaveText(artist.name);

  await expectEdge(page, html, LOG_HREF);

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

  await expectEdge(page, html, LOG_HREF);
  await expectEdge(page, html, `/artist/${artist.slug}`);
  await expectEdge(page, html, `/label/${label.slug}`);

  const uplink = page.locator(`a[href="/label/${label.slug}"]`).first();
  const card = page.locator(".graph-card").first();

  await expect(async () => {
    await page.mouse.move(0, 0);
    await page.keyboard.press("Escape");
    await expect(card).toBeHidden({ timeout: 2000 });
    await uplink.hover();
    await expect(card).toBeVisible({ timeout: 4000 });
  }).toPass({ timeout: 30_000 });

  await expect(card).toContainText(label.name);

  expect(problems, `expected a clean console, saw:\n${problems.join("\n")}`).toEqual([]);
});

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
