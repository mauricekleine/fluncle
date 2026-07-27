// Self-running asserts for the registry ↔ rave-terminal parity gate — no framework (bun
// test executes the top-level asserts; "0 tests" is the repo pattern). Run:
// `bun src/ssh-menu.test.ts` (exits non-zero on failure).
//
// THE DRIFT THIS CLOSES. A `weights.ssh` value is a CLAIM that the rave terminal displays
// the surface. Nothing enforced it, so `web.logbook` sat on `ssh: "tertiary"` from the day
// the Logbook shipped while `menuItems()` in apps/ssh/main.go never gained a Logbook entry —
// a false claim the doctrine's §3 matrix then published as fact. The registry is pure data
// and the terminal is a Go binary, so the two can only be reconciled by READING the Go
// source, exactly as the /status board is reconciled with the box prober
// (apps/web/src/lib/server/hermes-healthcheck-coverage.test.ts) and the oRPC coverage tests
// reconcile routes with contracts: a hand-kept mirror plus a build failure when it drifts.
//
// Two directions are asserted, both build-failing:
//   1. every ssh-weighted surface declares WHERE it appears in the TUI, and that place still
//      exists in main.go;
//   2. every declaration below points at a surface that still carries an ssh weight (so
//      dropping a weight forces the mirror entry out with it).
//
// NOT asserted, deliberately: the reverse of (1) at the MENU's end — a menu item with no
// ssh-weighted surface behind it. Several items are actions rather than surfaces (Submit,
// Subscribe, Random banger, Quit) or point at a surface the registry ranks elsewhere, so
// that direction is a judgement call, not an invariant.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { surfacesForContext } from "./index";

/**
 * WHERE a surface shows up in the rave terminal. The TUI advertises a surface in three
 * shapes, and each is checked differently against apps/ssh/main.go:
 * - `menu`       an entry in `menuItems()`, keyed by its `id` (the screen the crew opens).
 * - `about-link` a link on the About screen, keyed by the Go URL const it renders (the
 *                Galaxy game is reachable from the terminal this way, not as a screen).
 * - `self`       the terminal itself, which advertises its own connect line.
 */
type SshPlacement =
  | { id: string; kind: "menu" }
  | { goConst: string; kind: "about-link" }
  | { kind: "self" };

/**
 * The mirror: one entry per surface carrying a `weights.ssh` value. Adding an ssh weight
 * without adding a line here fails this test — which is the point, because the next step is
 * either wiring the menu entry or admitting the surface has no ssh presence.
 */
const SSH_PLACEMENTS: Record<string, SshPlacement> = {
  "ssh.rave": { kind: "self" },
  "subdomain.galaxy": { goConst: "galaxyURL", kind: "about-link" },
  "web.about": { id: "about", kind: "menu" },
  "web.artist": { id: "artists", kind: "menu" },
  "web.galaxies": { id: "galaxies", kind: "menu" },
  "web.galaxy": { goConst: "galaxyURL", kind: "about-link" },
  "web.log": { id: "latest", kind: "menu" },
  "web.mixtapes": { id: "mixtapes", kind: "menu" },
};

const MAIN_GO_PATH = fileURLToPath(new URL("../../../apps/ssh/main.go", import.meta.url));
const source = readFileSync(MAIN_GO_PATH, "utf8");

/** The one-line block that a Go section regex must find, or the parse itself has rotted. */
function blockBody(pattern: RegExp, what: string): string {
  const match = pattern.exec(source);
  assert.ok(match, `apps/ssh/main.go: ${what} not found — this test's parse needs updating`);

  return match[1] ?? "";
}

// The menu, parsed out of `menuItems()`: `{id: "latest", label: "Latest findings"},`.
const menuBody = blockBody(/func menuItems\(\) \[\]menuItem \{([\s\S]*?)\n\}/, "menuItems()");
const menuIds = new Set(
  [...menuBody.matchAll(/\{id: "([a-z-]+)"/g)].map((match) => match[1] ?? ""),
);
assert.ok(menuIds.size >= 8, "the rave terminal menu parsed to its real item list");

// The About screen's body, where the off-menu links live: `link("The Galaxy", galaxyURL)`.
const aboutBody = blockBody(
  /func \(m model\) aboutContent\(\) \[\]string \{([\s\S]*?)\n\}/,
  "aboutContent()",
);

// The link map's Go consts: `galaxyURL          = "https://galaxy.fluncle.com"`.
const declaredConsts = new Set(
  [...source.matchAll(/^\t([A-Za-z]+)\s+= "[^"]+"$/gm)].map((match) => match[1] ?? ""),
);

// ── (1) Every ssh-weighted surface has a place in the TUI, and it still exists ─────────
const sshSurfaces = surfacesForContext("ssh");
assert.ok(sshSurfaces.length > 0, "the ssh context displays at least one surface");

for (const surface of sshSurfaces) {
  const placement = SSH_PLACEMENTS[surface.name];
  assert.ok(
    placement,
    `${surface.name}: carries a weights.ssh value but declares no place in the rave terminal — wire the menu entry in apps/ssh/main.go and add it to SSH_PLACEMENTS, or drop the ssh weight`,
  );

  if (!placement) {
    continue;
  }

  switch (placement.kind) {
    case "menu": {
      assert.ok(
        menuIds.has(placement.id),
        `${surface.name}: menuItems() in apps/ssh/main.go has no "${placement.id}" entry`,
      );
      break;
    }
    case "about-link": {
      assert.ok(
        declaredConsts.has(placement.goConst),
        `${surface.name}: apps/ssh/main.go declares no ${placement.goConst} const`,
      );
      assert.ok(
        aboutBody.includes(placement.goConst),
        `${surface.name}: ${placement.goConst} is no longer rendered on the About screen`,
      );
      break;
    }
    case "self": {
      const command = surface.command ?? "";
      assert.ok(
        command.length > 0 && source.includes(`"${command}"`),
        `${surface.name}: apps/ssh/main.go no longer carries its own connect line ("${command}")`,
      );
      break;
    }
  }
}

// ── (2) Every declaration points at a surface that still claims an ssh weight ──────────
const sshWeighted = new Set(sshSurfaces.map((surface) => surface.name));

for (const name of Object.keys(SSH_PLACEMENTS)) {
  assert.ok(
    sshWeighted.has(name),
    `${name}: declared a rave-terminal placement but carries no weights.ssh (a live surface's ssh weight was dropped, or the name changed) — remove the SSH_PLACEMENTS entry`,
  );
}
