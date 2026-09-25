import { Config } from "@remotion/cli/config";

import { glRenderer } from "./src/pipeline/gl";

Config.setEntryPoint("src/remotion/index.ts");
Config.setVideoImageFormat("jpeg");

Config.setChromiumOpenGlRenderer(glRenderer());
Config.overrideWebpackConfig((config) => config);
