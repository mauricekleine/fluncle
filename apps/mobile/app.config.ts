import { type ExpoConfig } from "expo/config";
import { withEntitlementsPlist, type ConfigPlugin } from "expo/config-plugins";

// Config-time brand hexes are hardcoded: Expo evaluates app.config.ts standalone
// and cannot import the raw-TS @fluncle/tokens package. Mirror of packages/tokens.
const DEEP_FIELD = "#090a0b";

// Personal/free Apple teams can't sign Push Notifications or Associated Domains
// (paid Developer Program only). EXPO_FREE_TEAM=1 strips both so you can run on a
// physical device with a free Apple ID — that build loses remote push + universal
// links (both need the paid account anyway; the fluncle:// scheme still deep-links).
// Omit the env var for paid / EAS builds to keep the full V1 capabilities.
const FREE_TEAM = process.env.EXPO_FREE_TEAM === "1";

const withFreeTeamSigning: ConfigPlugin = (config) =>
  withEntitlementsPlist(config, (c) => {
    delete c.modResults["aps-environment"];
    delete c.modResults["com.apple.developer.associated-domains"];
    return c;
  });

const config: ExpoConfig = {
  android: {
    intentFilters: [
      {
        action: "VIEW",
        autoVerify: true,
        category: ["BROWSABLE", "DEFAULT"],
        data: [{ host: "www.fluncle.com", pathPrefix: "/log", scheme: "https" }],
      },
    ],
    package: "com.fluncle.app",
  },
  backgroundColor: DEEP_FIELD,
  experiments: { typedRoutes: false },
  ios: {
    bundleIdentifier: "com.fluncle.app",
    supportsTablet: false,
    // universal links need the paid account — omitted on free-team builds
    ...(FREE_TEAM ? {} : { associatedDomains: ["applinks:www.fluncle.com"] }),
  },
  name: "Fluncle",
  orientation: "portrait",
  plugins: [
    "expo-router",
    ["expo-splash-screen", { backgroundColor: DEEP_FIELD, resizeMode: "contain" }],
    ["expo-video", { supportsBackgroundPlayback: false, supportsPictureInPicture: false }],
    // The Radio surface keeps the spoken observation playing past a lock / backgrounding.
    // This plugin adds iOS `UIBackgroundModes: ["audio"]` and the Android media-playback
    // foreground service + permissions. Recording is disabled (Radio never records), so
    // no microphone permission or RECORD_AUDIO is requested. NOTE: this is a NATIVE
    // config change — it needs a rebuild (`expo run:ios` / a new EAS build), NOT a reload.
    [
      "expo-audio",
      {
        enableBackgroundPlayback: true,
        enableBackgroundRecording: false,
        microphonePermission: false,
        recordAudioAndroid: false,
      },
    ],
  ],
  scheme: "fluncle",
  slug: "fluncle",
  userInterfaceStyle: "dark",
  version: "0.1.0",
};

if (FREE_TEAM) {
  (config.plugins as unknown[]).push(withFreeTeamSigning);
}

export default config;
