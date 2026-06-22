import { defineConfig } from "deepsec/config";

export default defineConfig({
  projects: [
    {
      id: "fluncle",
      priorityPaths: [
        "apps/web/src",
        "apps/cli/src",
        "apps/ssh",
        "apps/dns",
        "apps/extension/src",
        "packages/contracts/src",
        "packages/media",
        "packages/video",
        "packages/tokens",
      ],
      root: "..",
    },
    // <deepsec:projects-insert-above>
  ],
});
