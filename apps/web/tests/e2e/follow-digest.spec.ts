import { type Client, createClient } from "@libsql/client";
import { expect, test } from "@playwright/test";
import { LOCAL_DB_CONCURRENCY } from "../../src/lib/database-concurrency";
import { blockExternalRequests } from "./browser";
import { capturedEmails } from "./fake-resend";
import { BASE_URL, LIBSQL_URL } from "./stack";

const ARTIST = { id: "e2e-artist-digest", name: "Harbour Static", slug: "harbour-static" };
const TRACK = { id: "e2e-track-digest", title: "Low Tide Protocol" };
const API_TOKEN = "e2e-fake-api-token";

let db: Client;

function yesterdayUtc(): string {
  return new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

test.beforeAll(async () => {
  db = createClient({
    authToken: "e2e-local",
    concurrency: LOCAL_DB_CONCURRENCY,
    url: LIBSQL_URL,
  });

  const now = new Date().toISOString();

  await db.batch([
    {
      args: [ARTIST.id, ARTIST.name, ARTIST.slug, now, now],
      sql: `insert or ignore into artists (id, name, slug, created_at, updated_at) values (?, ?, ?, ?, ?)`,
    },
    {
      args: [
        TRACK.id,
        TRACK.title,
        JSON.stringify([ARTIST.name]),
        `spotify:track:${TRACK.id}`,
        `https://open.spotify.com/track/${TRACK.id}`,
        yesterdayUtc(),
        "https://found.fluncle.com/e2e/digest-cover.jpg",
      ],
      sql: `insert or ignore into tracks
        (track_id, title, artists_json, spotify_uri, spotify_url, duration_ms, is_catalogue, release_date, album_image_url)
        values (?, ?, ?, ?, ?, 250000, 1, ?, ?)`,
    },
    {
      args: [TRACK.id, ARTIST.id],
      sql: `insert or ignore into track_artists (track_id, artist_id, position) values (?, ?, 0)`,
    },
  ]);
});

test.afterAll(async () => {
  await db.batch([
    { args: [ARTIST.id], sql: `delete from user_watches where kind = 'artist' and entity_id = ?` },
    { args: [TRACK.id], sql: `delete from track_artists where track_id = ?` },
    { args: [TRACK.id], sql: `delete from tracks where track_id = ?` },
    { args: [ARTIST.id], sql: `delete from artists where id = ?` },
  ]);
  db.close();
});

async function sendDigests(request: import("@playwright/test").APIRequestContext) {
  const response = await request.post("/api/v1/admin/follow-digests/send", {
    data: {},
    headers: { Authorization: `Bearer ${API_TOKEN}`, "Content-Type": "application/json" },
  });

  expect(response.ok(), await response.text()).toBe(true);

  return (await response.json()) as { paused: boolean; sent: number };
}

test("Dave follows an artist with one email and gets the Friday digest, once, and can stop it", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await blockExternalRequests(page);

  const email = `e2e_digest_${Date.now()}@example.invalid`;

  await page.goto(`/artist/${ARTIST.slug}`, { waitUntil: "networkidle" });

  const popover = page.getByRole("dialog", { name: `Follow ${ARTIST.name}` });

  await expect(async () => {
    if (await popover.isVisible()) {
      return;
    }

    await page.getByRole("button", { exact: true, name: `Follow ${ARTIST.name}` }).click();
    await expect(popover).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 60_000 });

  await popover.getByLabel("Email", { exact: true }).fill(email);
  await popover.getByRole("button", { name: "Email me a link" }).click();
  await expect(popover.getByTestId("magic-link-sent")).toBeVisible();

  let link = "";

  await expect(async () => {
    const [signIn] = await capturedEmails(email);

    link = signIn?.text.match(/https?:\/\/\S+magic-link\/verify\S+/)?.[0] ?? "";
    expect(link).toBeTruthy();
  }).toPass({ timeout: 15_000 });

  await page.goto(link, { waitUntil: "networkidle" });
  await expect(
    page.getByRole("button", { exact: true, name: `Following ${ARTIST.name}` }),
  ).toBeVisible({ timeout: 30_000 });

  const first = await sendDigests(page.request);

  expect(first.paused).toBe(false);
  expect(first.sent).toBeGreaterThanOrEqual(1);

  const digests = (await capturedEmails(email)).filter((message) =>
    message.subject.includes("artists and labels you follow"),
  );

  expect(digests).toHaveLength(1);

  const [digest] = digests;

  expect(digest?.html).toContain(TRACK.title);
  expect(digest?.html).toContain(`https://www.fluncle.com/track/${TRACK.id}`);
  expect(digest?.html).toContain("https://found.fluncle.com/e2e/digest-cover.jpg");
  expect(digest?.text).toContain(`You follow ${ARTIST.name}`);
  expect(digest?.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");

  const again = await sendDigests(page.request);

  expect(again.sent).toBe(0);
  expect(
    (await capturedEmails(email)).filter((message) =>
      message.subject.includes("artists and labels you follow"),
    ),
  ).toHaveLength(1);

  const manage = digest?.text.match(/https:\/\/www\.fluncle\.com\/follows\?token=\S+/)?.[0] ?? "";

  expect(manage).toBeTruthy();

  await page.goto(manage.replace("https://www.fluncle.com", BASE_URL), {
    waitUntil: "networkidle",
  });
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Your follows email");
  await expect(page.getByRole("link", { exact: true, name: ARTIST.name })).toBeVisible();

  const stop = page.getByRole("button", { name: "Stop the follows email" });

  await expect(async () => {
    if (await page.getByRole("button", { name: "Start the follows email" }).isVisible()) {
      return;
    }

    await stop.click();
    await expect(page.getByRole("button", { name: "Start the follows email" })).toBeVisible({
      timeout: 5000,
    });
  }).toPass({ timeout: 60_000 });

  const unsubscribeHeader = digest?.headers["List-Unsubscribe"] ?? "";
  const unsubscribeUrl = unsubscribeHeader
    .replace(/^<|>$/g, "")
    .replace("https://www.fluncle.com", BASE_URL);
  const oneClick = await page.request.post(unsubscribeUrl, {
    form: { "List-Unsubscribe": "One-Click" },
  });

  expect(oneClick.ok(), await oneClick.text()).toBe(true);

  await page.goto(unsubscribeUrl, { waitUntil: "networkidle" });
  await expect(page).toHaveURL(/\/follows\?unsubscribe=/);
  await expect(page.getByRole("button", { name: "Stop the follows email" })).toBeVisible();
});
