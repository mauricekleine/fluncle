import { createFileRoute } from "@tanstack/react-router";
import { ApiReferenceReact } from "@scalar/api-reference-react";
import "@scalar/api-reference-react/style.css";

// The embedded Scalar API reference, at /docs/api inside the docs hub. It reads
// the already-served OpenAPI 3.1 document at /api/v1/openapi.json (the same
// versioned base it describes) and renders it forced-dark, retinted to the
// Nostalgic Cosmos: warm near-blacks, Starlight Cream ink, Eclipse Gold as the
// one accent, Re-entry Red for errors (DESIGN.md). theme:"none" hands the full
// palette to scalarCss below so no preset hue leaks in.
export const Route = createFileRoute("/docs/api")({
  component: ApiReference,
  head: () => ({
    meta: [
      {
        title: "Fluncle API reference",
      },
      {
        content: "The Fluncle API, every endpoint and schema, read live from the OpenAPI document.",
        name: "description",
      },
    ],
  }),
});

// The Retint Rule, applied to Scalar's CSS variables: take the reference engine,
// recolor it to canon. Values mirror the tokens in styles.css.
const scalarCss = `
.scalar-app {
  --scalar-font: var(--font-sans, ui-sans-serif, system-ui, sans-serif);
  --scalar-font-code: "Monaspace Krypton", ui-monospace, "SF Mono", Menlo, monospace;
  --scalar-radius: 0.5rem;
  --scalar-radius-lg: 0.625rem;
}
.dark-mode .scalar-app,
.scalar-app.dark-mode {
  --scalar-background-1: #090a0b;
  --scalar-background-2: #10100d;
  --scalar-background-3: #171611;
  --scalar-background-accent: #f5b8001a;
  --scalar-color-1: #f4ead7;
  --scalar-color-2: #b7ab95;
  --scalar-color-3: #b7ab95;
  --scalar-color-accent: #f5b800;
  --scalar-color-green: #f5b800;
  --scalar-color-red: #ff6b57;
  --scalar-color-yellow: #ffd057;
  --scalar-color-blue: #ffd057;
  --scalar-color-orange: #ff6b57;
  --scalar-color-purple: #ffd057;
  --scalar-border-color: #d0b99029;
  --scalar-button-1: #f5b800;
  --scalar-button-1-color: #151006;
  --scalar-button-1-hover: #ffd057;
  --scalar-sidebar-background-1: #10100d;
  --scalar-sidebar-color-1: #f4ead7;
  --scalar-sidebar-color-2: #b7ab95;
  --scalar-sidebar-border-color: #d0b99029;
  --scalar-sidebar-item-hover-background: #f5b8001a;
  --scalar-sidebar-item-hover-color: #ffd057;
  --scalar-sidebar-item-active-background: #f5b8001a;
  --scalar-sidebar-color-active: #f5b800;
  --scalar-sidebar-search-background: #171611;
  --scalar-sidebar-search-border-color: #d0b99029;
}
`;

function ApiReference() {
  return (
    <ApiReferenceReact
      configuration={{
        customCss: scalarCss,
        forceDarkModeState: "dark",
        hideDarkModeToggle: true,
        theme: "none",
        url: "/api/v1/openapi.json",
      }}
    />
  );
}
