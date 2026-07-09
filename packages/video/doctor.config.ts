// React Doctor config — https://www.react.doctor/docs/configuration/config-files
// `ignore.overrides` parks confirmed false positives (with the reason).
export default {
  ignore: {
    // The Remotion surface is reached two ways React Doctor's dead-code pass can't
    // follow: `src/remotion/index.ts` is the registerRoot entry, `cosmos.ts` is the
    // documented public entry of @fluncle/video, and everything else is re-exported
    // through them and consumed by the gitignored `./workbench/*` compositions. None
    // are dead. (`ignore.files` is the lever that suppresses dead-code findings;
    // `ignore.overrides` only filters lint diagnostics, not unused-file/-export.)
    files: [
      "src/remotion/cosmos.ts",
      "src/remotion/index.ts",
      // The Explainer family's isolated registerRoot entry (launched by
      // `tour:studio`); the rest of src/explainer/* is reached through it.
      "src/explainer/explainer-entry.ts",
      "src/remotion/color.ts",
      "src/remotion/fonts.ts",
      "src/remotion/hooks/index.ts",
      "src/remotion/hooks/sample-curve.ts",
      "src/remotion/journey/index.ts",
      "src/remotion/journey/use-journey.ts",
      "src/remotion/primitives/index.ts",
      "src/remotion/primitives/grain.tsx",
      "src/remotion/primitives/starfield.tsx",
      "src/remotion/primitives/track-audio.tsx",
    ],
    overrides: [
      // close-card.tsx and type-plate.tsx are scanned for lint but their dead-code
      // findings are false (reached via the journey/primitives barrels above).
      {
        files: ["src/remotion/journey/close-card.tsx", "src/remotion/primitives/type-plate.tsx"],
        rules: ["react-doctor/unused-file", "react-doctor/unused-export"],
      },
      // setError reports a real WebGL/bloom setup failure from the imperative GPU
      // draw effect — there's no duplicated/derived state to remove.
      {
        files: ["src/remotion/journey/shader-layer.tsx"],
        rules: ["react-doctor/no-adjust-state-on-prop-change"],
      },
      // `[...clean].sort(bySaturation)[0]` is an argmax (the element with max
      // saturation), which Math.max can't express — the rule's documented FP.
      {
        files: ["src/remotion/palette-mix.ts"],
        rules: ["react-doctor/js-min-max-loop"],
      },
      // Per-frame Remotion headless-Chromium renders on a single ANGLE GL context;
      // Remotion's own guidance is concurrency=1, so parallelizing risks GPU
      // contention / OOM. (A bounded-concurrency queue is a possible future
      // enhancement, tracked separately — not the naive Promise.all this suggests.)
      {
        files: ["src/pipeline/render-cover.ts"],
        rules: ["react-doctor/async-await-in-loop"],
      },
      // The second await is a dynamic import whose spawnSync probes the file the
      // prior render produced — ordered by construction, not independent.
      {
        files: ["src/pipeline/social-preview.ts"],
        rules: ["react-doctor/server-sequential-independent-await"],
      },
    ],
  },
};
