// Builds the user-story × surface matrix artifacts from docs/user-stories.json:
// docs/user-stories.html (self-contained pager) + docs/user-stories.csv (derived, never
// hand-edited). Validates the JSON first and exits non-zero on any violation, so a bad
// edit fails `bun run stories:build` instead of shipping a lying matrix.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type CellState = "yes" | "partial" | "no" | "planned" | "n/a";

type Cell = { evidence?: string; note?: string; state: CellState };

type Story = {
  entity: string;
  id: string;
  register: "lore" | "catalogue";
  story: string;
  support: Record<string, Cell>;
};

type Spec = {
  meta: { description: string; title: string; updated: string };
  stories: Story[];
  surfaces: { id: string; label: string; note: string }[];
};

const ROOT = join(import.meta.dir, "..");
const SPEC_PATH = join(ROOT, "docs", "user-stories.json");
const HTML_PATH = join(ROOT, "docs", "user-stories.html");
const CSV_PATH = join(ROOT, "docs", "user-stories.csv");

const STATES: CellState[] = ["yes", "partial", "no", "planned", "n/a"];
const REGISTERS = ["lore", "catalogue"];
const ENTITIES = ["track", "artist", "album", "label", "galaxy", "mixtape", "account", "cross"];

const spec: Spec = JSON.parse(readFileSync(SPEC_PATH, "utf8"));

// ── Validation ───────────────────────────────────────────────────────────────────────────
const surfaceIds = spec.surfaces.map((s) => s.id);
const errors: string[] = [];
const seen = new Set<string>();

for (const story of spec.stories) {
  if (seen.has(story.id)) {
    errors.push(`duplicate story id: ${story.id}`);
  }
  seen.add(story.id);
  if (!REGISTERS.includes(story.register)) {
    errors.push(`${story.id}: bad register "${story.register}"`);
  }
  if (!ENTITIES.includes(story.entity)) {
    errors.push(`${story.id}: bad entity "${story.entity}"`);
  }
  for (const [surface, cell] of Object.entries(story.support)) {
    if (!surfaceIds.includes(surface)) {
      errors.push(`${story.id}: unknown surface "${surface}"`);
    }
    if (!STATES.includes(cell.state)) {
      errors.push(`${story.id}.${surface}: bad state "${cell.state}"`);
    }
    if ((cell.state === "yes" || cell.state === "partial") && !cell.evidence) {
      errors.push(`${story.id}.${surface}: state "${cell.state}" requires evidence`);
    }
  }
}

if (errors.length > 0) {
  console.error(`user-stories.json failed validation (${errors.length}):`);
  for (const e of errors) {
    console.error(`  - ${e}`);
  }
  process.exit(1);
}

// ── CSV (derived) ───────────────────────────────────────────────────────────────────────
const csvEscape = (v: string) => (/[",\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v);
const csvRows = [["register", "entity", "id", "story", ...surfaceIds].join(",")];

for (const story of spec.stories) {
  const cells = surfaceIds.map((id) => story.support[id]?.state ?? "no");
  csvRows.push(
    [story.register, story.entity, story.id, csvEscape(story.story), ...cells].join(","),
  );
}

writeFileSync(CSV_PATH, `${csvRows.join("\n")}\n`);

// ── HTML pager ──────────────────────────────────────────────────────────────────────────
const GLYPH: Record<CellState, string> = {
  "n/a": "—",
  no: "·",
  partial: "◐",
  planned: "◌",
  yes: "●",
};

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${spec.meta.title}</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; padding: 2rem clamp(1rem, 4vw, 3rem); background: #0b0b0d; color: #d8d4c8; font: 15px/1.5 ui-sans-serif, system-ui, sans-serif; }
  h1 { font-size: 1.4rem; margin: 0 0 0.25rem; color: #f2eee2; }
  .sub { color: #8f8a7c; max-width: 70ch; margin: 0 0 1.5rem; }
  .controls { display: flex; flex-wrap: wrap; gap: 0.75rem; margin-bottom: 1.25rem; align-items: center; }
  input[type="search"], select { background: #16161a; color: #d8d4c8; border: 1px solid #2b2b31; border-radius: 6px; padding: 0.4rem 0.6rem; font: inherit; }
  .legend { display: flex; gap: 1rem; flex-wrap: wrap; color: #8f8a7c; font-size: 0.85rem; margin-bottom: 1.5rem; }
  section { margin-bottom: 2rem; }
  h2 { font-size: 0.85rem; letter-spacing: 0.12em; text-transform: uppercase; color: #b3ae9f; border-bottom: 1px solid #232329; padding-bottom: 0.4rem; }
  h2 .reg { color: #6f6a5e; }
  .tablewrap { overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: 0.45rem 0.7rem; border-bottom: 1px solid #1c1c21; vertical-align: top; }
  th { font-size: 0.75rem; letter-spacing: 0.08em; text-transform: uppercase; color: #8f8a7c; position: sticky; top: 0; background: #0b0b0d; }
  td.cell { text-align: center; font-size: 1rem; width: 4.5rem; cursor: default; }
  .s-yes { color: #f5b800; }
  .s-partial { color: #c99f2e; }
  .s-no { color: #4a4a52; }
  .s-planned { color: #7d8fb3; }
  .s-na { color: #333338; }
  tr.gaprow td { background: rgba(245, 184, 0, 0.03); }
  .story { max-width: 44ch; }
  .storyid { color: #6f6a5e; font-size: 0.75rem; display: block; }
  details { margin-top: 0.25rem; }
  summary { color: #8f8a7c; font-size: 0.78rem; cursor: pointer; }
  .ev { font-size: 0.78rem; color: #9f9a8b; margin: 0.25rem 0 0; padding-left: 1rem; }
  .ev b { color: #c9c4b5; font-weight: 600; }
  .hidden { display: none; }
  footer { color: #6f6a5e; font-size: 0.8rem; margin-top: 2rem; }
</style>
</head>
<body>
<h1>${spec.meta.title}</h1>
<p class="sub">${spec.meta.description} Updated ${spec.meta.updated}.</p>
<div class="controls">
  <input type="search" id="q" placeholder="Filter stories…" />
  <select id="reg"><option value="">Both registers</option><option value="lore">Lore</option><option value="catalogue">Catalogue</option></select>
  <select id="gap"><option value="">All rows</option>${spec.surfaces.map((s) => `<option value="${s.id}">Gaps on ${s.label}</option>`).join("")}</select>
</div>
<div class="legend">
  <span><span class="s-yes">●</span> yes</span>
  <span><span class="s-partial">◐</span> partial</span>
  <span><span class="s-planned">◌</span> planned</span>
  <span><span class="s-no">·</span> no</span>
  <span><span class="s-na">—</span> n/a</span>
</div>
<div id="matrix"></div>
<footer>Source of truth: docs/user-stories.json · regenerate with <code>bun run stories:build</code>.</footer>
<script>
const SPEC = ${JSON.stringify({ stories: spec.stories, surfaces: spec.surfaces })};
const GLYPH = ${JSON.stringify(GLYPH)};
const cls = (s) => "s-" + (s === "n/a" ? "na" : s);
const ENTITY_ORDER = ${JSON.stringify(ENTITIES)};

function cellFor(story, id) { return story.support[id] ?? { state: "no" }; }

function render() {
  const q = document.getElementById("q").value.toLowerCase();
  const reg = document.getElementById("reg").value;
  const gap = document.getElementById("gap").value;
  const groups = new Map();
  for (const story of SPEC.stories) {
    if (reg && story.register !== reg) continue;
    if (q && !(story.story.toLowerCase().includes(q) || story.id.includes(q))) continue;
    if (gap) {
      const state = cellFor(story, gap).state;
      if (state === "yes" || state === "n/a") continue;
    }
    const key = story.register + "/" + story.entity;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(story);
  }
  const keys = [...groups.keys()].sort((a, b) => {
    const [ra, ea] = a.split("/");
    const [rb, eb] = b.split("/");
    if (ra !== rb) return ra === "catalogue" ? -1 : 1;
    return ENTITY_ORDER.indexOf(ea) - ENTITY_ORDER.indexOf(eb);
  });
  const out = [];
  for (const key of keys) {
    const [register, entity] = key.split("/");
    const rows = groups.get(key).map((story) => {
      const cells = SPEC.surfaces.map((s) => {
        const c = cellFor(story, s.id);
        const tip = [s.label + ": " + c.state, c.evidence, c.note].filter(Boolean).join(" — ");
        return '<td class="cell ' + cls(c.state) + '" title="' + tip.replaceAll('"', "&quot;") + '">' + GLYPH[c.state] + "</td>";
      }).join("");
      const evidence = SPEC.surfaces
        .map((s) => ({ c: cellFor(story, s.id), s }))
        .filter((x) => x.c.evidence || x.c.note)
        .map((x) => "<div class=\\"ev\\"><b>" + x.s.label + "</b> (" + x.c.state + ") " + (x.c.evidence ?? "") + (x.c.note ? " — " + x.c.note : "") + "</div>")
        .join("");
      const gapRow = gap ? ' class="gaprow"' : "";
      return "<tr" + gapRow + '><td class="story">' + story.story +
        '<span class="storyid">' + story.id + "</span>" +
        (evidence ? "<details><summary>evidence</summary>" + evidence + "</details>" : "") +
        "</td>" + cells + "</tr>";
    }).join("");
    out.push('<section><h2>' + entity + ' <span class="reg">· ' + register + "</span></h2>" +
      '<div class="tablewrap"><table><thead><tr><th>Story</th>' +
      SPEC.surfaces.map((s) => '<th title="' + s.note + '">' + s.label + "</th>").join("") +
      "</tr></thead><tbody>" + rows + "</tbody></table></div></section>");
  }
  document.getElementById("matrix").innerHTML = out.join("") || '<p class="sub">Nothing matches.</p>';
}
for (const id of ["q", "reg", "gap"]) document.getElementById(id).addEventListener("input", render);
render();
</script>
</body>
</html>
`;

writeFileSync(HTML_PATH, html);

const totals = { "n/a": 0, no: 0, partial: 0, planned: 0, yes: 0 };
for (const story of spec.stories) {
  for (const id of surfaceIds) {
    totals[story.support[id]?.state ?? "no"] += 1;
  }
}
console.log(
  `stories: ${spec.stories.length} · cells: yes=${totals.yes} partial=${totals.partial} planned=${totals.planned} no=${totals.no} n/a=${totals["n/a"]}`,
);

// Format the emitted artifacts so they pass `oxfmt --check .` however they reach a commit —
// the pre-commit hook only covers staged commits, and API-pushed files bypass it entirely
// (learned 2026-07-21: an unformatted generated HTML failed the deploy gate).
Bun.spawnSync(["bunx", "oxfmt", HTML_PATH, CSV_PATH, SPEC_PATH], { stdout: "ignore" });

console.log(`wrote ${HTML_PATH} + ${CSV_PATH} (oxfmt applied)`);
