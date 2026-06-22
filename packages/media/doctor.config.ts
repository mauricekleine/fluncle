// React Doctor config — https://www.react.doctor/docs/configuration/config-files
// `ignore.overrides` parks confirmed false positives (with the reason).
export default {
  ignore: {
    overrides: [
      // The Remotion surface: `index.ts` is the registerRoot entry point, `root.tsx`
      // registers every composition via <Still component={...}>, `fonts.ts` is
      // imported by those compositions, and the composition files themselves are
      // rendered by string id (not JS-imported). Dead-code analysis can't see the
      // registerRoot/<Still> wiring.
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
      // The per-star background divs carry 8 style props of which 5 (height, left,
      // opacity, top, width) are per-render dynamic — they can't be hoisted to a
      // static style object, which is the rule's documented justified case.
      {
        files: [
          "src/remotion/cosmos-banner.tsx",
          "src/remotion/galaxy-og.tsx",
          "src/remotion/mixtape-cover.tsx",
        ],
        rules: ["react-doctor/no-inline-exhaustive-style"],
      },
      // Per-spec Remotion renderStill on a single ANGLE GL context; concurrent
      // headless renders contend for one GPU and risk OOM. Sequential by design.
      {
        files: ["src/render/render-mixtape-bg.ts", "src/render/render-socials.ts"],
        rules: ["react-doctor/async-await-in-loop"],
      },
    ],
  },
};
