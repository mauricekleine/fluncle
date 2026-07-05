// Static serving of the built SPA (apps/helm/dist). Bun.file derives the
// content-type from the extension; hashed /assets/ get immutable caching, the
// HTML shell never caches, and any non-/api GET falls through to index.html
// (the SPA owns its own routes). Traversal is fenced to the dist directory.

import { existsSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";

const NOT_BUILT_PAGE = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Fluncle's Helm</title></head>
<body style="background:#090a0b;color:#b7ab95;font-family:ui-monospace,monospace;padding:3rem">
<pre>[hold]  glass       not built yet
[clear] daemon      holding

Raise the glass, then reload:

  bun run --cwd apps/helm build</pre>
</body>
</html>`;

export function createStaticHandler(distDir: string): (pathname: string) => Response {
  const root = resolve(distDir);
  const indexPath = resolve(root, "index.html");

  return (pathname) => {
    if (!existsSync(indexPath)) {
      return new Response(NOT_BUILT_PAGE, {
        headers: { "content-type": "text/html; charset=utf-8" },
        status: 200,
      });
    }

    const candidate = resolve(root, `.${pathname}`);
    const inRoot = candidate === root || candidate.startsWith(root + sep);

    if (inRoot && candidate !== root && isFile(candidate)) {
      const immutable = pathname.startsWith("/assets/") || pathname.startsWith("/fonts/");

      return new Response(Bun.file(candidate), {
        headers: {
          "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
        },
      });
    }

    return new Response(Bun.file(indexPath), {
      headers: { "cache-control": "no-cache", "content-type": "text/html; charset=utf-8" },
    });
  };
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
