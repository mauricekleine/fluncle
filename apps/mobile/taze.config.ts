import { defineConfig } from "taze";
import config, { mobileHolds } from "../../taze.config";

export default defineConfig({
  ...config,
  exclude: [...(config.exclude as string[]), ...mobileHolds.flatMap((hold) => hold.exclude)],
  githubActions: false,
  ignorePaths: [],
  recursive: false,
});
