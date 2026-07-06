// The page shell — the self-contained HTML the glass serves. The client is a
// Bun-built browser bundle injected inline (one <script>), so the page has ZERO
// runtime module/network dependencies of its own (the never-crash rail): fonts are
// the only external, and the render survives without them. Single canvas now — the
// v0.6 two-canvas crossfade folded into the GlassPipeline's shared FBO chain.

const STYLE = `
  html,body{margin:0;height:100%;background:#090a0b;overflow:hidden;font:12px/1.5 ui-monospace,Menlo,monospace;color:#f4ead7}
  canvas{display:block;position:fixed;inset:0;width:100vw;height:100vh}
  #c{z-index:0}
  /* The currently-playing PLATE — BOTTOM-LEFT, DOM overlay, social-clip grammar: text set
     DIRECTLY on the art (no card/box/scrim/rounded background). Legibility comes from a soft
     FloatingType-style ink halo (layered text-shadow), never a panel. Non-interactive; eases
     in on arrival (rises from just below); blanks to nothing in uncharted space. */
  #plate{position:fixed;bottom:30px;left:34px;max-width:min(52vw,620px);z-index:3;
    pointer-events:none;
    opacity:0;transform:translateY(8px);transition:opacity .34s ease,transform .34s ease}
  #plate.show{opacity:1;transform:none}
  #plate>div{text-shadow:0 1px 2px rgba(9,10,11,0.9),0 2px 12px rgba(9,10,11,0.72)}
  #p-coord{font-family:Oxanium,ui-sans-serif,system-ui,sans-serif;font-weight:600;
    font-variant-numeric:tabular-nums;letter-spacing:.02em;color:#f5b800;font-size:.95rem;line-height:1;margin-bottom:8px}
  #p-title{font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,sans-serif;font-weight:800;
    color:#f4ead7;font-size:1.4rem;line-height:1.14;letter-spacing:-.01em}
  #p-artist{font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;font-weight:400;
    color:#b7ab95;font-size:1rem;line-height:1.2;margin-top:5px}
  #p-found{font-family:Oxanium,ui-sans-serif,system-ui,sans-serif;font-variant-numeric:tabular-nums;
    color:#b7ab95;font-size:.78rem;letter-spacing:.03em;margin-top:9px}
  /* Blackout-arming feedback stays boxless — a gold glow on the coordinate, not an outline. */
  #plate.blackarm #p-coord{text-shadow:0 0 10px #f5b800aa,0 1px 2px rgba(9,10,11,0.9)}
  /* HUD moved to the bottom-RIGHT so it (and the "press i for keys" hint it carries) never
     overlaps the bottom-left plate; the keys overlay is centered and #err is top-right. */
  #hud{position:fixed;right:12px;bottom:12px;z-index:3;background:#10100dcc;padding:10px 12px;border:1px solid #d0b99029;border-radius:8px;white-space:pre;max-width:min(60vw,520px)}
  #err{position:fixed;top:12px;right:12px;z-index:3;color:#ff6b57;white-space:pre-wrap;max-width:60vw;text-align:right}
  button,select{background:#171611;color:#f4ead7;border:1px solid #d0b99029;border-radius:6px;padding:4px 8px;font:inherit;margin-right:6px}
  .dim{color:#b7ab95}
  .rep{color:#8fe388}
  #keyshint{margin-top:6px;font-size:11px;letter-spacing:.02em}
  /* The i-key keys overlay — a canon legend, not a settings modal. Warm-dark scrim over
     the still-breathing world; eases like the plate; keys in Oxanium gold, the ink in
     Starlight Cream / Stardust. Never interactive (i/Esc close it), never on boot. */
  #keys{position:fixed;inset:0;z-index:5;display:flex;align-items:center;justify-content:center;
    background:rgba(9,10,11,0.8);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);
    opacity:0;visibility:hidden;pointer-events:none;transition:opacity .2s ease,visibility .2s ease}
  #keys.show{opacity:1;visibility:visible}
  #keys-panel{max-width:min(92vw,720px);padding:26px 32px}
  #keys-title{font-family:Oxanium,ui-sans-serif,system-ui,sans-serif;font-weight:600;letter-spacing:.16em;
    text-transform:uppercase;color:#f5b800;font-size:.82rem;margin-bottom:18px}
  #keys-grid{display:grid;grid-template-columns:repeat(2,auto);gap:18px 52px}
  .kgroup{min-width:190px}
  .khead{font-family:Oxanium,ui-sans-serif,system-ui,sans-serif;font-size:.68rem;letter-spacing:.14em;
    text-transform:lowercase;color:#b7ab95;margin-bottom:9px;padding-bottom:5px;border-bottom:1px solid #d0b99022}
  .krow{display:grid;grid-template-columns:66px 1fr;gap:14px;align-items:baseline;padding:3px 0}
  .krow .k{font-family:Oxanium,ui-sans-serif,system-ui,sans-serif;font-weight:600;font-variant-numeric:tabular-nums;
    letter-spacing:.02em;color:#f5b800;font-size:.92rem;white-space:nowrap}
  .krow .a{color:#f4ead7;font-size:.82rem;line-height:1.3}
  #keys-foot{margin-top:20px;color:#b7ab95;font-size:.72rem;letter-spacing:.03em}
`;

export function renderPage(clientJs: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Fluncle LIVE — the glass</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Oxanium:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>${STYLE}</style></head><body>
<canvas id="c"></canvas>
<div id="plate"><div id="p-coord"></div><div id="p-title"></div><div id="p-artist"></div><div id="p-found"></div></div>
<div id="err"></div>
<div id="hud">
  <div style="margin-bottom:6px">
    <select id="devices"></select>
    <button id="live">use live input</button>
    <button id="demo">demo beat</button>
  </div>
  <span id="hudinfo" class="dim">loading plan…</span>
  <div id="world" style="margin-top:4px" class="dim">world: —</div>
  <div id="meters" style="margin-top:4px">—</div>
  <div id="keyshint" class="dim">press <b style="color:#f5b800;font-weight:600">i</b> for keys</div>
</div>
<div id="keys"><div id="keys-panel">
  <div id="keys-title">the glass · keys</div>
  <div id="keys-grid"></div>
  <div id="keys-foot">i or esc to close</div>
</div></div>
<script type="module">${clientJs}</script>
</body></html>`;
}
