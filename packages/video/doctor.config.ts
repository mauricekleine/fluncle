export default {
  ignore: {
    files: [
      "src/remotion/cosmos.ts",
      "src/remotion/index.ts",

      "src/explainer/explainer-entry.ts",
      "src/remotion/color.ts",
      "src/remotion/fonts.ts",
      "src/remotion/hooks/index.ts",
      "src/remotion/hooks/sample-curve.ts",
      "src/remotion/journey/index.ts",
      "src/remotion/journey/use-journey.ts",
      "src/remotion/primitives/index.ts",
      "src/remotion/primitives/track-audio.tsx",
    ],
    overrides: [
      {
        files: ["src/remotion/journey/close-card.tsx", "src/remotion/primitives/type-plate.tsx"],
        rules: ["react-doctor/unused-file", "react-doctor/unused-export"],
      },

      {
        files: ["src/remotion/journey/shader-layer.tsx"],
        rules: ["react-doctor/no-adjust-state-on-prop-change", "react-doctor/exhaustive-deps"],
      },

      {
        files: ["src/remotion/palette-mix.ts"],
        rules: ["react-doctor/js-min-max-loop"],
      },

      {
        files: ["src/pipeline/render-cover.ts"],
        rules: ["react-doctor/async-await-in-loop"],
      },

      {
        files: ["src/pipeline/social-preview.ts"],
        rules: ["react-doctor/server-sequential-independent-await"],
      },
    ],
  },
};
