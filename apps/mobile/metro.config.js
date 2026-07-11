// Expo + Bun monorepo + NativeWind. watchFolders/nodeModulesPaths let Metro
// resolve the raw-TS workspace packages (@fluncle/contracts, @fluncle/tokens).
const { getDefaultConfig } = require("expo/metro-config");
const { withNativeWind } = require("nativewind/metro");
const path = require("path");

const projectRoot = __dirname;
const monorepoRoot = path.resolve(projectRoot, "../..");

const config = getDefaultConfig(projectRoot);

config.watchFolders = [monorepoRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(monorepoRoot, "node_modules"),
];

// The workspace TS packages use NodeNext ESM, so their RELATIVE imports carry an
// explicit `.js` extension that only exists after compilation (`./_shared.js` is
// really the raw `_shared.ts` source). Vite and Bun rewrite that back to the TS
// source; Metro does not — so strip the `.js` and let sourceExts find the `.ts`,
// falling back to default resolution for anything that isn't this pattern.
const defaultResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const resolve = defaultResolveRequest ?? context.resolveRequest;

  if ((moduleName.startsWith("./") || moduleName.startsWith("../")) && moduleName.endsWith(".js")) {
    try {
      return resolve(context, moduleName.slice(0, -3), platform);
    } catch {
      // Not a compiled-extension TS import after all — fall through to the real name.
    }
  }

  return resolve(context, moduleName, platform);
};

module.exports = withNativeWind(config, { input: "./global.css" });
