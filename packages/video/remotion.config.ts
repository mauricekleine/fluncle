import { Config } from "@remotion/cli/config";

// Composition registry entry point. The real comp ships later; this keeps the
// package renderable/typecheckable today.
Config.setEntryPoint("src/remotion/index.ts");
Config.setVideoImageFormat("jpeg");
// GPU shaders: render through ANGLE (Metal on Apple Silicon) so WebGL
// compositions (ShaderLayer) have a real hardware GL context in headless
// Studio/CLI renders. Verified renderer: "ANGLE Metal Renderer: Apple M5 Pro".
Config.setChromiumOpenGlRenderer("angle");
Config.overrideWebpackConfig((config) => config);
