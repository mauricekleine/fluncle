// Builds one of three 1280×800 Web Store scenes, chosen by ?scene= in the URL.
// Uses the extension's real ui.css / content.css so the shots match the product.
const scene = new URLSearchParams(location.search).get("scene") || "1";
const frame = document.getElementById("frame");

const GEAR = `<svg class="lens-gear-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`;

function popup() {
  return `
  <div class="popup-shell">
    <div class="lens-popup" style="width:360px">
      <header class="lens-header">
        <div class="lens-brand">
          <img class="lens-mark" src="icons/icon32.png" alt="" width="20" height="20" />
          <div class="lens-wordmark">Fluncle Lens</div>
        </div>
        <button class="lens-gear" type="button" aria-label="Settings">${GEAR}</button>
      </header>
      <p class="lens-count">2 findings on this page</p>
      <ul class="lens-list">
        <li class="lens-row">
          <div class="lens-row-coordinate">fluncle://241.7.3A</div>
          <div class="lens-row-title">Break — Whatever It Takes</div>
          <div class="lens-actions">
            <a class="lens-action">Open in Fluncle</a>
            <a class="lens-action">Open in Spotify</a>
            <button class="lens-action">Copy coordinate</button>
            <button class="lens-action">Copy dig command</button>
          </div>
        </li>
        <li class="lens-row">
          <div class="lens-row-coordinate">fluncle://019.F.1A</div>
          <div class="lens-row-title">Fluncle — Mixtape 01</div>
          <div class="lens-actions">
            <a class="lens-action">Open in Fluncle</a>
            <button class="lens-action">Copy coordinate</button>
          </div>
        </li>
      </ul>
    </div>
  </div>`;
}

function card() {
  return `
  <span class="fluncle-lens-card" style="position:relative;top:auto;left:auto;display:inline-block;margin-top:10px">
    <div class="fluncle-lens-card-head"><span class="fluncle-lens-coordinate">fluncle://241.7.3A</span></div>
    <div class="fluncle-lens-card-body">
      <div class="fluncle-lens-title">Break — Whatever It Takes</div>
      <div class="fluncle-lens-facts">Symmetry  ·  171 BPM  ·  F minor</div>
      <div class="fluncle-lens-found">Found Jun 4, 2026</div>
    </div>
    <div class="fluncle-lens-actions">
      <a class="fluncle-lens-action">Open in Fluncle</a>
      <a class="fluncle-lens-action">Open in Spotify</a>
      <button class="fluncle-lens-action">Copy coordinate</button>
      <button class="fluncle-lens-action">Copy web URL</button>
    </div>
  </span>`;
}

const scenes = {
  1: `
    <div class="stars"></div>
    <div class="head">
      <p class="kicker">Fluncle Lens</p>
      <h1 class="title">The findings, found wherever the web hides them.</h1>
      <p class="sub">Any <span style="color:#ffd057;font-family:Oxanium">fluncle://</span> coordinate on a page becomes a link straight to the finding.</p>
    </div>
    ${popup()}`,

  2: `
    <div class="stars"></div>
    <div class="head">
      <p class="kicker">On any page</p>
      <h1 class="title">Hover a coordinate. The finding comes back.</h1>
    </div>
    <div class="article">
      <p>…the selector dropped <a class="fluncle-lens-link" style="font-size:17px">fluncle://241.7.3A</a> and the floor went up.</p>
      ${card()}
    </div>`,

  3: `
    <div class="stars"></div>
    <div class="head">
      <p class="kicker">Quiet by design</p>
      <h1 class="title">Nothing about the page leaves your browser.</h1>
      <p class="sub">The lens reads each page locally. The only call out is one public read of a finding by its Log ID, after a coordinate is spotted.</p>
    </div>
    <img src="_cover.png" style="position:absolute;right:96px;bottom:96px;width:320px;border-radius:16px;box-shadow:0 30px 80px rgba(0,0,0,.6)" />`,
};

frame.innerHTML = scenes[scene] || scenes["1"];
