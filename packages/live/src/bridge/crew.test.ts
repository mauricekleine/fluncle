// The crew wall: the store's gates and rails, and the HTTP surface driven with real
// `Request` objects (no socket, no bridge boot). The load-bearing guarantees are the ones a
// stranger on the room's WiFi can reach, so they are tested from that side: what the sniffer
// refuses, what the caps refuse, that a pending logo is INVISIBLE to the wall until the
// operator approves it, and that nothing an uploader sends can throw.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { CREW_MAX_BYTES } from "../contract";
import { CREW_HTML, CREW_MODERATE_HTML, CREW_WALL_HTML } from "./crew-page";
import {
  createCrewRouter,
  createCrewStore,
  createRateLimiter,
  crewAutoApprove,
  type CrewStore,
  normalizeLabel,
  resolveCrewDir,
  rollOrder,
  sniffImage,
} from "./crew";
import { mulberry32 } from "./vj";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 9]);
const GIF = new Uint8Array([...new TextEncoder().encode("GIF89a"), 7, 7]);
const WEBP = new Uint8Array([
  ...new TextEncoder().encode("RIFF"),
  0,
  0,
  0,
  0,
  ...new TextEncoder().encode("WEBP"),
]);
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>');

const dirs: string[] = [];

/** A fresh store in a throwaway directory, with a pinned RNG so roll order is deterministic. */
function freshStore(opts?: { autoApprove?: boolean; maxLogos?: number; seed?: number }): CrewStore {
  const dir = mkdtempSync(join(tmpdir(), "fluncle-crew-"));
  dirs.push(dir);
  return createCrewStore({
    autoApprove: opts?.autoApprove ?? false,
    dir,
    maxLogos: opts?.maxLogos,
    rng: mulberry32(opts?.seed ?? 7),
  });
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

// ── The sniffer ──────────────────────────────────────────────────────────────

describe("sniffImage", () => {
  test("reads the four accepted rasters off their magic bytes", () => {
    expect(sniffImage(PNG)).toEqual({ ext: "png", mime: "image/png" });
    expect(sniffImage(JPEG)).toEqual({ ext: "jpeg", mime: "image/jpeg" });
    expect(sniffImage(GIF)).toEqual({ ext: "gif", mime: "image/gif" });
    expect(sniffImage(WEBP)).toEqual({ ext: "webp", mime: "image/webp" });
  });

  test("REFUSES an SVG — it executes script, and the wall is a browser source", () => {
    expect(sniffImage(SVG)).toBeNull();
  });

  test("refuses anything else: empty, a PDF, a zip, plain text", () => {
    expect(sniffImage(new Uint8Array())).toBeNull();
    expect(sniffImage(new TextEncoder().encode("%PDF-1.7"))).toBeNull();
    expect(sniffImage(new Uint8Array([0x50, 0x4b, 0x03, 0x04]))).toBeNull();
    expect(sniffImage(new TextEncoder().encode("just a logo, honest"))).toBeNull();
  });

  test("a truncated header is refused rather than read past its end", () => {
    expect(sniffImage(PNG.slice(0, 4))).toBeNull();
    // "RIFF" with no room for the "WEBP" fourcc at offset 8.
    expect(sniffImage(new TextEncoder().encode("RIFF"))).toBeNull();
  });

  test("a RIFF container that is not WebP (a .wav) is refused", () => {
    const wav = new Uint8Array([
      ...new TextEncoder().encode("RIFF"),
      0,
      0,
      0,
      0,
      ...new TextEncoder().encode("WAVE"),
    ]);
    expect(sniffImage(wav)).toBeNull();
  });
});

// ── The label ────────────────────────────────────────────────────────────────

describe("normalizeLabel", () => {
  test("trims and collapses whitespace into one line", () => {
    expect(normalizeLabel("  the   crew \n from   next door ")).toBe("the crew from next door");
  });

  test("strips control bytes an uploader could hide text behind", () => {
    expect(normalizeLabel("safe\u0000\u001bname")).toBe("safe name");
    expect(normalizeLabel("bell\u0007and\u007fdelete")).toBe("bell and delete");
  });

  test("keeps ordinary punctuation — a hyphenated name survives intact", () => {
    expect(normalizeLabel("drum-and-bass.nl")).toBe("drum-and-bass.nl");
  });

  test("caps at 40 characters", () => {
    expect(normalizeLabel("x".repeat(80))).toHaveLength(40);
  });

  test("nothing usable is undefined, never an empty string", () => {
    expect(normalizeLabel("   ")).toBeUndefined();
    expect(normalizeLabel("")).toBeUndefined();
    expect(normalizeLabel(undefined)).toBeUndefined();
    expect(normalizeLabel(42)).toBeUndefined();
    expect(normalizeLabel(null)).toBeUndefined();
  });
});

// ── The rate gate ────────────────────────────────────────────────────────────

describe("createRateLimiter", () => {
  test("allows up to the cap inside the window, then holds", () => {
    const limiter = createRateLimiter(3, 60_000);
    expect(limiter.allow("phone", 1000)).toBe(true);
    expect(limiter.allow("phone", 1100)).toBe(true);
    expect(limiter.allow("phone", 1200)).toBe(true);
    expect(limiter.allow("phone", 1300)).toBe(false);
  });

  test("the window slides: once the old hits age out, the phone is welcome again", () => {
    const limiter = createRateLimiter(2, 1000);
    expect(limiter.allow("phone", 0)).toBe(true);
    expect(limiter.allow("phone", 100)).toBe(true);
    expect(limiter.allow("phone", 200)).toBe(false);
    expect(limiter.allow("phone", 1500)).toBe(true);
  });

  test("one phone flooding never blocks another", () => {
    const limiter = createRateLimiter(1, 60_000);
    expect(limiter.allow("a", 0)).toBe(true);
    expect(limiter.allow("a", 1)).toBe(false);
    expect(limiter.allow("b", 2)).toBe(true);
  });

  test("a held call does not count against the window, so a flood cannot extend its own ban", () => {
    const limiter = createRateLimiter(1, 1000);
    expect(limiter.allow("phone", 0)).toBe(true);
    for (let t = 100; t < 1000; t += 100) {
      expect(limiter.allow("phone", t)).toBe(false);
    }
    expect(limiter.allow("phone", 1001)).toBe(true);
  });
});

// ── The store ────────────────────────────────────────────────────────────────

describe("createCrewStore", () => {
  test("an upload lands PENDING by default — the operator gate is on", () => {
    const store = freshStore();
    const added = store.add({ bytes: PNG });
    expect(added.ok).toBe(true);
    expect(store.list("pending")).toHaveLength(1);
    expect(store.list("approved")).toHaveLength(0);
    // Invisible to the wall until he approves it.
    expect(store.roll().order).toEqual([]);
    expect(store.roll().logos).toEqual([]);
  });

  test("approving puts it on the wall and bumps the roll version", () => {
    const store = freshStore();
    const added = store.add({ bytes: PNG });
    if (!added.ok) {
      throw new Error("the fixture PNG should have been accepted");
    }
    const before = store.roll().version;
    expect(store.approve(added.logo.id)).toBe(true);
    const after = store.roll();
    expect(after.version).toBeGreaterThan(before);
    expect(after.order).toEqual([added.logo.id]);
    expect(after.logos[0].url).toBe(`/crew/logo/${added.logo.id}`);
  });

  test("auto-approve skips the queue (the opt-in for a trusted room)", () => {
    const store = freshStore({ autoApprove: true });
    store.add({ bytes: PNG });
    expect(store.list("pending")).toHaveLength(0);
    expect(store.roll().order).toHaveLength(1);
  });

  test("every refusal is a NAMED reason, never a throw", () => {
    const store = freshStore({ maxLogos: 1 });
    expect(store.add({ bytes: new Uint8Array() })).toEqual({ ok: false, reason: "empty" });
    expect(store.add({ bytes: SVG })).toEqual({ ok: false, reason: "not-an-image" });
    const huge = new Uint8Array(CREW_MAX_BYTES + 1);
    huge.set(PNG.slice(0, 8));
    expect(store.add({ bytes: huge })).toEqual({ ok: false, reason: "too-big" });
    expect(store.add({ bytes: PNG }).ok).toBe(true);
    expect(store.add({ bytes: JPEG })).toEqual({ ok: false, reason: "wall-full" });
  });

  test("the size cap is checked before the sniff, so a huge non-image reads as too-big", () => {
    const store = freshStore();
    expect(store.add({ bytes: new Uint8Array(CREW_MAX_BYTES + 1) })).toEqual({
      ok: false,
      reason: "too-big",
    });
  });

  test("read hands back the exact bytes and the sniffed mime", () => {
    const store = freshStore();
    const added = store.add({ bytes: JPEG });
    if (!added.ok) {
      throw new Error("the fixture JPEG should have been accepted");
    }
    const found = store.read(added.logo.id);
    expect(found?.mime).toBe("image/jpeg");
    expect(Array.from(found?.bytes ?? [])).toEqual(Array.from(JPEG));
    expect(store.read("not-a-real-id")).toBeNull();
  });

  test("rejecting drops the row AND its file, and bumps the version when it was live", () => {
    const store = freshStore({ autoApprove: true });
    const added = store.add({ bytes: PNG });
    if (!added.ok) {
      throw new Error("the fixture PNG should have been accepted");
    }
    const file = join(store.dir, `${added.logo.id}.png`);
    expect(existsSync(file)).toBe(true);
    const before = store.roll().version;
    expect(store.reject(added.logo.id)).toBe(true);
    expect(existsSync(file)).toBe(false);
    expect(store.list()).toHaveLength(0);
    expect(store.roll().version).toBeGreaterThan(before);
    // Rejecting the same id twice is a false, never a throw.
    expect(store.reject(added.logo.id)).toBe(false);
    expect(store.approve(added.logo.id)).toBe(false);
  });

  test("the label rides along, normalized, and is absent when nothing usable came", () => {
    const store = freshStore({ autoApprove: true });
    store.add({ bytes: PNG, label: "  Studio  Kees \n " });
    store.add({ bytes: JPEG, label: "   " });
    const labels = store.list().map((l) => l.label);
    expect(labels).toContain("Studio Kees");
    expect(labels).toContain(undefined);
  });

  test("list is newest first", () => {
    const store = freshStore();
    store.add({ bytes: PNG, now: 1000 });
    store.add({ bytes: JPEG, now: 3000 });
    store.add({ bytes: GIF, now: 2000 });
    expect(store.list().map((l) => l.addedAt)).toEqual([3000, 2000, 1000]);
  });

  test("a bridge restart mid-show keeps every logo and its state", () => {
    const dir = mkdtempSync(join(tmpdir(), "fluncle-crew-"));
    dirs.push(dir);
    const first = createCrewStore({ dir, rng: mulberry32(1) });
    const added = first.add({ bytes: PNG, label: "Studio Kees" });
    if (!added.ok) {
      throw new Error("the fixture PNG should have been accepted");
    }
    first.approve(added.logo.id);

    const second = createCrewStore({ dir, rng: mulberry32(1) });
    expect(second.list("approved")).toHaveLength(1);
    expect(second.list("approved")[0].label).toBe("Studio Kees");
    expect(second.roll().order).toEqual([added.logo.id]);
    expect(Array.from(second.read(added.logo.id)?.bytes ?? [])).toEqual(Array.from(PNG));
  });

  test("an index entry whose file has gone missing is dropped, never served as a hole", () => {
    const dir = mkdtempSync(join(tmpdir(), "fluncle-crew-"));
    dirs.push(dir);
    const first = createCrewStore({ autoApprove: true, dir, rng: mulberry32(1) });
    const kept = first.add({ bytes: PNG });
    const lost = first.add({ bytes: JPEG });
    if (!kept.ok || !lost.ok) {
      throw new Error("both fixtures should have been accepted");
    }
    rmSync(join(dir, `${lost.logo.id}.jpeg`));

    const second = createCrewStore({ autoApprove: true, dir, rng: mulberry32(1) });
    expect(second.list().map((l) => l.id)).toEqual([kept.logo.id]);
  });

  test("a corrupt index starts clean rather than taking the show down", () => {
    const dir = mkdtempSync(join(tmpdir(), "fluncle-crew-"));
    dirs.push(dir);
    writeFileSync(join(dir, "index.json"), "{ not json at all");
    const store = createCrewStore({ dir, rng: mulberry32(1) });
    expect(store.list()).toEqual([]);
    expect(store.add({ bytes: PNG }).ok).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, "index.json"), "utf8")).logos).toHaveLength(1);
  });
});

// ── The roll order ───────────────────────────────────────────────────────────

describe("rollOrder", () => {
  test("one full permutation: every logo shows exactly once before any repeats", () => {
    const ids = Array.from({ length: 12 }, (_, i) => `logo-${i}`);
    const order = rollOrder(ids, mulberry32(99));
    expect(new Set(order).size).toBe(ids.length);
    expect([...order].sort()).toEqual([...ids].sort());
  });

  test("the seam never repeats: an order that would open on the live logo is rotated", () => {
    const ids = ["a", "b", "c", "d", "e"];
    for (let seed = 0; seed < 40; seed++) {
      const plain = rollOrder(ids, mulberry32(seed));
      const rotated = rollOrder(ids, mulberry32(seed), plain[0]);
      expect(rotated[0]).not.toBe(plain[0]);
      expect(new Set(rotated).size).toBe(ids.length);
    }
  });

  test("an empty wall is an empty order, and a lone logo is itself", () => {
    expect(rollOrder([], mulberry32(1))).toEqual([]);
    expect(rollOrder(["only"], mulberry32(1))).toEqual(["only"]);
    // With one logo a repeat is unavoidable; it must still not return an empty order.
    expect(rollOrder(["only"], mulberry32(1), "only")).toEqual(["only"]);
  });
});

// ── The environment ──────────────────────────────────────────────────────────

describe("the environment gates", () => {
  test("the operator gate is ON unless it is explicitly opted out of", () => {
    expect(crewAutoApprove(undefined)).toBe(false);
    expect(crewAutoApprove("")).toBe(false);
    expect(crewAutoApprove("0")).toBe(false);
    expect(crewAutoApprove("yes")).toBe(false);
    expect(crewAutoApprove("1")).toBe(true);
    expect(crewAutoApprove("TRUE")).toBe(true);
  });

  test("the store directory defaults inside the package and honours an override", () => {
    expect(resolveCrewDir(undefined)).toEndWith("/packages/live/.crew");
    expect(resolveCrewDir("   ")).toEndWith("/packages/live/.crew");
    expect(resolveCrewDir("/tmp/elsewhere")).toBe("/tmp/elsewhere");
  });
});

// ── The pages' ratified copy ─────────────────────────────────────────────────

describe("the crew pages", () => {
  test("ONE ACTION, ONE LABEL: the upload page and the wall card agree, verbatim", () => {
    expect(CREW_HTML).toContain("<title>Add your logo</title>");
    expect(CREW_HTML).toContain("<h1>Add your logo to the wall</h1>");
    expect(CREW_HTML).toContain('<button id="send" disabled>Add your logo</button>');
    expect(CREW_WALL_HTML).toContain('<div class="ask">Add your logo</div>');
    // The variants that would break the Chrome Rule if one crept back in.
    for (const stale of ["Add my logo", "Put your logo", "Send it up", "Upload"]) {
      expect(CREW_HTML).not.toContain(stale);
    }
  });

  test("the size cap the page states comes from the constant that enforces it", () => {
    const stated = `Up to ${Math.round(CREW_MAX_BYTES / 1_000_000)} MB.`;
    expect(CREW_HTML).toContain(stated);
    // ...and the refusal message quotes the same number, so the two cannot drift apart.
    expect(CREW_HTML).toContain(`over ${Math.round(CREW_MAX_BYTES / 1_000_000)} MB`);
  });

  test("the arrival page speaks plain: no cosmos vocabulary, no exclamation marks", () => {
    // Only what a person READS: strip the style and script blocks, then the tags.
    const proseOf = (page: string): string =>
      page
        .replace(/<style[\s\S]*?<\/style>/g, " ")
        .replace(/<script[\s\S]*?<\/script>/g, " ")
        .replace(/<[^>]+>/g, " ");
    const prose = proseOf(CREW_HTML) + proseOf(CREW_WALL_HTML);
    for (const word of ["Galaxy", "cosmonaut", "banger", "finding", "sector", "coordinate"]) {
      expect(prose.toLowerCase()).not.toContain(word.toLowerCase());
    }
    expect(prose).not.toContain("!");
    // The em dash is reserved for `Artist — Title`, which no crew page carries.
    expect(prose).not.toContain("\u2014");
  });

  test("the wall's QR card waits for the code to load, never paints a broken box", () => {
    // /crew/qr.svg has a 404 path; the card must be gated on the image, not on /crew/where.
    expect(CREW_WALL_HTML).toContain('img.onerror=function(){ $("qr").className=qrCorner; }');
    expect(CREW_WALL_HTML).toContain('img.onload=function(){ $("qr").className=qrCorner+" on"; }');
  });

  test("each page is a whole document — a stray backtick would truncate one", () => {
    for (const page of [CREW_HTML, CREW_WALL_HTML, CREW_MODERATE_HTML]) {
      expect(page).toStartWith("<!doctype html>");
      expect(page).toEndWith("</html>");
      expect(page.split("<script>").length).toBe(page.split("</script>").length);
    }
  });

  test("the wall's ground is transparent, so it composites over the show", () => {
    expect(CREW_WALL_HTML).toContain("background:transparent");
  });

  test("no page ASSIGNS innerHTML — uploader text is rendered as text", () => {
    for (const page of [CREW_HTML, CREW_WALL_HTML, CREW_MODERATE_HTML]) {
      expect(page).not.toMatch(/\.innerHTML\s*=/);
      expect(page).not.toMatch(/insertAdjacentHTML/);
    }
  });

  test("the queue redraws only on a real change, so a held control keeps focus", () => {
    expect(CREW_MODERATE_HTML).toContain("holdingAControl()");
    expect(CREW_MODERATE_HTML).toContain("signature!==drawn");
  });

  test("the operator's destructive controls arm before they act", () => {
    expect(CREW_MODERATE_HTML).toContain('no.textContent="Sure?"');
  });
});

// ── The HTTP surface ─────────────────────────────────────────────────────────

const CREW_URL = "http://192.168.1.42:4180/crew";

function router(store: CrewStore, limit = 50) {
  return createCrewRouter({ crewUrl: CREW_URL, limiter: createRateLimiter(limit, 60_000), store });
}

/** One multipart upload, as the page sends it. */
function uploadRequest(bytes: Uint8Array, label?: string): Request {
  const body = new FormData();
  // A fresh ArrayBuffer view: a Uint8Array over a shared buffer is not a BlobPart.
  const part = new Uint8Array(bytes).buffer as ArrayBuffer;
  body.append("logo", new File([part], "logo.png", { type: "image/png" }));
  if (label !== undefined) {
    body.append("label", label);
  }
  return new Request("http://localhost:4180/crew/logo", { body, method: "POST" });
}

describe("createCrewRouter", () => {
  test("a path outside /crew is not ours — the bridge's own routes still answer", async () => {
    const crew = router(freshStore());
    for (const path of ["/plan", "/remote", "/health", "/state", "/crewless"]) {
      expect(await crew.handle(new Request(`http://localhost:4180${path}`), null)).toBeNull();
    }
  });

  test("serves the three pages", async () => {
    const crew = router(freshStore());
    for (const path of ["/crew", "/crew/", "/crew/wall", "/crew/moderate"]) {
      const res = await crew.handle(new Request(`http://localhost:4180${path}`), null);
      expect(res?.status).toBe(200);
      expect(res?.headers.get("content-type")).toStartWith("text/html");
      expect(await res?.text()).toContain("<!doctype html>");
    }
  });

  test("the wall's ground is transparent, so it composites over the show", async () => {
    const crew = router(freshStore());
    const res = await crew.handle(new Request("http://localhost:4180/crew/wall"), null);
    expect(await res?.text()).toContain("background:transparent");
  });

  test("an upload answers with the pending flag the page speaks from", async () => {
    const store = freshStore();
    const crew = router(store);
    const res = await crew.handle(uploadRequest(PNG, "Studio Kees"), "10.0.0.9");
    expect(res?.status).toBe(200);
    expect(await res?.json()).toMatchObject({ ok: true, pending: true });
    expect(store.list("pending")[0].label).toBe("Studio Kees");
  });

  test("auto-approve reports pending false, so the page says it is already up", async () => {
    const crew = router(freshStore({ autoApprove: true }));
    const res = await crew.handle(uploadRequest(PNG), "10.0.0.9");
    expect(await res?.json()).toMatchObject({ ok: true, pending: false });
  });

  test("a refused upload names its reason with a fitting status", async () => {
    const crew = router(freshStore({ maxLogos: 1 }));
    const bad = await crew.handle(uploadRequest(SVG), "10.0.0.9");
    expect(bad?.status).toBe(415);
    expect(await bad?.json()).toEqual({ ok: false, reason: "not-an-image" });

    await crew.handle(uploadRequest(PNG), "10.0.0.9");
    const full = await crew.handle(uploadRequest(JPEG), "10.0.0.9");
    expect(full?.status).toBe(507);
    expect(await full?.json()).toEqual({ ok: false, reason: "wall-full" });
  });

  test("a body that is not multipart, or carries no file, is a 400 and never a throw", async () => {
    const crew = router(freshStore());
    const junk = new Request("http://localhost:4180/crew/logo", {
      body: "not a form at all",
      method: "POST",
    });
    expect((await crew.handle(junk, "10.0.0.9"))?.status).toBe(400);

    const empty = new Request("http://localhost:4180/crew/logo", {
      body: new FormData(),
      method: "POST",
    });
    expect((await crew.handle(empty, "10.0.0.9"))?.status).toBe(400);
  });

  test("an oversized body is refused on its declared length, before it is buffered", async () => {
    const crew = router(freshStore());
    const res = await crew.handle(
      new Request("http://localhost:4180/crew/logo", {
        body: "x",
        headers: { "content-length": String(CREW_MAX_BYTES * 4) },
        method: "POST",
      }),
      "10.0.0.9",
    );
    expect(res?.status).toBe(413);
    expect(await res?.json()).toEqual({ ok: false, reason: "too-big" });
  });

  test("the rate gate holds one phone at 429 and never bothers the store", async () => {
    const store = freshStore();
    const crew = router(store, 2);
    expect((await crew.handle(uploadRequest(PNG), "10.0.0.9"))?.status).toBe(200);
    expect((await crew.handle(uploadRequest(PNG), "10.0.0.9"))?.status).toBe(200);
    const held = await crew.handle(uploadRequest(PNG), "10.0.0.9");
    expect(held?.status).toBe(429);
    expect(await held?.json()).toEqual({ ok: false, reason: "too-fast" });
    expect(store.list()).toHaveLength(2);
    // A different phone is unaffected.
    expect((await crew.handle(uploadRequest(PNG), "10.0.0.10"))?.status).toBe(200);
  });

  test("one logo's bytes come back with its mime and an immutable cache", async () => {
    const store = freshStore();
    const added = store.add({ bytes: GIF });
    if (!added.ok) {
      throw new Error("the fixture GIF should have been accepted");
    }
    const crew = router(store);
    const res = await crew.handle(
      new Request(`http://localhost:4180/crew/logo/${added.logo.id}`),
      null,
    );
    expect(res?.status).toBe(200);
    expect(res?.headers.get("content-type")).toBe("image/gif");
    expect(res?.headers.get("cache-control")).toContain("immutable");
    expect(Array.from(new Uint8Array(await (res as Response).arrayBuffer()))).toEqual(
      Array.from(GIF),
    );
  });

  test("an unknown logo id is a 404", async () => {
    const crew = router(freshStore());
    const res = await crew.handle(new Request("http://localhost:4180/crew/logo/nope"), null);
    expect(res?.status).toBe(404);
  });

  test("the roll carries only approved logos, and honours ?last", async () => {
    const store = freshStore({ autoApprove: true, seed: 3 });
    const ids: string[] = [];
    for (const bytes of [PNG, JPEG, GIF, WEBP]) {
      const added = store.add({ bytes });
      if (!added.ok) {
        throw new Error("every fixture should have been accepted");
      }
      ids.push(added.logo.id);
    }
    const crew = router(store);

    const plain = await (
      await crew.handle(new Request("http://localhost:4180/crew/roll"), null)
    )?.json();
    expect(new Set(plain.order).size).toBe(plain.logos.length);
    expect(plain.dwellMs).toBeGreaterThan(0);

    const rolled = await (
      await crew.handle(
        new Request(`http://localhost:4180/crew/roll?last=${encodeURIComponent(plain.order[0])}`),
        null,
      )
    )?.json();
    expect(rolled.order[0]).not.toBe(plain.order[0]);
    expect(ids.every((id) => plain.order.includes(id))).toBe(true);
  });

  test("a pending logo never appears in the roll the wall reads", async () => {
    const store = freshStore();
    store.add({ bytes: PNG });
    const crew = router(store);
    const roll = await (
      await crew.handle(new Request("http://localhost:4180/crew/roll"), null)
    )?.json();
    expect(roll.order).toEqual([]);
    expect(roll.logos).toEqual([]);
  });

  test("the version poll answers the same number the roll carries", async () => {
    const store = freshStore();
    const added = store.add({ bytes: PNG });
    if (!added.ok) {
      throw new Error("the fixture PNG should have been accepted");
    }
    const crew = router(store);
    const version = async (): Promise<number> => {
      const res = await crew.handle(new Request("http://localhost:4180/crew/version"), null);
      if (res === null) {
        throw new Error("/crew/version should be handled by the crew router");
      }
      return (await res.json()).version;
    };
    const before = await version();
    expect(before).toBe(store.roll().version);
    store.approve(added.logo.id);
    expect(await version()).toBeGreaterThan(before);
  });

  test("the queue lists both states for the operator", async () => {
    const store = freshStore();
    store.add({ bytes: PNG });
    const crew = router(store);
    const json = await (
      await crew.handle(new Request("http://localhost:4180/crew/logos"), null)
    )?.json();
    expect(json.logos).toHaveLength(1);
    expect(json.logos[0].state).toBe("pending");
  });

  test("approve and reject act, and report a miss as a 404", async () => {
    const store = freshStore();
    const added = store.add({ bytes: PNG });
    if (!added.ok) {
      throw new Error("the fixture PNG should have been accepted");
    }
    const crew = router(store);
    const post = (path: string, body: unknown): Request =>
      new Request(`http://localhost:4180${path}`, {
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
        method: "POST",
      });

    expect((await crew.handle(post("/crew/approve", { id: added.logo.id }), null))?.status).toBe(
      200,
    );
    expect(store.list("approved")).toHaveLength(1);
    expect((await crew.handle(post("/crew/approve", { id: "nope" }), null))?.status).toBe(404);
    expect((await crew.handle(post("/crew/reject", { id: added.logo.id }), null))?.status).toBe(
      200,
    );
    expect(store.list()).toHaveLength(0);
  });

  test("a moderation call with no usable id is a 400, never a throw", async () => {
    const crew = router(freshStore());
    for (const body of ["not json", JSON.stringify({}), JSON.stringify({ id: 7 })]) {
      const res = await crew.handle(
        new Request("http://localhost:4180/crew/approve", { body, method: "POST" }),
        null,
      );
      expect(res?.status).toBe(400);
    }
  });

  test("the room is told where to point its phones, as text and as a scannable code", async () => {
    const crew = router(freshStore());
    const where = await (
      await crew.handle(new Request("http://localhost:4180/crew/where"), null)
    )?.json();
    expect(where).toEqual({ short: "192.168.1.42:4180/crew", url: CREW_URL });

    const svg = await crew.handle(new Request("http://localhost:4180/crew/qr.svg"), null);
    expect(svg?.headers.get("content-type")).toBe("image/svg+xml");
    expect(await svg?.text()).toStartWith("<svg");
  });

  test("an unknown /crew path is a 404 that names the surface", async () => {
    const crew = router(freshStore());
    const res = await crew.handle(new Request("http://localhost:4180/crew/nowhere"), null);
    expect(res?.status).toBe(404);
    expect(await res?.text()).toContain("/crew/wall");
  });

  test("an upload from an unknown address is still rate-gated, never ungated", async () => {
    const crew = router(freshStore(), 1);
    expect((await crew.handle(uploadRequest(PNG), null))?.status).toBe(200);
    expect((await crew.handle(uploadRequest(PNG), null))?.status).toBe(429);
  });
});
