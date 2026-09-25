export default {
  ignore: {
    overrides: [
      {
        files: [
          "src/routes/radio.tsx",
          "src/routes/log.$logId.tsx",
          "src/routes/admin/login.tsx",
          "src/components/admin/admin-nav.tsx",
          "src/components/admin/push-dialog.tsx",
          "src/components/stories/story-view.tsx",
        ],
        rules: ["react-doctor/control-has-associated-label", "react-doctor/anchor-has-content"],
      },

      {
        files: ["src/routes/radio.tsx", "src/components/stories/story-view.tsx"],
        rules: ["react-doctor/no-aria-hidden-on-focusable", "react-doctor/media-has-caption"],
      },

      {
        files: [
          "src/routes/admin/mixtapes.tsx",
          "src/routes/admin/index.tsx",
          "src/routes/account.tsx",
          "src/routes/radio.tsx",
        ],
        rules: ["react-doctor/no-multi-comp"],
      },

      {
        files: [
          "src/lib/server/account-data.ts",
          "src/lib/server/backfill.ts",
          "src/lib/server/discogs.ts",
          "src/lib/server/mixtapes.ts",
          "src/lib/server/log-id.ts",

          "src/lib/server/retry.ts",
          "src/routes/radio.tsx",
        ],
        rules: ["react-doctor/async-await-in-loop"],
      },
      {
        files: ["src/lib/server/postiz.ts"],
        rules: ["react-doctor/server-sequential-independent-await", "react-doctor/js-index-maps"],
      },
      {
        files: ["src/lib/server/publish.ts"],
        rules: ["react-doctor/async-defer-await"],
      },

      {
        files: ["src/lib/server/lastfm.ts"],
        rules: ["react-doctor/insecure-crypto-risk"],
      },

      {
        files: ["src/lib/server/env.ts"],
        rules: ["react-doctor/js-set-map-lookups"],
      },

      {
        files: ["src/routes/admin/index.tsx"],
        rules: [
          "react-doctor/prefer-useReducer",
          "react-doctor/jsx-no-jsx-as-prop",
          "react-doctor/no-pass-live-state-to-parent",
        ],
      },

      {
        files: ["src/components/copy-button.tsx"],
        rules: ["react-doctor/exhaustive-deps"],
      },

      {
        files: ["src/routes/admin/login.tsx", "src/routes/galaxy.tsx"],
        rules: ["react-doctor/tanstack-start-no-anchor-element"],
      },

      {
        files: ["src/routes/docs.$.tsx", "src/routes/docs.index.tsx"],
        rules: ["react-doctor/tanstack-start-loader-parallel-fetch"],
      },

      {
        files: ["src/lib/server/openapi-to-postman.test.ts"],
        rules: ["react-doctor/no-json-parse-stringify-clone"],
      },

      {
        files: ["src/lib/use-in-viewport.ts"],
        rules: ["react-doctor/no-adjust-state-on-prop-change"],
      },

      {
        files: ["src/routes/admin/mixtapes.tsx"],
        rules: [
          "react-doctor/no-pass-data-to-parent",
          "react-doctor/no-event-handler",
          "react-doctor/no-derived-state",
        ],
      },
    ],
  },
};
