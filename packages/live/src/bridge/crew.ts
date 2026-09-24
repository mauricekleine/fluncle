// THE CREW WALL STORE — the room's logos, gated by the operator.
//
// Anyone on the room's WiFi opens `/crew` on the bridge and adds their logo. It lands
// PENDING; the operator approves it from `/crew/moderate` (or his phone) and only then does
// it reach `/crew/wall`, the overlay OBS composites over the stream. This module owns the
// whole store: sniff, cap, persist, gate, and hand the wall its rotation order.
//
// Three rails, in the bridge's house style:
//   * NEVER-CRASH — every entry point is total. A bad upload returns a DISCRIMINATED
//     outcome (`{ok:false, reason}`), never a throw and never a silent empty.
//   * BOUNDED — per-file bytes, total logo count, and per-address rate, all from
//     `contract.ts`. A show cannot be filled up or starved by one phone.
//   * RASTER ONLY — the type is decided by MAGIC BYTES, never by the filename or the
//     browser's claimed content-type. SVG is refused outright: it executes script, and the
//     wall is a browser source pointed at the stream.
//
// Persistence is a directory of files plus one `index.json`, so a bridge restart mid-show
// keeps every approved logo (the stateless-restartable rail). An index entry whose file has
// gone missing is dropped on load rather than served as a hole.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  CREW_DWELL_MS,
  CREW_MAX_BYTES,
  CREW_MAX_LOGOS,
  CREW_RATE_LIMIT,
  CREW_RATE_WINDOW_MS,
  type CrewImageExt,
  type CrewLogo,
  type CrewRoll,
} from "../contract";
import { CREW_HTML, CREW_MODERATE_HTML, CREW_WALL_HTML } from "./crew-page";
import { qrSvg } from "../qr";
import { createShuffleBag, mulberry32, type Rng } from "./vj";

/** The longest uploader label we keep. Operator-facing only (the queue), never the wall. */
const LABEL_MAX = 40;

/** The wire mime for each accepted raster format. */
const MIME: Record<CrewImageExt, string> = {
  gif: "image/gif",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

/** Does `bytes` carry `magic` at `offset`? */
function carries(bytes: Uint8Array, magic: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + magic.length) {
    return false;
  }
  for (let i = 0; i < magic.length; i++) {
    if (bytes[offset + i] !== magic[i]) {
      return false;
    }
  }
  return true;
}

const ascii = (text: string): number[] => Array.from(text, (ch) => ch.charCodeAt(0));

/**
 * Decide an upload's real format from its MAGIC BYTES — the filename and the browser's
 * content-type are both uploader-chosen, so neither is consulted. Returns `null` for
 * anything not on the raster list, which is what refuses an SVG (it is text, so it carries
 * no magic) as well as a PDF, a zip, or a renamed executable. Pure and total.
 */
export function sniffImage(bytes: Uint8Array): { ext: CrewImageExt; mime: string } | null {
  if (carries(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { ext: "png", mime: MIME.png };
  }
  if (carries(bytes, [0xff, 0xd8, 0xff])) {
    return { ext: "jpeg", mime: MIME.jpeg };
  }
  if (carries(bytes, ascii("GIF87a")) || carries(bytes, ascii("GIF89a"))) {
    return { ext: "gif", mime: MIME.gif };
  }
  // WebP is a RIFF container: "RIFF" <4-byte size> "WEBP".
  if (carries(bytes, ascii("RIFF")) && carries(bytes, ascii("WEBP"), 8)) {
    return { ext: "webp", mime: MIME.webp };
  }
  return null;
}

/** Trim an uploader label to something safe to hold: one line, no control bytes, capped. */
export function normalizeLabel(raw: unknown): string | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  // Collapse control bytes and whitespace runs to single spaces: one line, nothing hidden.
  // The control class IS the point here — an uploader hides text behind it.
  // oxlint-disable-next-line no-control-regex
  const flat = raw.replace(/[\u0000-\u001f\u007f\s]+/g, " ").trim();
  if (flat.length === 0) {
    return undefined;
  }
  return flat.slice(0, LABEL_MAX);
}

/** A sliding-window per-key rate gate. One phone cannot flood the queue. */
export type RateLimiter = {
  /** True when `key` may act at `now`; an allowed call counts against the window. */
  allow(key: string, now: number): boolean;
};

export function createRateLimiter(
  max = CREW_RATE_LIMIT,
  windowMs = CREW_RATE_WINDOW_MS,
): RateLimiter {
  const hits = new Map<string, number[]>();
  return {
    allow(key, now) {
      const cutoff = now - windowMs;
      const kept = (hits.get(key) ?? []).filter((t) => t > cutoff);
      if (kept.length >= max) {
        hits.set(key, kept);
        return false;
      }
      kept.push(now);
      hits.set(key, kept);
      return true;
    },
  };
}

/** The outcome of an upload: a logo, or a NAMED refusal the page can speak plainly. */
export type CrewAdd =
  | { ok: true; logo: CrewLogo }
  | { ok: false; reason: "empty" | "too-big" | "not-an-image" | "wall-full" };

export type CrewStore = {
  /** Take an upload. Total: every refusal is a named reason, never a throw. */
  add(input: { bytes: Uint8Array; label?: unknown; now?: number }): CrewAdd;
  /** Every logo, or just those in one state — newest first. */
  list(state?: CrewLogo["state"]): CrewLogo[];
  /** Move a pending logo onto the wall. False when the id is unknown. */
  approve(id: string): boolean;
  /** Drop a logo and its file for good. False when the id is unknown. */
  reject(id: string): boolean;
  /** The bytes + mime for one logo, or null when it is unknown. */
  read(id: string): { bytes: Uint8Array; mime: string } | null;
  /**
   * The wall's roll. `last` is the id the wall is showing now: the order is rotated so it
   * never opens on that same logo, which is what keeps the seam between two rolls from
   * repeating a logo back-to-back.
   */
  roll(last?: string): CrewRoll;
  readonly dir: string;
};

type Index = { logos: CrewLogo[] };

/**
 * Open (or create) a crew store on disk. `rng` is injected so the roll order is deterministic
 * under test; the bridge seeds it per set exactly as the RANDOM-VJ director does.
 */
export function createCrewStore(opts: {
  dir: string;
  autoApprove?: boolean;
  maxLogos?: number;
  maxBytes?: number;
  rng?: Rng;
}): CrewStore {
  const dir = opts.dir;
  const autoApprove = opts.autoApprove ?? false;
  const maxLogos = opts.maxLogos ?? CREW_MAX_LOGOS;
  const maxBytes = opts.maxBytes ?? CREW_MAX_BYTES;
  const rng = opts.rng ?? mulberry32(Date.now());
  const indexPath = join(dir, "index.json");

  mkdirSync(dir, { recursive: true });

  /** Load the index, dropping any entry whose file has gone missing (self-healing). */
  function load(): CrewLogo[] {
    if (!existsSync(indexPath)) {
      return [];
    }
    try {
      const parsed = JSON.parse(readFileSync(indexPath, "utf8")) as Index;
      const rows = Array.isArray(parsed.logos) ? parsed.logos : [];
      return rows.filter((row) => existsSync(join(dir, `${row.id}.${row.ext}`)));
    } catch {
      // A corrupt index must never take the show down: start clean rather than throw.
      return [];
    }
  }

  let logos = load();
  let version = 1;

  function persist(): void {
    writeFileSync(indexPath, `${JSON.stringify({ logos } satisfies Index, null, 2)}\n`);
  }

  function fileFor(logo: CrewLogo): string {
    return join(dir, `${logo.id}.${logo.ext}`);
  }

  return {
    add({ bytes, label, now = Date.now() }) {
      if (bytes.length === 0) {
        return { ok: false, reason: "empty" };
      }
      if (bytes.length > maxBytes) {
        return { ok: false, reason: "too-big" };
      }
      const sniffed = sniffImage(bytes);
      if (sniffed === null) {
        return { ok: false, reason: "not-an-image" };
      }
      if (logos.length >= maxLogos) {
        return { ok: false, reason: "wall-full" };
      }
      const trimmed = normalizeLabel(label);
      const logo: CrewLogo = {
        addedAt: now,
        ext: sniffed.ext,
        id: crypto.randomUUID(),
        state: autoApprove ? "approved" : "pending",
        ...(trimmed === undefined ? {} : { label: trimmed }),
      };
      writeFileSync(fileFor(logo), bytes);
      logos = [logo, ...logos];
      persist();
      if (logo.state === "approved") {
        version += 1;
      }
      return { logo, ok: true };
    },

    approve(id) {
      const logo = logos.find((l) => l.id === id);
      if (logo === undefined) {
        return false;
      }
      if (logo.state !== "approved") {
        logo.state = "approved";
        version += 1;
        persist();
      }
      return true;
    },

    get dir() {
      return dir;
    },

    list(state) {
      const rows = state === undefined ? logos : logos.filter((l) => l.state === state);
      return [...rows].sort((a, b) => b.addedAt - a.addedAt);
    },

    read(id) {
      const logo = logos.find((l) => l.id === id);
      if (logo === undefined) {
        return null;
      }
      try {
        return { bytes: readFileSync(fileFor(logo)), mime: MIME[logo.ext] };
      } catch {
        return null;
      }
    },

    reject(id) {
      const logo = logos.find((l) => l.id === id);
      if (logo === undefined) {
        return false;
      }
      logos = logos.filter((l) => l.id !== id);
      try {
        rmSync(fileFor(logo), { force: true });
      } catch {
        // The index is the truth the wall reads; a stuck file is cosmetic, never fatal.
      }
      if (logo.state === "approved") {
        version += 1;
      }
      persist();
      return true;
    },

    roll(last) {
      const approved = logos.filter((l) => l.state === "approved");
      return {
        dwellMs: CREW_DWELL_MS,
        logos: approved.map((l) => ({
          id: l.id,
          url: `/crew/logo/${l.id}`,
          ...(l.label === undefined ? {} : { label: l.label }),
        })),
        order: rollOrder(
          approved.map((l) => l.id),
          rng,
          last,
        ),
        version,
      };
    },
  };
}

/**
 * One full permutation of `ids` — every logo shows exactly once before any repeats — drawn
 * with the RANDOM-VJ director's shuffle bag so this package keeps ONE shuffle implementation.
 * When `last` (the logo on the wall right now) lands at the head, the order is rotated by one
 * so the seam between two rolls does not repeat it back-to-back. Pure given `rng`.
 */
export function rollOrder(ids: readonly string[], rng: Rng, last?: string): string[] {
  if (ids.length === 0) {
    return [];
  }
  const bag = createShuffleBag(ids.length, rng);
  const order = Array.from({ length: ids.length }, () => ids[bag.next()]);
  const head = order[0];
  if (order.length > 1 && last !== undefined && head === last) {
    order.shift();
    order.push(head);
  }
  return order;
}

// ── The HTTP surface ─────────────────────────────────────────────────────────

/**
 * The crew wall's routes, split out from `serve.ts` so the whole surface — the upload gate,
 * the moderation verbs, the wall's roll, the QR — is unit-testable against a real `Request`
 * with no socket and no bridge boot. `handle` returns `null` for a path that is not ours, so
 * the bridge's `fetch` simply falls through to its own routes.
 */
export type CrewRouter = {
  handle(req: Request, clientAddress: string | null): Promise<Response | null>;
};

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" } as const;
const HTML_HEADERS = { "content-type": "text/html; charset=utf-8" } as const;

function html(body: string): Response {
  return new Response(body, { headers: HTML_HEADERS });
}

export function createCrewRouter(opts: {
  store: CrewStore;
  /** The URL the room opens (the LAN one) — what the QR encodes and `/crew/where` reports. */
  crewUrl: string;
  limiter?: RateLimiter;
  maxBytes?: number;
}): CrewRouter {
  const { store, crewUrl } = opts;
  const limiter = opts.limiter ?? createRateLimiter();
  const maxBytes = opts.maxBytes ?? CREW_MAX_BYTES;

  /** Read one id out of a JSON body. Total: a malformed body is just "no id". */
  async function idFrom(req: Request): Promise<string | null> {
    try {
      const body = (await req.json()) as { id?: unknown };
      return typeof body.id === "string" && body.id.length > 0 ? body.id : null;
    } catch {
      return null;
    }
  }

  async function upload(req: Request, clientAddress: string | null): Promise<Response> {
    // Rate-gate BEFORE reading the body, so a flood costs us nothing but a header parse.
    const key = clientAddress ?? "unknown";
    if (!limiter.allow(key, Date.now())) {
      return Response.json(
        { ok: false, reason: "too-fast" },
        { headers: JSON_HEADERS, status: 429 },
      );
    }
    // Refuse an oversized body on its declared length rather than buffering it first.
    const declared = Number(req.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > maxBytes * 2) {
      return Response.json(
        { ok: false, reason: "too-big" },
        { headers: JSON_HEADERS, status: 413 },
      );
    }
    let bytes: Uint8Array;
    let label: unknown;
    try {
      const form = await req.formData();
      const logo = form.get("logo");
      if (!(logo instanceof File)) {
        return Response.json(
          { ok: false, reason: "empty" },
          { headers: JSON_HEADERS, status: 400 },
        );
      }
      bytes = new Uint8Array(await logo.arrayBuffer());
      label = form.get("label");
    } catch {
      // A truncated or non-multipart body is the uploader's problem, never the show's.
      return Response.json({ ok: false, reason: "empty" }, { headers: JSON_HEADERS, status: 400 });
    }
    const added = store.add({ bytes, label });
    if (!added.ok) {
      const status = added.reason === "wall-full" ? 507 : added.reason === "too-big" ? 413 : 415;
      return Response.json({ ok: false, reason: added.reason }, { headers: JSON_HEADERS, status });
    }
    return Response.json(
      { id: added.logo.id, ok: true, pending: added.logo.state === "pending" },
      { headers: JSON_HEADERS },
    );
  }

  /** The three pages. */
  function page(method: string, path: string): Response | null {
    if (method !== "GET") {
      return null;
    }
    if (path === "/crew") {
      return html(CREW_HTML);
    }
    if (path === "/crew/wall") {
      return html(CREW_WALL_HTML);
    }
    if (path === "/crew/moderate") {
      return html(CREW_MODERATE_HTML);
    }
    return null;
  }

  /** One logo's bytes. The id is a UUID, so the response is immutable for its lifetime. */
  function logoBytes(method: string, path: string): Response | null {
    if (method !== "GET" || !path.startsWith("/crew/logo/")) {
      return null;
    }
    const found = store.read(path.slice("/crew/logo/".length));
    if (found === null) {
      return new Response("no such logo", { status: 404 });
    }
    return new Response(new Uint8Array(found.bytes).buffer as ArrayBuffer, {
      headers: {
        "cache-control": "public, max-age=31536000, immutable",
        "content-type": found.mime,
      },
    });
  }

  /** The wall's roll + cheap version poll, and the operator's queue. */
  function reads(method: string, path: string, params: URLSearchParams): Response | null {
    if (method !== "GET") {
      return null;
    }
    if (path === "/crew/roll") {
      return Response.json(store.roll(params.get("last") ?? undefined), { headers: JSON_HEADERS });
    }
    if (path === "/crew/version") {
      return Response.json({ version: store.roll().version }, { headers: JSON_HEADERS });
    }
    if (path === "/crew/logos") {
      return Response.json({ logos: store.list() }, { headers: JSON_HEADERS });
    }
    return null;
  }

  /** Approve or reject one logo. */
  async function moderate(req: Request, path: string): Promise<Response | null> {
    if (req.method !== "POST" || (path !== "/crew/approve" && path !== "/crew/reject")) {
      return null;
    }
    const id = await idFrom(req);
    if (id === null) {
      return Response.json({ ok: false }, { headers: JSON_HEADERS, status: 400 });
    }
    const ok = path === "/crew/approve" ? store.approve(id) : store.reject(id);
    return Response.json({ ok }, { headers: JSON_HEADERS, status: ok ? 200 : 404 });
  }

  /** Where the room should point its phones, as text and as a scannable code. */
  function where(method: string, path: string): Response | null {
    if (method !== "GET") {
      return null;
    }
    if (path === "/crew/where") {
      return Response.json(
        { short: crewUrl.replace(/^https?:\/\//, ""), url: crewUrl },
        { headers: JSON_HEADERS },
      );
    }
    if (path === "/crew/qr.svg") {
      try {
        return new Response(qrSvg(crewUrl, { size: 256 }), {
          headers: { "cache-control": "no-store", "content-type": "image/svg+xml" },
        });
      } catch {
        // A URL too long for version 10 is not a show-stopper: the page prints it instead.
        return new Response("no code for that url", { status: 404 });
      }
    }
    return null;
  }

  return {
    async handle(req, clientAddress) {
      const url = new URL(req.url);
      const path = url.pathname.replace(/\/$/, "");
      if (path !== "/crew" && !path.startsWith("/crew/")) {
        return null;
      }
      if (req.method === "POST" && path === "/crew/logo") {
        return upload(req, clientAddress);
      }
      return (
        page(req.method, path) ??
        logoBytes(req.method, path) ??
        reads(req.method, path, url.searchParams) ??
        (await moderate(req, path)) ??
        where(req.method, path) ??
        new Response("the crew wall — /crew /crew/wall /crew/moderate", { status: 404 })
      );
    },
  };
}

// ── Environment ──────────────────────────────────────────────────────────────

/**
 * Where the logos live. Defaults to the gitignored `packages/live/.crew/` beside the show
 * profile, so a set's uploads are local working state that survives a bridge restart and
 * never reaches the repository. `FLUNCLE_CREW_DIR` overrides it (a test rig, or a scratch
 * directory per set).
 */
export function resolveCrewDir(env = process.env.FLUNCLE_CREW_DIR): string {
  const named = env?.trim();
  return named !== undefined && named.length > 0 ? named : resolve(import.meta.dir, "../../.crew");
}

/**
 * The operator gate, ON by default: an upload waits for his approval before it reaches the
 * wall. `FLUNCLE_CREW_AUTO_APPROVE=1` skips the queue for a room he trusts — anyone on the
 * WiFi then puts anything on the stream, so it is opt-in and never the default.
 */
export function crewAutoApprove(env = process.env.FLUNCLE_CREW_AUTO_APPROVE): boolean {
  const flag = env?.trim().toLowerCase();
  return flag === "1" || flag === "true";
}
