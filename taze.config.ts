import { readFileSync } from "node:fs";
import { defineConfig } from "taze";

const secondsPerDay = 86_400;

function bunfigMinimumReleaseAgeDays(): number {
  const bunfig = readFileSync(new URL("./bunfig.toml", import.meta.url), "utf8");
  const seconds = /^minimumReleaseAge\s*=\s*(\d+)/m.exec(bunfig)?.[1];

  if (!seconds) {
    throw new Error("bunfig.toml must set [install] minimumReleaseAge for taze to mirror");
  }

  return Number(seconds) / secondsPerDay;
}

const holds = [
  {
    exclude: ["dtolnay/rust-toolchain"],
    reason:
      "The stable branch is mutable; refresh dtolnay/rust-toolchain digests explicitly after reviewing the branch changes.",
  },
  {
    exclude: ["react@>=19.3.0", "react-dom@>=19.3.0"],
    reason:
      "react and react-dom stay on the 19.2 line because React Native 0.85's bundled Fabric renderer is built from React 19.2.3, so a React minor moves with the React Native / Expo SDK bump. Patches within 19.2 ride along, and scripts/react-version.test.ts keeps mobile's exact pin and the catalog on one hoisted copy.",
  },
  {
    exclude: ["@resvg/resvg-wasm"],
    reason:
      "@resvg/resvg-wasm pinned ~2.4.0 to match the copy workers-og bundles because a newer copy adds ~1 MB of Worker wasm for zero gain.",
  },
  {
    exclude: ["drizzle-orm@>=1", "drizzle-kit@>=1"],
    reason:
      "drizzle-orm 1.0 RC is peer-blocked by better-auth (^0.45.2); take it when better-auth follows.",
  },
  {
    exclude: ["remotion", "@remotion/*"],
    reason:
      "Remotion packages share one exact version, and @remotion/bundler is patched via patchedDependencies keyed by that EXACT version because a bump moves every remotion and @remotion/* package together and re-keys patches/@remotion%2Fbundler@*.patch in the same PR (scripts/patched-dependencies.test.ts turns a detached patch into a red deploy gate). Upgrade explicitly with the coupled group.",
  },
  {
    exclude: ["shadcn", "@modelcontextprotocol/sdk"],
    reason:
      "Shadcn currently resolves @modelcontextprotocol/sdk 1.31.0, patched because its published root export targets absent files (upstream #2273); a Shadcn or direct SDK bump must remove the patch if fixed upstream or re-key and revalidate it. Upgrade explicitly with the coupled group.",
  },
];

export const mobileHolds = [
  {
    exclude: ["eslint@>=10"],
    reason:
      "eslint majors in apps/mobile because eslint-config-expo's plugin chain crashes under ESLint 10; rides the Expo SDK arc.",
  },
  {
    exclude: ["tailwindcss@>=4"],
    reason:
      "tailwindcss stays v3 in apps/mobile because NativeWind 4.x is built for Tailwind 3; its loose peer range lies. Never bump until NativeWind ships Tailwind 4 support.",
  },
  {
    exclude: [
      "expo",
      "expo-*",
      "@expo/*",
      "react-native",
      "react-native-*",
      "@react-native-async-storage/async-storage",
      "@shopify/flash-list",
      "@shopify/react-native-skia",
      "eslint-config-expo",
    ],
    reason:
      "Expo-pinned mobile deps route through the Expo SDK bump only (expo's bundledNativeModules.json is the authority, not the packages' own peer ranges; move them with `npx expo install --fix`).",
  },
];

export default defineConfig({
  exclude: holds.flatMap((hold) => hold.exclude),
  ignorePaths: ["apps/mobile/**"],
  includeLocked: true,
  maturityPeriod: bunfigMinimumReleaseAgeDays(),
  recursive: true,
  requestTimeout: 30_000,
});
