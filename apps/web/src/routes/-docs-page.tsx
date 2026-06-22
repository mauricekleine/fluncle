import { Suspense } from "react";
import { clientLoader } from "./-docs-loader";

// Shared by /docs (index) and /docs/$ (catch-all): both resolve a content path
// on the server and preload it (via `preloadDocsPage` in ./-docs-loader), then
// render it here. The Suspense boundary is a safety net (e.g. a hard reload that
// bypasses the loader preload) — the content resolves synchronously on a
// preloaded navigation, so it stays mounted.
export function DocsPage({ path }: { path: string }) {
  return <Suspense>{clientLoader.useContent(path)}</Suspense>;
}
