import { type Plugin, type Rollup } from "vite";

const CLIENT_SERVER_ONLY = /\/apps\/web\/src\/(lib\/server\/|db\/)/;

const CLIENT_CHUNK_PURE_EXCEPTION = "/apps/web/src/lib/server/track-match.ts";

export type PurityChunk = {
  isEntry: boolean;
  modules: Record<string, { renderedLength: number }>;
};

export type PurityReport = {
  eager: string[];
  lazy: string[];
};

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
