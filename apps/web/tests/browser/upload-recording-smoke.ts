// Browser proof for the admin recording uploader (docs/admin-shell.md §Verifying). Drives
// the REAL "Upload recording" dialog on /admin/clips as the operator (loginAsAdmin), across
// three scenarios: a multi-part happy path, a per-part retry (an injected transient drop),
// and a cancel (proving no phantom recording is left behind). Fails on any console/page error.
//
// The R2 legs point at an INLINE mock that speaks R2's real multipart + CORS contract
// (PUT part → 200 + an exposed `ETag`; POST complete → 200; DELETE abort → 204), so the proof
// exercises the true cross-origin ETag-read path WITHOUT ever touching the prod fluncle-videos
// bucket: `page.route` fulfills the same-origin presign with mock URLs, and `create_recording`
// still writes the real (local dev) DB so the shelf-without-reload refetch is real too.
//
//   BASE_URL=http://127.0.0.1:3100 OUT_DIR=./wave1-upload MOCK_PORT=4199 \
//     SIZE_BYTES=52428800 bun tests/browser/upload-recording-smoke.ts
//
// SIZE_BYTES defaults to 50MB (4 parts). Set it to a few GB for the memory-safety proof —
// the file is streamed to disk and only ever sliced (File.slice), never read whole.

import { createWriteStream, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Page } from "playwright-core";
import { launchBrowser, newAdminPage } from "./admin";

const BASE_URL = process.env.BASE_URL ?? "http://127.0.0.1:3100";
const OUT_DIR = process.env.OUT_DIR ?? join(process.cwd(), "wave1-upload");
const MOCK_PORT = Number(process.env.MOCK_PORT ?? "4199");
const SIZE_BYTES = Number(process.env.SIZE_BYTES ?? String(50 * 1024 * 1024));
const MOCK_ORIGIN = `http://127.0.0.1:${MOCK_PORT}`;

// The mock's per-part delay makes a multi-part upload take a visible moment (so a mid-flight
// screenshot lands on a real in-between state) and gives the cancel a window to fire.
const PART_DELAY_MS = Number(process.env.PART_DELAY_MS ?? "150");

// Which scenarios to run — A (happy path, uses SIZE_BYTES), B (retry), C (cancel). Default
// all three. For the multi-GB memory proof run just `SCENARIOS=A SIZE_BYTES=2147483648`; B and
// C are size-independent and always use a small file, so they never bottleneck a big run.
const SCENARIOS = new Set((process.env.SCENARIOS ?? "A,B,C").split(",").map((name) => name.trim()));
const SMALL_BYTES = 40 * 1024 * 1024;

type MockControl = { failPartOnce: number | null; failedOnce: Set<number> };

// ── The inline mock R2: real multipart + CORS/ETag contract ──────────────────────
function startMockR2(control: MockControl) {
  const cors: Record<string, string> = {
    "access-control-allow-headers": "*",
    "access-control-allow-methods": "PUT, POST, DELETE, GET, HEAD, OPTIONS",
    "access-control-allow-origin": "*",
    "access-control-expose-headers": "ETag",
    "access-control-max-age": "86400",
  };

  return Bun.serve({
    async fetch(request) {
      const url = new URL(request.url);

      if (request.method === "OPTIONS") {
        return new Response(null, { headers: cors, status: 204 });
      }

      if (request.method === "PUT" && url.pathname === "/part") {
        const partNumber = Number(url.searchParams.get("n") ?? "0");

        // Drain the slice so the socket completes (bounded — one 16MB part at a time).
        await request.arrayBuffer();

        // Injected transient drop: fail this part's FIRST attempt with a 503, succeed after.
        if (control.failPartOnce === partNumber && !control.failedOnce.has(partNumber)) {
          control.failedOnce.add(partNumber);

          return new Response("try again", { headers: cors, status: 503 });
        }

        await Bun.sleep(PART_DELAY_MS);

        return new Response(null, {
          headers: { ...cors, etag: `"mock-etag-${partNumber}"` },
          status: 200,
        });
      }

      if (request.method === "POST" && url.pathname === "/complete") {
        await request.text();

        return new Response(
          "<CompleteMultipartUploadResult><Key>mock</Key></CompleteMultipartUploadResult>",
          { headers: { ...cors, "content-type": "application/xml" }, status: 200 },
        );
      }

      if (request.method === "DELETE" && url.pathname === "/abort") {
        return new Response(null, { headers: cors, status: 204 });
      }

      return new Response("not found", { headers: cors, status: 404 });
    },
    port: MOCK_PORT,
  });
}

// Fulfill the same-origin presign with mock-pointed URLs (so prod R2 is never opened).
async function routePresign(page: Page): Promise<void> {
  await page.route("**/set-video/presign", async (route) => {
    const request = route.request();
    const match = request.url().match(/recordings\/([^/]+)\/set-video/);
    const recordingId = match ? decodeURIComponent(match[1]) : "unknown";
    const body = JSON.parse(request.postData() ?? "{}") as { partCount?: number };
    const partCount = body.partCount ?? 1;
    const parts = Array.from({ length: partCount }, (_unused, index) => ({
      partNumber: index + 1,
      url: `${MOCK_ORIGIN}/part?n=${index + 1}`,
    }));

    await route.fulfill({
      body: JSON.stringify({
        abortUrl: `${MOCK_ORIGIN}/abort`,
        completeUrl: `${MOCK_ORIGIN}/complete`,
        key: `recordings/${recordingId}/set.mp4`,
        ok: true,
        parts,
        recordingId,
        uploadId: "mock-upload-id",
      }),
      contentType: "application/json",
      status: 200,
    });
  });
}

// Stream a file of `size` zero-bytes to disk in bounded 4MB chunks (never a whole-file buffer).
async function makeFile(path: string, size: number): Promise<void> {
  const chunk = Buffer.alloc(4 * 1024 * 1024);
  const stream = createWriteStream(path);
  let written = 0;

  while (written < size) {
    const slice = Math.min(chunk.length, size - written);
    const ok = stream.write(slice === chunk.length ? chunk : chunk.subarray(0, slice));

    written += slice;

    if (!ok) {
      await new Promise((resolve) => stream.once("drain", resolve));
    }
  }

  await new Promise<void>((resolve, reject) =>
    stream.end((error: unknown) => (error ? reject(error) : resolve())),
  );
}

function fmtGB(bytes: number): string {
  return `${(bytes / 1_000_000_000).toFixed(2)} GB`;
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });

  const control: MockControl = { failPartOnce: null, failedOnce: new Set() };
  const server = startMockR2(control);
  const filePath = join(tmpdir(), `fluncle-upload-proof-${Date.now()}.mp4`);
  const smallPath = join(tmpdir(), `fluncle-upload-small-${Date.now()}.mp4`);

  console.log(`Generating masters — A: ${fmtGB(SIZE_BYTES)}, B/C: ${fmtGB(SMALL_BYTES)}…`);
  if (SCENARIOS.has("A")) {
    await makeFile(filePath, SIZE_BYTES);
  }
  if (SCENARIOS.has("B") || SCENARIOS.has("C")) {
    await makeFile(smallPath, SMALL_BYTES);
  }

  const browser = await launchBrowser({ headless: true });
  const { context, page } = await newAdminPage(browser, BASE_URL, { height: 900, width: 1280 });

  const consoleErrors: string[] = [];
  // Scenario B injects a 503 on part 2's first attempt; Chromium logs that failed resource as
  // a console error. It is the point of the test — not a defect — so it is not counted.
  const isExpected = (text: string) => /503|Service Unavailable/i.test(text);

  page.on("console", (message) => {
    if (message.type() === "error" && !isExpected(message.text())) {
      consoleErrors.push(message.text());
    }
  });
  page.on("pageerror", (error) => consoleErrors.push(String(error)));

  await routePresign(page);

  const failures: string[] = [];
  // Retry the trigger click until the dialog opens — a click before hydration doesn't register
  // (the shell-smoke "retry until a click sticks" discipline, docs/admin-shell.md §Verifying).
  const openDialog = async () => {
    const heading = page.getByRole("heading", { name: "Upload a recording" });

    for (let attempt = 0; attempt < 10; attempt += 1) {
      await page.getByRole("button", { name: "Upload recording" }).click();

      try {
        await heading.waitFor({ state: "visible", timeout: 1500 });

        return;
      } catch {
        await page.waitForTimeout(500);
      }
    }

    throw new Error("the Upload recording dialog never opened (hydration?)");
  };
  const shelfHasTitle = (title: string) =>
    page
      .getByRole("link", { name: title })
      .first()
      .isVisible()
      .catch(() => false);

  try {
    await page.goto(`${BASE_URL}/admin/clips`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Upload recording" }).waitFor({ state: "visible" });

    // ── Scenario A — the multi-part happy path (uses the SIZE_BYTES master) ──────
    if (SCENARIOS.has("A")) {
      console.log(`Scenario A: happy path (${fmtGB(SIZE_BYTES)})…`);
      await openDialog();
      await page.screenshot({ path: join(OUT_DIR, "01-dialog-idle.png") });
      await page.setInputFiles('input[type="file"]', filePath);

      // The title auto-fills from the file name; tag it so the shelf assertion is unambiguous.
      const titleA = `Proof set A ${Date.now()}`;
      await page.fill("#recording-title", titleA);
      await page.getByRole("button", { exact: true, name: "Upload" }).click();

      // Mid-flight: wait until a middle part so the bar shows real, visible fill (part 1 sits
      // at 0%), then screenshot a true in-between state.
      await page.getByText(/part \d+ of \d+/).waitFor({ state: "visible" });
      await page
        .getByText(/part ([2-9]|\d\d+) of \d+/)
        .waitFor({ state: "visible" })
        .catch(() => {});
      await page.screenshot({ path: join(OUT_DIR, "02-uploading-midflight.png") });

      await page.getByText("is staged").waitFor({ state: "visible", timeout: 300_000 });
      await page.screenshot({ path: join(OUT_DIR, "03-done.png") });
      await page.getByRole("button", { name: "Done" }).click();

      if (!(await shelfHasTitle(titleA))) {
        failures.push("A: the uploaded recording did not appear in the shelf without reload");
      } else {
        console.log("A: recording is in the shelf (no reload). OK");
      }
      await page.screenshot({ path: join(OUT_DIR, "04-shelf-after.png") });
    }

    // ── Scenario B — a dropped part retries and recovers (small master) ──────────
    if (SCENARIOS.has("B")) {
      console.log("Scenario B: injected part-2 drop → retry…");
      control.failPartOnce = 2;
      control.failedOnce.clear();
      await openDialog();
      await page.setInputFiles('input[type="file"]', smallPath);
      const titleB = `Proof set B ${Date.now()}`;
      await page.fill("#recording-title", titleB);
      await page.getByRole("button", { exact: true, name: "Upload" }).click();
      // The upload must still reach "staged" despite the injected drop.
      await page.getByText("is staged").waitFor({ state: "visible", timeout: 120_000 });
      console.log("B: upload recovered from the injected drop and completed. OK");
      await page.getByRole("button", { name: "Done" }).click();
      control.failPartOnce = null;
    }

    // ── Scenario C — cancel mid-upload leaves NO phantom recording (small master) ─
    if (SCENARIOS.has("C")) {
      console.log("Scenario C: cancel mid-upload → no phantom recording…");
      await openDialog();
      await page.setInputFiles('input[type="file"]', smallPath);
      const titleC = `Proof set C ${Date.now()}`;
      await page.fill("#recording-title", titleC);
      await page.getByRole("button", { exact: true, name: "Upload" }).click();
      await page.getByText(/part \d+ of \d+/).waitFor({ state: "visible" });
      await page.getByRole("button", { name: "Cancel upload" }).click();
      // Back to a clean picker (idle) — the Upload button returns.
      await page.getByRole("button", { exact: true, name: "Upload" }).waitFor({ state: "visible" });
      // Close the dialog (now allowed — not uploading) and confirm the cancelled recording is
      // NOT in the shelf (its row was dropped, so no phantom remains).
      await page.keyboard.press("Escape");
      await page.waitForTimeout(500);

      if (await shelfHasTitle(titleC)) {
        failures.push("C: a cancelled upload left a phantom recording in the shelf");
      } else {
        console.log("C: cancelled upload left no recording behind. OK");
      }
    }
  } finally {
    await context.close();
    await browser.close();
    await server.stop(true);
    rmSync(filePath, { force: true });
    rmSync(smallPath, { force: true });
  }

  if (consoleErrors.length > 0) {
    failures.push(`console/page errors:\n  ${consoleErrors.join("\n  ")}`);
  }

  if (failures.length > 0) {
    console.error(`\nupload-recording-smoke FAILED:\n- ${failures.join("\n- ")}`);
    process.exit(1);
  }

  console.log(`\nupload-recording-smoke: all scenarios passed. Screenshots in ${OUT_DIR}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
