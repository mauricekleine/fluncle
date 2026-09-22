// THE CLIENT-CHUNK PURITY GATE — a build-fail check, the `orpc-coverage` pattern applied to the
// browser bundle. It covers EVERY client chunk, eager and lazy.
//
// The client entry chunk is the one file EVERY page downloads before it paints; the `app` group
// in `client-chunk-groups.ts` deliberately folds the whole statically-reachable set into it. So a
// single stray static import of a server module does not cost one page — it costs the homepage,
// and it does it silently: the build stays green, the types pass, the page renders.
//
// It happened. Measured on the built bundle, `db/schema.ts` + `lib/server/**` + the
// `@libsql/client` / `drizzle-orm` chain behind `getDb` were ~232 KB of RENDERED dead modules in
// that chunk, reached from four route files. The cause is structural rather than careless: a
// route's `loader`, `head`, `validateSearch` and `loaderDeps` all live in the route's CRITICAL
// half (only `component` is auto-split), so ANY of them touching a `lib/server/**` export — even
// a bare integer constant — welds the database chain to first paint. TanStack Start's
// import-protection guide names the same trap.
//
// A LAZY route chunk is the same defect with a different blast radius, and the radius is not
// "some extra bytes": the client build does not remove a server module, it REWRITES its `node:*`
// imports to Vite's externalized stubs, whose every property access throws. A server module that
// survives tree-shaking into a route chunk therefore takes the ROUTE DOWN — the chunk throws
// during module evaluation, the route's component never mounts, and the visitor gets the root
// error boundary instead of the page. Tree-shaking is not a safety net either: a module-level
// side effect Rollup cannot prove pure (`new AsyncLocalStorage()` in
// `lib/server/database-request-scope.ts`) pins the whole import chain even when every one of its
// exports is unused, and a live CLIENT reference into a server module pins it outright. So the
// gate covers every chunk; only the FIX ADVICE differs by chunk kind.
//
// The fix is always one of two moves:
//   1. a value the client genuinely needs (a `head`/`loader`/`validateSearch`, or a pure helper
//      the component calls) → put it in a client-safe module under `src/lib/` and re-export it
//      from the server one (`lib/catalogue.ts`, `lib/galaxies.ts`, `lib/artist-review.ts`);
//   2. the data resolution itself → a `-*-page-data.ts` sibling reached by a DYNAMIC import
//      INSIDE the `createServerFn().handler()` body, which the client build removes wholesale.

import { type Plugin, type Rollup } from "vite";

const CLIENT_SERVER_ONLY = /\/apps\/web\/src\/(lib\/server\/|db\/)/;

/**
 * The ONE permitted resident, and it earns the exemption by having no imports.
 *
 * `lib/server/track-match.ts` is the ratified folded title+artist matcher — a pure function over
 * strings with an EMPTY import list, so unlike every other `lib/server/**` module it cannot drag a
 * chain behind it (3 KB rendered, and 3 KB is where it ends). `lib/log-schema.ts` needs it to emit
 * a finding's remixer credits, and log-schema is read from route `head`s, which are eagerly
 * bundled by construction. Its path is also canon across `docs/`, the `fluncle-rekordbox-sync`
 * skill and a Python port that is kept in lockstep, so relocating it is a repo-wide rename for
 * 3 KB.
 *
 * The exemption is not taken on trust: the gate RE-CHECKS the premise every build and fails if
 * this module ever grows an import of its own. The day it does, it can drag the database chain in,
 * and the exemption dies with the premise.
 */
const CLIENT_CHUNK_PURE_EXCEPTION = "/apps/web/src/lib/server/track-match.ts";

/** One chunk as the gate reads it — the shape Rollup's `OutputChunk` gives, narrowed to what matters. */
export type PurityChunk = {
  isEntry: boolean;
  modules: Record<string, { renderedLength: number }>;
};

/** The two blast radii a violation can have, kept apart because their fix advice differs. */
export type PurityReport = {
  eager: string[];
  lazy: string[];
};

/**
 * Collect the server-only modules that survived into the client bundle, split by chunk kind.
 *
 * Pure over its inputs so the gate can be driven directly by its own test — a gate nobody has seen
 * fail is a gate nobody knows works.
 */
export function clientChunkPurityReport(
  chunks: Record<string, PurityChunk>,
  importedIdsOf: (id: string) => readonly string[],
): PurityReport {
  const eager: string[] = [];
  const lazy: string[] = [];

  for (const [fileName, chunk] of Object.entries(chunks)) {
    for (const [id, module] of Object.entries(chunk.modules)) {
      if (!CLIENT_SERVER_ONLY.test(id)) {
        continue;
      }

      let offender: string;

      if (id.endsWith(CLIENT_CHUNK_PURE_EXCEPTION)) {
        // The exemption holds only while the premise does — no imports, nothing to drag.
        const imported = importedIdsOf(id);

        if (imported.length === 0) {
          continue;
        }

        offender = `${CLIENT_CHUNK_PURE_EXCEPTION.slice(1)} — exempt ONLY while import-free, and it now imports ${imported.length}`;
      } else {
        offender = `${id.replace(/^.*\/apps\/web\//, "")} (${module.renderedLength} B)`;
      }

      if (chunk.isEntry) {
        eager.push(offender);
      } else {
        lazy.push(`${fileName}: ${offender}`);
      }
    }
  }

  return { eager: eager.sort(), lazy: lazy.sort() };
}

/** The build-failure message, or null when the bundle is clean. */
export function clientChunkPurityMessage(report: PurityReport): null | string {
  if (report.eager.length === 0 && report.lazy.length === 0) {
    return null;
  }

  const lines: string[] = [];

  if (report.eager.length > 0) {
    lines.push(
      `Server-only modules reached the eager client entry chunk (${report.eager.length}):`,
      ...report.eager.map((offender) => `  - ${offender}`),
      "",
      "Every page downloads this chunk before it paints. A route's loader/head/",
      "validateSearch/loaderDeps is eagerly bundled — move the value into a client-safe",
      "module, or reach the resolver by a dynamic import inside the serverFn handler.",
    );
  }

  if (report.lazy.length > 0) {
    if (lines.length > 0) {
      lines.push("");
    }

    lines.push(
      `Server-only modules reached lazy client route chunks (${report.lazy.length}):`,
      ...report.lazy.map((offender) => `  - ${offender}`),
      "",
      "A server module in a route chunk is not dead weight, it is a dead ROUTE: its `node:*`",
      "imports become Vite's externalized stubs, which throw on property access during module",
      "evaluation, so the page renders the root error boundary. Move the helper the component",
      "calls into a client-safe module under src/lib/ and re-export it from the server one.",
    );
  }

  lines.push("", "See docs/client-bundle.md.");

  return lines.join("\n");
}

export function clientChunkPurityGate(): Plugin {
  return {
    apply: "build",
    enforce: "post",
    generateBundle(options: Rollup.NormalizedOutputOptions, bundle: Rollup.OutputBundle) {
      // The SSR bundle is the Worker's own code and legitimately holds every server module; only
      // the browser output is gated.
      if (!options.dir?.endsWith("client")) {
        return;
      }

      const chunks: Record<string, PurityChunk> = {};

      for (const [fileName, file] of Object.entries(bundle)) {
        if (file.type === "chunk") {
          chunks[fileName] = { isEntry: file.isEntry, modules: file.modules };
        }
      }

      const message = clientChunkPurityMessage(
        clientChunkPurityReport(chunks, (id) => this.getModuleInfo(id)?.importedIds ?? []),
      );

      if (message !== null) {
        this.error(message);
      }
    },
    name: "fluncle-client-chunk-purity",
  };
}
