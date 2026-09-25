export default {
  ignore: {
    overrides: [
      {
        files: ["app/*/archive.tsx"],
        rules: ["react-doctor/rn-scrollview-dynamic-padding"],
      },

      {
        files: ["src/components/feed-card.tsx"],
        rules: ["react-doctor/no-event-handler", "react-doctor/no-chain-state-updates"],
      },
    ],
  },
};
