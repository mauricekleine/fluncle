import { eslintCompatPlugin } from "@oxlint/plugins";

import { noCommentsRule } from "./rules/no-comments.ts";

const noCommentsPlugin = eslintCompatPlugin({
  meta: { name: "no-comments" },
  rules: {
    "no-comments": noCommentsRule,
  },
});

export default noCommentsPlugin;
