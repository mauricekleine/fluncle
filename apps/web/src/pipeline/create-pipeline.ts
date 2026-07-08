// Fluncle's /pipeline — the wide, draggable infographic canvas of a finding's whole
// life: the synchronous add in the Worker, the async enrichment crons, the human-gated
// dispatch, the plaza of every surface, and the launch into the Galaxy (with the mixtape
// dream-tail). A client-only DOM+SVG+canvas toy, mounted into a container the same way
// the Galaxy/Earth games are: `createPipeline(container)` returns a `{ destroy }` handle.
//
// It is fully self-contained: it injects its own scoped stylesheet (every selector under
// `.fpl`), builds all its DOM inside the container, and tears everything down on destroy.
// Sprites are served from /pipeline/*.png; the live cron heartbeat reads /api/status.

import { LOGOS } from "./logos";

type MachKey = "worker" | "rave02" | "rave03" | "m5" | "m2" | "browser";
type Kind = "pivot" | "human";
type Station = {
  id: string;
  col: number;
  lane: number;
  label: string;
  wh: string;
  m: MachKey;
  svc?: string[];
  spr?: string;
  img?: string;
  kind?: Kind;
  cad?: string;
  cron?: string;
  dream?: boolean;
};
type Kiosk = { label: string; wh: string; url: string; tint: string };
type Pos = { x: number; y: number; w: number };

const SPRITE = (name: string) => `/pipeline/${name}.png`;

const MACH: Record<MachKey, { c: string; label: string }> = {
  browser: { c: "--m-browser", label: "browser / phone" },
  m2: { c: "--m-m2", label: "M2 (mixing Mac)" },
  m5: { c: "--m-m5", label: "M5 (studio Mac)" },
  rave02: { c: "--m-rave02", label: "rave-02 (Hermes box)" },
  rave03: { c: "--m-rave03", label: "rave-03 (render box)" },
  worker: { c: "--m-worker", label: "Cloudflare Worker" },
};

// service display name → simple-icons/custom slug (for the brand-mark chips)
const SLUG: Record<string, string> = {
  Box: "box",
  Cartesia: "cartesia",
  Claude: "claude",
  Cloudflare: "cloudflare",
  Deezer: "deezer",
  Discogs: "discogs",
  Discord: "discord",
  Expo: "expo",
  Firecrawl: "firecrawl",
  Gemini: "googlegemini",
  IndexNow: "indexnow",
  Instagram: "instagram",
  "Last.fm": "lastdotfm",
  Mixcloud: "mixcloud",
  MuQ: "muq",
  MusicBrainz: "musicbrainz",
  Postiz: "postiz",
  Raycast: "raycast",
  Remotion: "remotion",
  Spotify: "spotify",
  Telegram: "telegram",
  TikTok: "tiktok",
  YouTube: "youtube",
};

// col = x grid, lane = y grid (0 = the centre spine)
const S: Station[] = [
  // Act 1 · the find
  {
    col: 0,
    id: "cmdf",
    label: "CMD+F",
    lane: 0,
    m: "browser",
    spr: "⌨",
    svc: ["Raycast"],
    wh: "clipboard → CLI",
  },
  {
    col: 1,
    id: "spot",
    label: "Spotify metadata",
    lane: 0,
    m: "worker",
    svc: ["Spotify"],
    wh: "title, art, ISRC",
  },
  {
    col: 1,
    id: "deez",
    label: "Deezer label",
    lane: -1,
    m: "worker",
    svc: ["Deezer"],
    wh: "best-effort",
  },
  {
    col: 1,
    id: "disc",
    label: "Discogs resolve",
    lane: 1,
    m: "worker",
    svc: ["Discogs", "MusicBrainz"],
    wh: "via MusicBrainz",
  },
  {
    col: 2,
    id: "logid",
    img: "press",
    label: "Log ID mint",
    lane: 0,
    m: "worker",
    wh: "the coordinate",
  },
  {
    col: 3,
    id: "gate1",
    label: "Spotify playlist",
    lane: 0,
    m: "worker",
    svc: ["Spotify"],
    wh: "retry 3×",
  },
  {
    col: 4,
    id: "gate2",
    label: "Telegram post",
    lane: 0,
    m: "worker",
    svc: ["Telegram"],
    wh: "retry 3×",
  },
  {
    col: 4,
    id: "ff",
    label: "push · love · ping",
    lane: -1.05,
    m: "worker",
    svc: ["Last.fm", "IndexNow"],
    wh: "fire-and-forget",
  },

  // Act 2 · enrichment floor (capture feeds analysis + embedding)
  {
    cad: "5m",
    col: 5.5,
    cron: "capture",
    id: "cap",
    label: "Full-song capture",
    lane: -1.35,
    m: "rave02",
    wh: "→ private R2",
  },
  {
    cad: "5m",
    col: 7,
    cron: "enrich",
    id: "enr",
    img: "spectrograph",
    label: "Audio analysis",
    lane: -2.15,
    m: "rave02",
    wh: "BPM · key · features",
  },
  {
    cad: "5m",
    col: 7,
    cron: "embed",
    id: "emb",
    label: "Audio embedding",
    lane: -0.95,
    m: "rave02",
    svc: ["MuQ"],
    wh: "1024-d vector",
  },
  {
    col: 8.3,
    id: "reco",
    label: "Recommendation engine",
    lane: -1.3,
    m: "worker",
    wh: "cosine → Close in sound",
  },
  {
    cad: "5m",
    col: 5.9,
    cron: "context-note",
    id: "ctx",
    kind: "pivot",
    label: "Context note",
    lane: 0.35,
    m: "rave02",
    svc: ["Firecrawl", "Claude"],
    wh: "the fan-in gate",
  },
  {
    cad: "30m",
    col: 5.9,
    cron: "backfill",
    id: "bkf",
    label: "Backfill",
    lane: 1.85,
    m: "rave02",
    svc: ["Discogs", "Last.fm"],
    wh: "Discogs · Last.fm",
  },
  {
    cad: "10m",
    col: 8.3,
    cron: "note",
    id: "note",
    label: "Editorial note",
    lane: -0.1,
    m: "rave02",
    svc: ["Claude"],
    wh: "fill-empty-only",
  },
  {
    cad: "60m",
    col: 8.3,
    cron: "observation",
    id: "obs",
    img: "booth",
    label: "Spoken observation",
    lane: 1.05,
    m: "rave02",
    svc: ["Claude", "Cartesia"],
    wh: "authored → rendered",
  },
  {
    cad: "60m",
    col: 8.3,
    cron: "render",
    id: "rend",
    img: "renderbox",
    label: "Video render",
    lane: 2.2,
    m: "rave03",
    svc: ["Box", "Gemini", "Remotion"],
    wh: "wakes the render box",
  },

  // Act 3 · dispatch
  {
    col: 10,
    id: "yt",
    kind: "human",
    label: "YouTube Short",
    lane: -0.6,
    m: "worker",
    svc: ["Postiz", "YouTube"],
    wh: "direct public",
  },
  {
    col: 10,
    id: "tk",
    kind: "human",
    label: "TikTok draft",
    lane: 0.6,
    m: "worker",
    svc: ["Postiz", "TikTok"],
    wh: "inbox → you finish",
  },
];

// the plaza · every surface — each cabinet links to its live home (or the /docs entry
// that documents it); the Lens extension links out to the Chrome Web Store.
const K: Kiosk[] = [
  { label: "web", tint: "#f0a24a", url: "https://www.fluncle.com/", wh: "the archive" },
  { label: "/log", tint: "#ffcf70", url: "https://www.fluncle.com/log", wh: "the coordinate" },
  { label: "galaxy", tint: "#ab7bff", url: "https://galaxy.fluncle.com", wh: "the game" },
  { label: "radio", tint: "#6f9bd6", url: "https://radio.fluncle.com", wh: "observations" },
  { label: "CLI", tint: "#4fb39a", url: "https://www.fluncle.com/docs", wh: "terminal" },
  { label: "SSH", tint: "#63d69a", url: "https://www.fluncle.com/docs", wh: "rave." },
  {
    label: "MCP",
    tint: "#8e9bd6",
    url: "https://www.fluncle.com/.well-known/mcp/server-card.json",
    wh: "agent tools",
  },
  { label: "dig", tint: "#e0897d", url: "https://www.fluncle.com/docs", wh: "DNS TXT" },
  { label: "RSS", tint: "#f38020", url: "https://www.fluncle.com/rss.xml", wh: "feeds" },
  { label: "API", tint: "#d6b24a", url: "https://www.fluncle.com/docs/api", wh: "JSON" },
  { label: "mobile", tint: "#7bd0c0", url: "https://www.fluncle.com/stories", wh: "Stories" },
  {
    label: "Lens",
    tint: "#ff8f6b",
    url: "https://chromewebstore.google.com/detail/efkkceaofendabikblfjhoepgejfpakk",
    wh: "extension",
  },
];

// the mixtape dream-tail (Fluncle dreaming); +2 cols to sit in the shifted galaxy
const D: Station[] = [
  { col: 13.5, id: "plan", label: "Plan", lane: 0, m: "m5", wh: "line up findings" },
  { col: 14.4, id: "rec", label: "Record set", lane: 0, m: "m2", wh: "OBS · decks" },
  {
    cad: "15m",
    col: 15.3,
    cron: "studio-clip",
    id: "cut",
    label: "Cut clips",
    lane: 0,
    m: "rave02",
    wh: "9:16 sweep",
  },
  { col: 16.2, id: "prom", label: "Promote", lane: 0, m: "m5", wh: "mint F-coordinate" },
  {
    col: 17.1,
    id: "dist",
    label: "Distribute",
    lane: 0,
    m: "m5",
    svc: ["YouTube", "Mixcloud"],
    wh: "YouTube · Mixcloud",
  },
  { col: 18.0, id: "setv", label: "Set video", lane: 0, m: "m5", wh: "hour-long render" },
  {
    cad: "20m",
    col: 18.9,
    cron: "clip-drip",
    id: "drip",
    label: "Clip drip",
    lane: 0,
    m: "rave02",
    svc: ["Instagram"],
    wh: "→ Instagram",
  },
];

// [from, to, gold?]
const LINKS: Array<[string, string, number?]> = [
  ["cmdf", "spot", 1],
  ["spot", "logid", 1],
  ["deez", "logid"],
  ["disc", "logid"],
  ["logid", "gate1", 1],
  ["gate1", "gate2", 1],
  ["gate2", "ff"],
  ["gate2", "cap", 1],
  ["cap", "enr", 1],
  ["cap", "emb", 1],
  ["emb", "reco", 1],
  ["gate2", "ctx", 1],
  ["gate2", "bkf"],
  ["ctx", "note"],
  ["ctx", "obs", 1],
  ["ctx", "rend"],
  ["rend", "yt"],
  ["rend", "tk"],
];
const DLINKS: Array<[string, string]> = [
  ["plan", "rec"],
  ["rec", "cut"],
  ["cut", "prom"],
  ["prom", "dist"],
  ["dist", "setv"],
  ["setv", "drip"],
];

// geometry
const COLW = 232,
  LANEH = 122,
  CY = 478,
  CARDW = 188,
  CARDH = 64,
  PADX = 130;
const B = (c: number) => PADX + c * COLW;
const WORLDW = B(22.9),
  WORLDH = 1000;
const SVGNS = "http://www.w3.org/2000/svg";

const STYLES = `
.fpl{--bg:#090a0b;--panel:#10100d;--line:#241f18;--cream:#f4ead7;--cream-dim:#b7ab95;--faint:#6e6657;
  --gold:#ffd057;--gold-2:#b88a00;--red:#ff6b57;--m-worker:#e8833a;--m-rave02:#6f9bd6;--m-rave03:#ab7bff;
  --m-m5:#4fb39a;--m-m2:#e0897d;--m-browser:#9aa0ad;
  position:absolute;inset:0;color:var(--cream);
  font:13px/1.4 ui-sans-serif,-apple-system,"Segoe UI",system-ui,sans-serif;-webkit-font-smoothing:antialiased}
.fpl *{box-sizing:border-box}
.fpl .top{position:absolute;inset:0 0 auto 0;z-index:30;display:flex;gap:30px;align-items:flex-start;
  padding:15px 22px 24px;background:linear-gradient(#090a0bf5,#090a0b00);pointer-events:none}
.fpl .brand h1{margin:0;font-size:15px;font-weight:700;letter-spacing:-.015em}
.fpl .brand .tag{margin:3px 0 0;font-size:11px;color:var(--faint)}
.fpl .legend-wrap{display:flex;flex-direction:column;gap:7px;pointer-events:auto}
.fpl .legend-lbl{font-size:9px;letter-spacing:.18em;text-transform:uppercase;color:#4f4838;font-weight:700}
.fpl .legend{display:flex;gap:8px 14px;flex-wrap:wrap;max-width:530px}
.fpl .legend .k{display:flex;align-items:center;gap:6px;color:var(--cream-dim);font-size:11px}
.fpl .legend .sw{width:9px;height:9px;border-radius:2px;display:inline-block;flex:none}
.fpl .meta{margin-left:auto;display:flex;flex-direction:column;align-items:flex-end;gap:6px;text-align:right}
.fpl .hint{color:var(--faint);font-size:11px;pointer-events:none}
.fpl .hint b{color:var(--cream-dim);font-weight:600}
.fpl .stage{position:absolute;inset:0;cursor:grab;touch-action:none}
.fpl .stage.drag{cursor:grabbing}
.fpl .world{position:absolute;top:0;left:0;will-change:transform;transform-origin:0 0}
.fpl .zoomctl{position:absolute;right:20px;bottom:18px;z-index:30;display:flex;align-items:center;gap:1px;
  background:#10100dcc;border:1px solid var(--line);border-radius:10px;padding:3px;box-shadow:0 6px 18px #0007;
  -webkit-backdrop-filter:blur(5px);backdrop-filter:blur(5px)}
.fpl .zoomctl button{all:unset;cursor:pointer;color:var(--cream-dim);font-size:16px;line-height:1;width:28px;height:28px;
  display:grid;place-items:center;border-radius:7px;transition:background .1s}
.fpl .zoomctl button:hover{background:#ffffff12;color:var(--cream)}
.fpl .zoomctl button:focus-visible{outline:2px solid var(--gold-2);outline-offset:1px}
.fpl .zoomctl .zlabel{font-size:11px;font-weight:600;color:var(--faint);width:44px;font-variant-numeric:tabular-nums}
.fpl .zoomctl .zlabel:hover{color:var(--cream-dim);background:transparent}
.fpl .band{position:absolute;top:0;height:1000px}
.fpl .band .tag{position:absolute;top:100px;left:16px;font-size:12px;letter-spacing:.16em;text-transform:uppercase;
  color:var(--faint);font-weight:600;white-space:nowrap}
.fpl .band .sub{position:absolute;top:120px;left:16px;font-size:11px;color:#3f3a30;white-space:nowrap}
.fpl .divider{position:absolute;top:92px;bottom:150px;width:1px;background:linear-gradient(#241f1800,#2b2519,#241f1800)}
.fpl .wires{position:absolute;top:0;left:0;overflow:visible;pointer-events:none}
.fpl .card{position:absolute;width:188px;min-height:56px;background:var(--panel);border:1px solid var(--line);
  border-top:3px solid var(--m-worker);border-radius:9px;padding:9px 11px;box-shadow:0 6px 18px #0007;
  display:flex;gap:9px;align-items:flex-start}
.fpl .card .body{flex:1;min-width:0}
.fpl .card .spr{width:42px;height:42px;flex:none;border-radius:5px;background:#0000002e;display:grid;place-items:center;
  font-size:15px;opacity:.96}
.fpl .card .spr img{width:100%;height:100%;object-fit:contain;image-rendering:pixelated}
.fpl .card .lb{font-size:12.5px;font-weight:600;letter-spacing:-.005em;line-height:1.22}
.fpl .card .wh{font-size:10.5px;color:var(--cream-dim);margin-top:2px}
.fpl .card .row{display:flex;gap:4px;flex-wrap:wrap;margin-top:6px}
.fpl .chip{font-size:9.5px;letter-spacing:.02em;padding:1px 5px;border-radius:999px;background:#ffffff10;
  color:var(--cream-dim);white-space:nowrap}
.fpl .chip.svc{background:#ffffff14;color:var(--cream);display:inline-flex;align-items:center;gap:3px}
.fpl .chip .ico{width:12px;height:12px;opacity:1;flex:none}
.fpl .chip.cad{background:#00000040;color:var(--faint)}
@keyframes fpl-hbpulse{0%{box-shadow:0 0 0 0 var(--pc)}70%{box-shadow:0 0 0 5px transparent}100%{box-shadow:0 0 0 0 transparent}}
.fpl .hb{display:inline-block;width:7px;height:7px;border-radius:50%;background:#4b4536;margin-right:5px;
  vertical-align:middle;position:relative;top:-1px}
.fpl .hb.ok{background:#63d69a;--pc:#63d69a80;animation:fpl-hbpulse 1.8s ease-out infinite}
.fpl .hb.primed{background:#c8b06a}
.fpl .hb.warn{background:#ffd057;--pc:#ffd05799;animation:fpl-hbpulse 1.2s ease-out infinite}
.fpl .hb.down{background:#ff6b57;--pc:#ff6b5799;animation:fpl-hbpulse .9s ease-out infinite}
.fpl .hbstat{color:var(--cream-dim);font-size:11px;display:flex;align-items:center;gap:6px;pointer-events:none}
.fpl .hbstat .dot{width:7px;height:7px;border-radius:50%;background:#63d69a;--pc:#63d69a80;animation:fpl-hbpulse 1.8s ease-out infinite}
.fpl .card.pivot{border:1px solid var(--gold-2);box-shadow:0 0 0 1px #ffd05733,0 6px 22px #0008}
.fpl .card.human{border-top-style:dashed}
.fpl .card.dream{background:#120f16}
.fpl .kiosk{position:absolute;width:104px;text-align:center;text-decoration:none;color:inherit;cursor:pointer;
  --tint:#e8833a;transition:transform .13s ease}
.fpl .kiosk:hover{transform:translateY(-4px)}
.fpl .kiosk:focus-visible{outline:2px solid var(--tint);outline-offset:4px;border-radius:8px}
.fpl .kiosk img{width:76px;height:76px;image-rendering:pixelated;display:block;margin:0 auto 2px;
  filter:drop-shadow(0 0 8px color-mix(in srgb,var(--tint) 55%,transparent)) drop-shadow(0 5px 7px #0009)}
.fpl .kiosk:hover img{filter:drop-shadow(0 0 14px color-mix(in srgb,var(--tint) 82%,transparent)) drop-shadow(0 7px 9px #000a)}
.fpl .kiosk .lb{font-size:11px;font-weight:600;color:color-mix(in srgb,var(--tint) 66%,var(--cream))}
.fpl .kiosk .wh{font-size:9.5px;color:var(--faint)}
.fpl .kiosk:hover .wh{color:var(--cream-dim)}
`;

const CHROME = `
<header class="top">
  <div class="brand">
    <h1>/pipeline</h1>
    <p class="tag">one finding, from the dig to the Galaxy</p>
  </div>
  <div class="legend-wrap">
    <span class="legend-lbl">where it runs</span>
    <div class="legend"></div>
  </div>
  <div class="meta">
    <div class="hbstat"><span class="dot"></span>connecting…</div>
    <div class="hint">drag to pan · plaza <b class="plazatag">boardwalk</b> · press 1·2·3</div>
  </div>
</header>
<div class="stage"><div class="world"><svg class="wires"></svg></div></div>
<div class="zoomctl">
  <button class="zout" aria-label="Zoom out" title="Zoom out">−</button>
  <button class="zlabel" title="Reset zoom">100%</button>
  <button class="zin" aria-label="Zoom in" title="Zoom in">+</button>
</div>
`;

// keep vivid brand colours; lift only DESATURATED-dark marks toward warm cream so they read on near-black
function fillFor(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16),
    g = parseInt(hex.slice(3, 5), 16),
    b = parseInt(hex.slice(5, 7), 16);
  const mx = Math.max(r, g, b),
    mn = Math.min(r, g, b),
    lum = 0.2126 * r + 0.7152 * g + 0.0722 * b,
    sat = mx ? (mx - mn) / mx : 0;
  if (lum >= 95 || sat >= 0.35) {
    return hex;
  }
  const t = 0.7;
  const cr: [number, number, number] = [244, 234, 215];
  return `rgb(${Math.round(r + (cr[0] - r) * t)},${Math.round(g + (cr[1] - g) * t)},${Math.round(b + (cr[2] - b) * t)})`;
}
function svcChip(v: string): string {
  const L = LOGOS[SLUG[v] ?? ""];
  const ico = L
    ? `<svg class="ico" viewBox="${L.vb}" style="fill:${fillFor(L.hex)}"><path d="${L.d}"/></svg>`
    : "";
  return `<span class="chip svc">${ico}${v}</span>`;
}

function mulberry(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createPipeline(container: HTMLElement): { destroy: () => void } {
  container.classList.add("fpl");
  const style = document.createElement("style");
  style.textContent = STYLES;
  container.appendChild(style);
  container.insertAdjacentHTML("beforeend", CHROME);

  const q = <T extends Element>(sel: string): T => {
    const el = container.querySelector<T>(sel);
    if (!el) {
      throw new Error(`/pipeline: missing ${sel}`);
    }
    return el;
  };
  const world = q<HTMLDivElement>(".world");
  const wires = q<SVGSVGElement>(".wires");
  const stage = q<HTMLDivElement>(".stage");

  const pos: Record<string, Pos> = {};
  const xy = (col: number, lane: number) => ({ x: PADX + col * COLW, y: CY + lane * LANEH });

  function card(s: Station): void {
    const { x, y } = xy(s.col, s.lane);
    pos[s.id] = { w: CARDW, x, y };
    const el = document.createElement("div");
    el.className =
      "card" +
      (s.kind === "pivot" ? " pivot" : "") +
      (s.kind === "human" ? " human" : "") +
      (s.dream ? " dream" : "");
    el.style.left = x + "px";
    el.style.top = y - CARDH / 2 + "px";
    el.style.borderTopColor = `var(${MACH[s.m].c})`;
    const cad = s.cad
      ? `<span class="chip cad">${s.cron ? `<span class="hb" data-cron="${s.cron}"></span>` : ""}${s.cad}</span>`
      : "";
    const chips = (s.svc ?? []).map(svcChip).join("") + cad;
    const glyph = s.spr ?? "▦";
    const spr = `<img src="${SPRITE(s.img ?? s.id)}" alt="" onerror="this.outerHTML='<span>${glyph}</span>'">`;
    el.innerHTML =
      `<div class="body"><div class="lb">${s.label}</div><div class="wh">${s.wh}</div>` +
      `<div class="row">${chips}</div></div><div class="spr">${spr}</div>`;
    world.appendChild(el);
  }

  function band(x0: number, x1: number, tag: string, sub: string, divider: boolean): void {
    const b = document.createElement("div");
    b.className = "band";
    b.style.left = x0 + "px";
    b.style.width = x1 - x0 + "px";
    b.innerHTML = `<div class="tag">${tag}</div><div class="sub">${sub}</div>`;
    world.appendChild(b);
    if (divider) {
      const d = document.createElement("div");
      d.className = "divider";
      d.style.left = x1 + "px";
      world.appendChild(d);
    }
  }

  band(B(-0.2), B(4.55), "Act 1 · the find", "synchronous · one request · in the Worker", true);
  band(
    B(4.55),
    B(9.35),
    "Act 2 · enrichment floor",
    "async · self-healing crons · parallel lanes",
    true,
  );
  band(B(9.35), B(11.0), "Act 3 · dispatch", "human-gated publish", true);
  band(B(11.0), B(14.9), "the plaza · every surface", "one finding, many faces", true);
  band(
    B(14.9),
    B(22.6),
    "the galaxy · launch",
    "findings become stars · mixtapes are Fluncle dreaming",
    false,
  );

  // ── galaxy starfield — the same look as Fluncle's Galaxy game: a cream 1px twinkle field
  // (creamDim/Muted/cream ramp, 0.7+0.3·sin twinkle) plus a scatter of pulsing gold "banger"
  // diamonds — every banger is a star, and a banger is a (gold) record.
  const GX0 = B(14.6),
    GW = Math.round(B(22.9) + 140 - GX0),
    GH = 1000;
  const sky = document.createElement("canvas");
  sky.width = GW;
  sky.height = GH;
  sky.style.cssText = `position:absolute;left:${GX0}px;top:0;width:${GW}px;height:${GH}px;image-rendering:pixelated;pointer-events:none`;
  world.insertBefore(sky, world.firstChild);
  const sctx = sky.getContext("2d");
  const rmSky = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const rnd = mulberry(0x51ede2);
  const CREAM = ["#6e6657", "#6e6657", "#6e6657", "#b7ab95", "#b7ab95", "#f4ead7"];
  const dust = Array.from({ length: 150 }, () => ({
    big: rnd() < 0.12,
    ink: CREAM[Math.floor(rnd() * CREAM.length)] ?? "#6e6657",
    ph: rnd() * 6.28,
    x: Math.floor(rnd() * GW),
    y: Math.floor(rnd() * (GH - 40)),
  }));
  const bangers = Array.from({ length: 10 }, () => ({
    ph: rnd() * 6.28,
    r: 2 + Math.floor(rnd() * 3),
    x: 30 + Math.floor(rnd() * (GW - 60)),
    y: 60 + Math.floor(rnd() * (GH - 260)),
  }));
  function diamond(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    r: number,
    ink: string,
  ): void {
    ctx.fillStyle = ink;
    for (let dy = -r; dy <= r; dy++) {
      const span = r - Math.abs(dy);
      ctx.fillRect(x - span, y + dy, span * 2 + 1, 1);
    }
  }
  function drawSky(t: number): void {
    if (!sctx) {
      return;
    }
    sctx.clearRect(0, 0, GW, GH);
    for (const s of dust) {
      sctx.globalAlpha = rmSky ? 0.85 : 0.7 + 0.3 * Math.sin(t * 1.7 + s.ph);
      sctx.fillStyle = s.ink;
      const z = s.big ? 2 : 1;
      sctx.fillRect(s.x, s.y, z, z);
    }
    for (const b of bangers) {
      const r = Math.max(1, Math.round(b.r + (rmSky ? 0 : Math.sin(t * 4 + b.x) * b.r * 0.35)));
      sctx.globalAlpha = 0.28;
      diamond(sctx, b.x, b.y, r + 2, "#b88a00");
      sctx.globalAlpha = 0.9;
      diamond(sctx, b.x, b.y, r, "#f5b800");
      sctx.globalAlpha = 1;
      diamond(sctx, b.x, b.y, Math.max(1, Math.round(r * 0.55)), "#ffd057");
    }
    sctx.globalAlpha = 1;
  }
  let rafId = 0;
  const skyLoop = (ms: number) => {
    drawSky(ms / 1000);
    rafId = requestAnimationFrame(skyLoop);
  };
  rafId = requestAnimationFrame(skyLoop);

  // the One Sun — a bespoke pixel-art star, deep in the galaxy (the canvas's whole gold budget)
  const sun = document.createElement("img");
  sun.src = SPRITE("sun");
  sun.alt = "";
  sun.style.cssText =
    `position:absolute;left:${B(21.0)}px;top:${CY - 268}px;width:206px;image-rendering:pixelated;` +
    `pointer-events:none;filter:drop-shadow(0 0 46px #ffd05733) drop-shadow(0 0 12px #f5b80033)`;
  world.appendChild(sun);

  // stations + dream tail
  S.forEach(card);
  D.forEach((d) => card({ ...d, col: d.col + 2, dream: true }));

  // launching-finding rockets — an ascending trail up-right off the galaxy mouth
  (
    [
      [15.3, -105, 52],
      [15.75, -185, 44],
      [16.2, -265, 38],
    ] as const
  ).forEach(([c, dy, w]) => {
    const im = document.createElement("img");
    im.src = SPRITE("rocket");
    im.alt = "";
    im.style.cssText =
      `position:absolute;image-rendering:pixelated;width:${w}px;left:${B(c)}px;top:${CY + dy}px;` +
      `transform:rotate(-10deg);opacity:.96;pointer-events:none`;
    world.appendChild(im);
  });

  // wires
  function wirePath(a: string, b: string, gold?: number): string {
    const A = pos[a],
      B2 = pos[b];
    if (!A || !B2) {
      return "";
    }
    const x1 = A.x + A.w,
      y1 = A.y,
      x2 = B2.x,
      y2 = B2.y,
      mx = (x1 + x2) / 2;
    return (
      `<path d="M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}" fill="none" ` +
      `stroke="${gold ? "#ffd05740" : "#4b4536"}" stroke-width="${gold ? 2 : 1.4}"/>`
    );
  }
  let paths = "";
  LINKS.forEach(([a, b, g]) => {
    paths += wirePath(a, b, g);
  });
  DLINKS.forEach(([a, b]) => {
    paths += wirePath(a, b);
  });
  const axisY = CY + 3.35 * LANEH,
    AX0 = B(-0.2),
    AX1 = B(22.5);
  paths += `<line x1="${AX0}" y1="${axisY}" x2="${AX1}" y2="${axisY}" stroke="#4b4536" stroke-width="1.4"/>`;
  [2.2, 7, 10.2, 12.9, 18.5].forEach((c) => {
    paths += `<circle cx="${B(c)}" cy="${axisY}" r="4" fill="none" stroke="#7a6f57" stroke-width="1.4"/>`;
  });
  [4.55, 9.35, 11.0, 14.9].forEach((c) => {
    const ax = B(c);
    paths += `<path d="M${ax - 6},${axisY - 4} L${ax},${axisY} L${ax - 6},${axisY + 4}" fill="none" stroke="#5a5343" stroke-width="1.4"/>`;
  });
  wires.innerHTML = paths;
  wires.setAttribute("width", String(AX1 + 200));
  wires.setAttribute("height", "980");

  // ── the plaza · every surface (clickable arcade cabinets · 3 flow layouts) ──
  const plaza = document.createElement("div");
  plaza.className = "plaza";
  world.appendChild(plaza);
  const plazaG = document.createElementNS(SVGNS, "g");
  wires.appendChild(plazaG);
  const MERGE = B(11.0),
    GALX = B(15.05);
  function kioskEl(k: Kiosk): HTMLAnchorElement {
    const a = document.createElement("a");
    a.className = "kiosk";
    a.href = k.url;
    a.target = "_blank";
    a.rel = "noopener";
    a.title = `${k.label} · ${k.wh}`;
    a.style.setProperty("--tint", k.tint);
    a.innerHTML = `<img src="${SPRITE("kiosk")}" alt=""><div class="lb">${k.label}</div><div class="wh">${k.wh}</div>`;
    return a;
  }
  const stem = (x1: number, y1: number, x2: number, y2: number) => {
    const my = (y1 + y2) / 2;
    return `<path d="M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2}" fill="none" stroke="#4b4536" stroke-width="1.3"/>`;
  };
  const fan = (x1: number, y1: number, x2: number, y2: number) => {
    const mx = (x1 + x2) / 2;
    return `<path d="M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}" fill="none" stroke="#4b4536" stroke-width="1.2"/>`;
  };
  const spine = (x1: number, y1: number, x2: number, y2: number) =>
    `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#ffd05740" stroke-width="2"/>`;
  const gcurve = (x1: number, y1: number, x2: number, y2: number) => {
    const mx = (x1 + x2) / 2;
    return `<path d="M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}" fill="none" stroke="#ffd05740" stroke-width="2"/>`;
  };
  const PNAME: Record<string, string> = { grid: "grid", rise: "ascent", walk: "boardwalk" };
  const plazatag = q<HTMLElement>(".plazatag");
  function renderPlaza(v: string): void {
    plaza.innerHTML = "";
    plazaG.innerHTML = "";
    let wire = "";
    const ey = v === "rise" ? CY - 118 : CY;
    const yt = pos.yt,
      tk = pos.tk;
    if (yt && tk) {
      wire += gcurve(yt.x + yt.w, yt.y, MERGE, CY) + gcurve(tk.x + tk.w, tk.y, MERGE, CY);
    }
    if (v === "walk" || v === "rise") {
      const lineY = (x: number) => CY + (ey - CY) * ((x - MERGE) / (GALX - MERGE));
      const x0 = B(11.3),
        gapx = 128,
        off = [-132, 26];
      K.forEach((k, i) => {
        const col = i % 6,
          row = Math.floor(i / 6),
          x = x0 + col * gapx,
          kx = x + 52,
          sy = lineY(kx);
        const y = sy + (off[row] ?? 0);
        const a = kioskEl(k);
        a.style.left = x + "px";
        a.style.top = y + "px";
        plaza.appendChild(a);
        wire += stem(kx, sy, kx, row === 0 ? y + 96 : y + 6);
      });
      wire += spine(MERGE, CY, GALX, ey);
    } else {
      const hubX = B(11.15),
        x0 = B(11.65),
        gx = 118,
        gy = 118;
      K.forEach((k, i) => {
        const col = i % 3,
          row = Math.floor(i / 3),
          x = x0 + col * gx,
          y = CY + (row - 1.5) * gy,
          kx = x + 52,
          ky = y + 52;
        const a = kioskEl(k);
        a.style.left = x + "px";
        a.style.top = y + "px";
        plaza.appendChild(a);
        wire += fan(hubX, CY, kx, ky);
      });
      wire += spine(MERGE, CY, hubX, CY) + spine(hubX, CY, GALX, CY);
    }
    wire += gcurve(GALX, ey, B(15.35), CY - 92);
    const plan = pos.plan;
    if (plan) {
      wire += gcurve(GALX, ey, plan.x, plan.y);
    }
    plazaG.innerHTML = wire;
    plazatag.textContent = PNAME[v] ?? v;
  }
  renderPlaza("walk");

  // ── pan + zoom ──
  let tx = 0,
    ty = 0,
    zoom = 1,
    dragging = false,
    sx = 0,
    sy = 0,
    bx = 0,
    by = 0,
    moved = false;
  let downT: EventTarget | null = null;
  const zlabel = q<HTMLElement>(".zlabel");
  function clamp(): void {
    const vw = window.innerWidth,
      vh = window.innerHeight,
      ww = WORLDW * zoom,
      wh = WORLDH * zoom;
    tx = Math.min(0, Math.max(vw - ww, tx));
    ty = Math.min(30, Math.max(vh - wh, ty));
    world.style.transform = `translate(${tx}px,${ty}px) scale(${zoom})`;
  }
  function renderZoom(): void {
    zlabel.textContent = Math.round(zoom * 100) + "%";
  }
  function setZoom(nz: number, cx?: number, cy?: number): void {
    const z = Math.min(2.2, Math.max(0.4, nz));
    if (Math.abs(z - zoom) < 1e-4) {
      return;
    }
    const px = cx ?? window.innerWidth / 2,
      py = cy ?? window.innerHeight / 2;
    const wx = (px - tx) / zoom,
      wy = (py - ty) / zoom;
    zoom = z;
    tx = px - wx * zoom;
    ty = py - wy * zoom;
    clamp();
    renderZoom();
  }
  clamp();
  renderZoom();
  stage.addEventListener("pointerdown", (e) => {
    dragging = true;
    moved = false;
    downT = e.target;
    stage.classList.add("drag");
    sx = e.clientX;
    sy = e.clientY;
    bx = tx;
    by = ty;
    stage.setPointerCapture(e.pointerId);
  });
  stage.addEventListener("pointermove", (e) => {
    if (!dragging) {
      return;
    }
    if (Math.abs(e.clientX - sx) + Math.abs(e.clientY - sy) > 6) {
      moved = true;
    }
    tx = bx + (e.clientX - sx);
    ty = by + (e.clientY - sy);
    clamp();
  });
  stage.addEventListener("pointerup", () => {
    dragging = false;
    stage.classList.remove("drag");
    if (!moved && downT instanceof Element) {
      const a = downT.closest<HTMLAnchorElement>("a.kiosk");
      if (a) {
        window.open(a.href, "_blank", "noopener");
      }
    }
  });
  stage.addEventListener(
    "wheel",
    (e) => {
      if (e.ctrlKey || e.metaKey) {
        setZoom(zoom * (e.deltaY < 0 ? 1.12 : 0.9), e.clientX, e.clientY);
        e.preventDefault();
        return;
      }
      tx -= e.deltaX + (e.shiftKey ? e.deltaY : 0);
      if (!e.shiftKey) {
        ty -= e.deltaY;
      }
      clamp();
      e.preventDefault();
    },
    { passive: false },
  );
  const onKey = (e: KeyboardEvent): void => {
    const s = 100;
    if (e.key === "ArrowRight") {
      tx -= s;
    }
    if (e.key === "ArrowLeft") {
      tx += s;
    }
    if (e.key === "ArrowUp") {
      ty += s;
    }
    if (e.key === "ArrowDown") {
      ty -= s;
    }
    if (e.key === "1") {
      renderPlaza("walk");
    }
    if (e.key === "2") {
      renderPlaza("rise");
    }
    if (e.key === "3") {
      renderPlaza("grid");
    }
    if (e.key === "+" || e.key === "=") {
      setZoom(zoom * 1.15);
    }
    if (e.key === "-" || e.key === "_") {
      setZoom(zoom / 1.15);
    }
    if (e.key === "0") {
      setZoom(1);
    }
    clamp();
  };
  const onResize = (): void => clamp();
  window.addEventListener("keydown", onKey);
  window.addEventListener("resize", onResize);
  q<HTMLButtonElement>(".zin").addEventListener("click", () => setZoom(zoom * 1.2));
  q<HTMLButtonElement>(".zout").addEventListener("click", () => setZoom(zoom / 1.2));
  zlabel.addEventListener("click", () => setZoom(1));

  // legend
  q<HTMLDivElement>(".legend").innerHTML = Object.values(MACH)
    .map(
      (m) =>
        `<span class="k"><span class="sw" style="background:var(${m.c})"></span>${m.label}</span>`,
    )
    .join("");

  // ── the live cron heartbeat (reads the same-origin /api/status) ──
  const hbstat = q<HTMLDivElement>(".hbstat");
  let hbFresh = 0,
    hbTotal = 0,
    hbSince: number | null = null;
  type Svc = { service: string; status: string; message?: string };
  const hbClass = (svc?: Svc): string => {
    if (!svc) {
      return "hb";
    }
    if (svc.status !== "ok") {
      return "hb " + (svc.status === "down" ? "down" : "warn");
    }
    if (/no runs yet/i.test(svc.message ?? "")) {
      return "hb primed";
    }
    return "hb ok";
  };
  const fmtAgo = (s: number): string => {
    const v = Math.max(0, s);
    if (v < 60) {
      return v + "s ago";
    }
    const m = Math.floor(v / 60);
    if (m < 60) {
      return m + "m ago";
    }
    return Math.floor(m / 60) + "h ago";
  };
  function renderHbStat(): void {
    const age = hbSince ? fmtAgo(Math.round((Date.now() - hbSince) / 1000)) : "…";
    hbstat.innerHTML = `<span class="dot"></span>live · ${hbFresh}/${hbTotal} crons fresh · last report ${age}`;
  }
  async function applyStatus(): Promise<void> {
    try {
      const r = await fetch("/api/status", { cache: "no-store" });
      if (!r.ok) {
        return;
      }
      const data = (await r.json()) as { services?: Svc[]; freshestReportAt?: string };
      const by: Record<string, Svc> = {};
      (data.services ?? []).forEach((s) => {
        by[s.service] = s;
      });
      hbFresh = 0;
      hbTotal = 0;
      container.querySelectorAll<HTMLElement>(".hb[data-cron]").forEach((dot) => {
        const name = dot.dataset.cron ?? "";
        const svc = by["cron." + name];
        hbTotal++;
        dot.className = hbClass(svc);
        if (svc && svc.status === "ok" && !/no runs yet/i.test(svc.message ?? "")) {
          hbFresh++;
        }
        dot.title = svc ? `cron.${name} — ${svc.status} · ${svc.message ?? ""}` : "no data";
      });
      hbSince = data.freshestReportAt ? new Date(data.freshestReportAt).getTime() : null;
      renderHbStat();
    } catch {
      // offline / transient — leave the last-known state up
    }
  }
  void applyStatus();
  const statusInterval = window.setInterval(() => void applyStatus(), 30000);
  const tickInterval = window.setInterval(renderHbStat, 1000);

  return {
    destroy() {
      cancelAnimationFrame(rafId);
      window.clearInterval(statusInterval);
      window.clearInterval(tickInterval);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
      container.classList.remove("fpl");
      container.replaceChildren();
    },
  };
}
