import { StartClient } from "@tanstack/react-start/client";
import { StrictMode } from "react";
import { hydrateRoot } from "react-dom/client";
import { config as configureZod } from "zod";
import { startBrowserSentry } from "./lib/browser-sentry";
import { createChunkReloadGuard } from "./lib/chunk-reload";

configureZod({ jitless: true });

const chunkReloadGuard = createChunkReloadGuard({
  location: window.location,
  now: Date.now,
  setTimeout: (callback, ms) => window.setTimeout(callback, ms),
  get storage() {
    return window.sessionStorage;
  },
});

startBrowserSentry({ shouldDropError: chunkReloadGuard.isReloading });

window.addEventListener("vite:preloadError", chunkReloadGuard.handlePreloadError);

hydrateRoot(
  document,
  <StrictMode>
    <StartClient />
  </StrictMode>,
);
