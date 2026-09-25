export default {
  ignore: {
    overrides: [
      {
        files: [
          "src/remotion/index.ts",
          "src/remotion/root.tsx",
          "src/remotion/fonts.ts",
          "src/remotion/mixtape-cover.tsx",
          "src/remotion/galaxy-og.tsx",
          "src/remotion/cosmos-banner.tsx",
        ],
        rules: ["react-doctor/unused-file"],
      },

      {
        files: [
          "src/remotion/cosmos-banner.tsx",
          "src/remotion/galaxy-og.tsx",
          "src/remotion/mixtape-cover.tsx",
        ],
        rules: ["react-doctor/no-inline-exhaustive-style"],
      },

      {
        files: ["src/render/render-mixtape-bg.ts", "src/render/render-socials.ts"],
        rules: ["react-doctor/async-await-in-loop"],
      },
    ],
  },
};
