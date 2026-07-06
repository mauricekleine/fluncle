// `bun run dev` — the two-process dev loop: the daemon (watch mode, :4190) and
// the Vite HMR server (:4191, /api proxied to the daemon). Ctrl-C stands both
// down. For the served-from-dist reality (what the launcher opens), use
// `bun run build && bun run start` instead.

import { resolve } from "node:path";

const APP_ROOT = resolve(import.meta.dir, "..");

const daemon = Bun.spawn(["bun", "--watch", "src/server.ts"], {
  cwd: APP_ROOT,
  stderr: "inherit",
  stdin: "ignore",
  stdout: "inherit",
});

const vite = Bun.spawn(["bunx", "vite", "dev"], {
  cwd: APP_ROOT,
  stderr: "inherit",
  stdin: "ignore",
  stdout: "inherit",
});

const standDown = (): void => {
  daemon.kill("SIGINT");
  vite.kill("SIGINT");
};

process.on("SIGINT", standDown);
process.on("SIGTERM", standDown);

// If either side falls over, stand the other down too — half a dev loop helps nobody.
await Promise.race([daemon.exited, vite.exited]);
standDown();
await Promise.allSettled([daemon.exited, vite.exited]);
