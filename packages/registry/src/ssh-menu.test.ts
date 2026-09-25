import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { surfacesForContext } from "./index";

type SshPlacement =
  | { id: string; kind: "menu" }
  | { goConst: string; kind: "about-link" }
  | { kind: "self" };

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

function blockBody(pattern: RegExp, what: string): string {
  const match = pattern.exec(source);
  assert.ok(match, `apps/ssh/main.go: ${what} not found — this test's parse needs updating`);

  return match[1] ?? "";
}

const menuBody = blockBody(/func menuItems\(\) \[\]menuItem \{([\s\S]*?)\n\}/, "menuItems()");
const menuIds = new Set(
  [...menuBody.matchAll(/\{id: "([a-z-]+)"/g)].map((match) => match[1] ?? ""),
);
assert.ok(menuIds.size >= 8, "the rave terminal menu parsed to its real item list");

const aboutBody = blockBody(
  /func \(m model\) aboutContent\(\) \[\]string \{([\s\S]*?)\n\}/,
  "aboutContent()",
);

const declaredConsts = new Set(
  [...source.matchAll(/^\t([A-Za-z]+)\s+= "[^"]+"$/gm)].map((match) => match[1] ?? ""),
);

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

const sshWeighted = new Set(sshSurfaces.map((surface) => surface.name));

for (const name of Object.keys(SSH_PLACEMENTS)) {
  assert.ok(
    sshWeighted.has(name),
    `${name}: declared a rave-terminal placement but carries no weights.ssh (a live surface's ssh weight was dropped, or the name changed) — remove the SSH_PLACEMENTS entry`,
  );
}
