const DEEP_FIELD = "#090a0b";

const FREE_TEAM = process.env.EXPO_FREE_TEAM === "1";

const withFreeTeamSigning = (config) => {
  const { withEntitlementsPlist } = require("expo/config-plugins");
  return withEntitlementsPlist(config, (c) => {
    delete c.modResults["aps-environment"];
    delete c.modResults["com.apple.developer.associated-domains"];
    return c;
  });
};

const config = {
  android: {
    adaptiveIcon: {
      backgroundColor: DEEP_FIELD,
      foregroundImage: "./assets/adaptive-icon.png",
    },
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
  extra: {
    eas: {
      projectId: "4db7808b-9463-4411-af2a-d0d2c5af72e9",
    },
  },

  icon: "./assets/icon.png",
  ios: {
    bundleIdentifier: "com.fluncle.app",
    infoPlist: {
      ITSAppUsesNonExemptEncryption: false,
    },
    supportsTablet: false,

    ...(FREE_TEAM ? {} : { associatedDomains: ["applinks:www.fluncle.com"] }),
  },
  name: "Fluncle",
  orientation: "portrait",
  plugins: [
    "expo-router",

    [
      "expo-splash-screen",
      {
        backgroundColor: DEEP_FIELD,
        image: "./assets/splash-icon.png",
        imageWidth: 240,
        resizeMode: "contain",
      },
    ],

    ["expo-video", { supportsBackgroundPlayback: true, supportsPictureInPicture: false }],

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
  version: "1.1.0",
};

if (FREE_TEAM) {
  config.plugins.push(withFreeTeamSigning);
}

config.plugins.push(["expo-sqlite", { useLibSQL: true }]);

module.exports = config;
