// NativeWind v4 + Expo SDK 56. babel-preset-expo owns the Reanimated/worklets
// plugin (Reanimated 4 via react-native-worklets) — do NOT hand-add it.
module.exports = function (api) {
  api.cache(true);
  return {
    presets: [["babel-preset-expo", { jsxImportSource: "nativewind" }], "nativewind/babel"],
  };
};
