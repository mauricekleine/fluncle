import { Config } from "@remotion/cli/config";

// Image-asset registry entry point. Image assets are rendered as stills
// (renderStill), so the default image format is PNG, not JPEG.
Config.setEntryPoint("src/remotion/index.ts");
Config.setVideoImageFormat("png");
// Match packages/video: render through ANGLE (Metal on Apple Silicon) so any
// WebGL-backed layer has a real hardware GL context in headless Studio/CLI
// renders. Harmless for plain CSS/SVG compositions like the OG card.
Config.setChromiumOpenGlRenderer("angle");
Config.overrideWebpackConfig((config) => config);
