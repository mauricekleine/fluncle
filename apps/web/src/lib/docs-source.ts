import { loader } from "fumadocs-core/source";
// The generated server collection (eager-compiled MDX + meta). The Fumadocs
// MDX Vite plugin / CLI emits .source/ — see the pretypecheck + postinstall
// scripts and vite.config.ts.
import { docs } from "../../.source/server";

// The /docs source: turns the compiled MDX collection into a page tree the
// DocsLayout sidebar reads, with every page mounted under /docs.
export const docsSource = loader({
  baseUrl: "/docs",
  source: docs.toFumadocsSource(),
});
