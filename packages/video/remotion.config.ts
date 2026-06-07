import { Config } from "@remotion/cli/config";

// Composition registry entry point. The real comp ships later; this keeps the
// package renderable/typecheckable today.
Config.setEntryPoint("src/remotion/index.ts");
Config.setVideoImageFormat("jpeg");
Config.overrideWebpackConfig((config) => config);
