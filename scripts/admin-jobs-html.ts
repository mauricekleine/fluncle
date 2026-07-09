// Regenerate docs/admin-jobs.html from docs/admin-jobs.csv (`bun run jobs:html`).
// One source of truth: the CSV. The HTML is committed output so the inventory
// opens with zero tooling. Deterministic (no timestamps) to keep diffs clean.
//
// The emitted HTML is formatted in place with the repo-pinned oxfmt — the same
// binary `format:check` runs — so `bun run jobs:html` alone yields committable
// output. No separate `oxfmt --write` step to forget, and no drift when an
// unpinned `bunx oxfmt` resolves a different version than the pinned one.

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const csv = readFileSync(join(root, "docs/admin-jobs.csv"), "utf8");

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];

    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") {
        i++;
      }

      row.push(field);
      field = "";

      if (row.length > 1 || row[0] !== "") {
        rows.push(row);
      }

      row = [];
    } else {
      field += c;
    }
  }

  if (field !== "" || row.length > 0) {
    row.push(field);

    if (row.length > 1 || row[0] !== "") {
      rows.push(row);
    }
  }

  return rows;
}

const parsed = parseCsv(csv);
const header = parsed[0] ?? [];
const jobs = parsed.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""])));

const DOMAINS = [
  "intake-enrichment",
  "curation-posting",
  "video-pipeline",
  "mixtape-lifecycle",
  "clips-drip",
  "platform-ops",
];

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Admin jobs — Fluncle</title>
<style>
  :root {
    --field: #090a0b; --sleeve: #10100d; --tape: #171611;
    --cream: #f4ead7; --dust: #b7ab95; --gold: #f5b800;
    --gold-veil: rgba(245, 184, 0, 0.1); --dust-veil: rgba(208, 185, 144, 0.1);
    --red: #eb4b4b;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html { color-scheme: dark; }
  body {
    background: var(--field); color: var(--cream);
    font: 13px/1.45 ui-sans-serif, system-ui, -apple-system, sans-serif;
    font-variant-numeric: tabular-nums;
  }
  .top { position: sticky; top: 0; background: var(--field); border-bottom: 1px solid var(--tape); padding: 10px 14px 0; z-index: 2; }
  h1 { font-size: 14px; font-weight: 700; letter-spacing: 0.01em; display: inline; }
  .counts { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0; }
  .chip {
    border: 1px solid var(--tape); background: var(--sleeve); color: var(--cream);
    border-radius: 5px; padding: 3px 9px; font-size: 12px; cursor: pointer;
  }
  .chip b { font-weight: 700; }
  .chip.on { border-color: var(--gold); background: var(--gold-veil); }
  .chip:focus-visible, input:focus-visible, th:focus-visible, tr.job:focus-visible { outline: 2px solid var(--gold); outline-offset: 1px; }
  .controls { display: flex; flex-wrap: wrap; gap: 6px; padding-bottom: 10px; align-items: center; }
  input[type="search"] {
    background: var(--sleeve); border: 1px solid var(--tape); color: var(--cream);
    border-radius: 5px; padding: 4px 9px; font: inherit; width: 260px;
  }
  input::placeholder { color: var(--dust); }
  .wrap { overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; min-width: 1080px; }
  th {
    text-align: left; font-size: 11px; font-weight: 700; color: var(--dust);
    padding: 7px 9px; border-bottom: 1px solid var(--tape); cursor: pointer;
    position: sticky; top: 0; background: var(--field); white-space: nowrap; user-select: none;
  }
  th .dir { color: var(--gold); }
  td { padding: 6px 9px; border-bottom: 1px solid var(--tape); vertical-align: top; }
  tr.job { cursor: pointer; }
  tr.job:hover td { background: var(--sleeve); }
  .dom { color: var(--dust); font-size: 11px; white-space: nowrap; }
  .job-name { font-weight: 600; }
  .mark { font-size: 12px; }
  .muted { color: var(--dust); }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
  .drop { color: var(--dust); font-size: 12px; }
  .none { color: var(--red); }
  .detail td { background: var(--sleeve); font-size: 12px; padding: 9px 12px 11px; }
  .detail dl { display: grid; grid-template-columns: 96px 1fr; gap: 3px 12px; max-width: 900px; }
  .detail dt { color: var(--dust); }
  .detail dd { overflow-wrap: anywhere; }
  .hide { display: none; }
  .zero { padding: 40px 14px; color: var(--dust); }
  .foot { padding: 10px 14px 24px; color: var(--dust); font-size: 11px; }
</style>
</head>
<body>
<div class="top">
  <h1>Admin jobs</h1> <span class="muted" id="showing"></span>
  <div class="counts" id="counts" role="group" aria-label="Filters"></div>
  <div class="controls">
    <input type="search" id="q" placeholder="Search jobs, notes, ops… ( / )" aria-label="Search jobs" />
    <span class="counts" id="domains" role="group" aria-label="Domain filter"></span>
  </div>
</div>
<div class="wrap">
<table id="t" aria-label="The admin jobs inventory">
  <thead><tr id="head"></tr></thead>
  <tbody id="body"></tbody>
</table>
</div>
<div class="zero hide" id="zero">No rows match. Clear a filter.</div>
<div class="foot mono">docs/admin-jobs.csv · regenerate: bun run jobs:html</div>
<script>
const JOBS = ${JSON.stringify(jobs)};
const DOMAINS = ${JSON.stringify(DOMAINS)};
const MARK = { live: "\\u25CF live", partial: "\\u25D0 partial", desired: "\\u25CB desired", retired: "\\u2298 retired" };
const TESTS = { yes: "\\u25CF yes", partial: "\\u25D0 partial", none: "\\u25CB none" };
const COLS = [
  ["domain", "Domain"], ["job", "Job"], ["status", "Status"], ["trigger", "Trigger"],
  ["executor", "Exec"], ["runs_on", "Runs on"], ["primary_surface", "Primary"],
  ["drop_from", "Drop from"], ["tests", "Tests"],
];

const state = { q: "", domain: "", status: "", tests: "", drop: false, sort: "", dir: 1 };

const strip = [
  ["all", () => JOBS.length, () => { state.status = ""; state.tests = ""; state.drop = false; }, () => !state.status && !state.tests && !state.drop],
  ["live", () => JOBS.filter((j) => j.status === "live").length, () => { state.status = state.status === "live" ? "" : "live"; }, () => state.status === "live"],
  ["partial", () => JOBS.filter((j) => j.status === "partial").length, () => { state.status = state.status === "partial" ? "" : "partial"; }, () => state.status === "partial"],
  ["desired", () => JOBS.filter((j) => j.status === "desired").length, () => { state.status = state.status === "desired" ? "" : "desired"; }, () => state.status === "desired"],
  ["retired", () => JOBS.filter((j) => j.status === "retired").length, () => { state.status = state.status === "retired" ? "" : "retired"; }, () => state.status === "retired"],
  ["tests: none", () => JOBS.filter((j) => j.tests === "none").length, () => { state.tests = state.tests === "none" ? "" : "none"; }, () => state.tests === "none"],
  ["tests: partial", () => JOBS.filter((j) => j.tests === "partial").length, () => { state.tests = state.tests === "partial" ? "" : "partial"; }, () => state.tests === "partial"],
  ["drop candidates", () => JOBS.filter((j) => j.drop_from.trim()).length, () => { state.drop = !state.drop; }, () => state.drop],
];

function filtered() {
  const q = state.q.toLowerCase();

  let rows = JOBS.filter((j) =>
    (!state.domain || j.domain === state.domain) &&
    (!state.status || j.status === state.status) &&
    (!state.tests || j.tests === state.tests) &&
    (!state.drop || j.drop_from.trim()) &&
    (!q || Object.values(j).join(" ").toLowerCase().includes(q)));

  if (state.sort) {
    rows = rows.slice().sort((a, b) => state.dir * String(a[state.sort]).localeCompare(String(b[state.sort]), undefined, { numeric: true }));
  }

  return rows;
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function render() {
  document.getElementById("counts").innerHTML = strip.map(([label, n], i) =>
    '<button class="chip' + (strip[i][3]() ? " on" : "") + '" data-strip="' + i + '"><b>' + n() + "</b> " + label + "</button>").join("");

  document.getElementById("domains").innerHTML = ['<button class="chip' + (!state.domain ? " on" : "") + '" data-dom="">all domains</button>']
    .concat(DOMAINS.map((d) => '<button class="chip' + (state.domain === d ? " on" : "") + '" data-dom="' + d + '">' + d + "</button>")).join("");

  document.getElementById("head").innerHTML = COLS.map(([k, label]) =>
    '<th tabindex="0" data-sort="' + k + '">' + label + (state.sort === k ? ' <span class="dir">' + (state.dir > 0 ? "\\u2193" : "\\u2191") + "</span>" : "") + "</th>").join("");

  const rows = filtered();

  document.getElementById("showing").textContent = rows.length + " of " + JOBS.length;
  document.getElementById("zero").classList.toggle("hide", rows.length > 0);

  document.getElementById("body").innerHTML = rows.map((j, i) => {
    const testsClass = j.tests === "none" ? "mark none" : "mark muted";

    return '<tr class="job" tabindex="0" data-i="' + i + '" aria-expanded="false">' +
      '<td class="dom">' + esc(j.domain) + "</td>" +
      '<td class="job-name">' + esc(j.job) + "</td>" +
      '<td class="mark">' + (MARK[j.status] || esc(j.status)) + "</td>" +
      '<td class="mono muted">' + esc(j.trigger) + "</td>" +
      '<td class="muted">' + esc(j.executor) + "</td>" +
      '<td class="mono muted">' + esc(j.runs_on) + "</td>" +
      "<td>" + esc(j.primary_surface) + "</td>" +
      '<td class="drop">' + esc(j.drop_from) + "</td>" +
      '<td class="' + testsClass + '">' + (TESTS[j.tests] || esc(j.tests)) + "</td></tr>" +
      '<tr class="detail hide"><td colspan="9"><dl>' +
      "<dt>input</dt><dd>" + esc(j.input) + "</dd>" +
      "<dt>output</dt><dd>" + esc(j.output) + "</dd>" +
      "<dt>surfaces</dt><dd>" + esc(j.surfaces) + "</dd>" +
      "<dt>notes</dt><dd>" + esc(j.notes) + "</dd></dl></td></tr>";
  }).join("");
}

document.addEventListener("click", (e) => {
  const chip = e.target.closest("[data-strip]");
  const dom = e.target.closest("[data-dom]");
  const th = e.target.closest("[data-sort]");
  const row = e.target.closest("tr.job");

  if (chip) { strip[Number(chip.dataset.strip)][2](); render(); }
  else if (dom) { state.domain = dom.dataset.dom; render(); }
  else if (th) {
    const k = th.dataset.sort;

    if (state.sort === k) { state.dir = -state.dir; } else { state.sort = k; state.dir = 1; }

    if (state.sort === k && state.dir === 1 && th.dataset.third === "1") { state.sort = ""; th.dataset.third = ""; }
    else if (state.dir === -1) { th.dataset.third = "1"; }

    render();
  } else if (row) {
    const d = row.nextElementSibling;
    const open = d.classList.toggle("hide");

    row.setAttribute("aria-expanded", String(!open));
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key === "/" && document.activeElement !== document.getElementById("q")) {
    e.preventDefault();
    document.getElementById("q").focus();
  } else if (e.key === "Enter" && document.activeElement?.classList?.contains("job")) {
    document.activeElement.click();
  } else if (e.key === "Enter" && document.activeElement?.dataset?.sort) {
    document.activeElement.click();
  }
});

document.getElementById("q").addEventListener("input", (e) => { state.q = e.target.value; render(); });
render();
</script>
</body>
</html>
`;

const out = join(root, "docs/admin-jobs.html");
writeFileSync(out, html);

// oxfmt is not idempotent on this file in a single pass: the compact emitted
// markup takes two passes to reach the canonical wrapping that `format:check`
// accepts. Run the pinned oxfmt to a fixed point so one `bun run jobs:html`
// always yields check-clean output.
const oxfmt = join(root, "node_modules", ".bin", "oxfmt");
let converged = false;
for (let pass = 0; pass < 5; pass++) {
  const before = readFileSync(out, "utf8");
  const result = spawnSync(oxfmt, ["--write", out], { cwd: root, stdio: "inherit" });
  if (result.status !== 0) {
    console.error(`oxfmt failed to format ${out} (exit ${result.status ?? "signal"})`);
    process.exit(1);
  }

  if (readFileSync(out, "utf8") === before) {
    converged = true;
    break;
  }
}

if (!converged) {
  console.error(`oxfmt did not converge on ${out} within 5 passes`);
  process.exit(1);
}

console.log(`docs/admin-jobs.html: ${jobs.length} jobs`);
