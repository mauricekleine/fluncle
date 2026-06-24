import { Config } from "@remotion/cli/config";

import { glRenderer } from "./src/pipeline/gl";

// Composition registry entry point.
Config.setEntryPoint("src/remotion/index.ts");
Config.setVideoImageFormat("jpeg");
// GPU shaders need a real GL context: ANGLE (Metal on Apple Silicon) for Studio
// and local CLI renders, swangle (software) on a GPU-less host — driven by
// FLUNCLE_GL (see src/pipeline/gl.ts). Verified locally: "ANGLE Metal Renderer".
Config.setChromiumOpenGlRenderer(glRenderer());
Config.overrideWebpackConfig((config) => config);
