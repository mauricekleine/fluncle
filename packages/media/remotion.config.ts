import { Config } from "@remotion/cli/config";

Config.setEntryPoint("src/remotion/index.ts");
Config.setVideoImageFormat("png");

Config.setChromiumOpenGlRenderer("angle");
Config.overrideWebpackConfig((config) => config);
