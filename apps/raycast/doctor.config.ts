// React Doctor config — https://www.react.doctor/docs/configuration/config-files
// `ignore.overrides` parks confirmed false positives (with the reason).
export default {
  ignore: {
    // Live Raycast command entry points (declared in package.json#commands) plus
    // their shared helper module — reached via the Raycast manifest, not via JS
    // imports, so React Doctor's dead-code analysis can't see they're used.
    // (`ignore.files` is the lever for dead-code findings; `ignore.overrides` only
    // filters lint diagnostics, not unused-file.)
    files: ["src/add-track.tsx", "src/quick-add.ts", "src/recent-tracks.tsx", "src/fluncle.ts"],
  },
};
