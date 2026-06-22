// React Doctor config — https://www.react.doctor/docs/configuration/config-files
//
// `ignore.overrides` drops specific (file, rule) diagnostics that are confirmed
// FALSE POSITIVES for this codebase, so repeat scans stay signal. Each entry
// records WHY it's a false positive. Real issues are fixed in code, never listed
// here. Keep this list narrow — a whole-file rule ignore can mask a future real
// hit, so only park rules whose finding is genuinely inapplicable here.
export default {
  ignore: {
    overrides: [
      // Base UI `<Button render={<a/>} />` / `render={<Link/>}` composition:
      // the accessible name (text/icon children or aria-label) is merged into the
      // rendered anchor at runtime via useRender, so the DOM IS labelled — the
      // static analyzer just can't see through the render prop. (Where it was
      // cheap, we instead added an explicit aria-label in code; these files use
      // the pattern pervasively, so they're parked.)
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

      // Decorative, muted, `aria-hidden` background <video>/<audio> with no
      // `controls` and no `tabIndex` — not focusable, not interactive, no caption
      // track needed. The rules target focusable/interactive media.
      {
        files: ["src/routes/radio.tsx", "src/components/stories/story-view.tsx"],
        rules: ["react-doctor/no-aria-hidden-on-focusable", "react-doctor/media-has-caption"],
      },

      // Canonical Shadcn-generated primitives — their export surface and ARIA
      // shape are part of the design system; diverging would break the contract.
      {
        files: [
          "src/components/ui/badge.tsx",
          "src/components/ui/button.tsx",
          "src/components/ui/tabs.tsx",
        ],
        rules: ["react-doctor/only-export-components"],
      },
      {
        files: ["src/components/ui/input-group.tsx"],
        rules: [
          "react-doctor/no-multi-comp",
          "react-doctor/prefer-tag-over-role",
          "react-doctor/click-events-have-key-events",
        ],
      },
      {
        files: ["src/components/ui/label.tsx"],
        rules: ["react-doctor/label-has-associated-control"],
      },

      // TanStack route files: a single `Route` export plus tightly-coupled
      // private helper components is the rule's own documented exemption.
      {
        files: [
          "src/routes/admin/mixtapes.tsx",
          "src/routes/admin/index.tsx",
          "src/routes/account.tsx",
          "src/routes/radio.tsx",
        ],
        rules: ["react-doctor/no-multi-comp"],
      },

      // Sequential awaits that MUST stay sequential: retries that depend on the
      // prior outcome, ordered DB writes, and per-item calls to rate-limited
      // third-party APIs (Discogs / MusicBrainz / Last.fm / Postiz).
      // Naive Promise.all here risks 429s, ordering bugs, or shared-state races.
      {
        files: [
          "src/lib/server/account-data.ts",
          "src/lib/server/backfill.ts",
          "src/lib/server/discogs.ts",
          "src/lib/server/mixtapes.ts",
          "src/lib/server/log-id.ts",
          // retry loops: each attempt only runs because the prior one failed —
          // the rule's documented exemption (not independent iterations).
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

      // MD5 here is the Last.fm api_sig protocol requirement (like OAuth1/Digest),
      // an explicitly exempted protocol context — not a security choice.
      {
        files: ["src/lib/server/lastfm.ts"],
        rules: ["react-doctor/insecure-crypto-risk"],
      },
      // `part.indexOf("=")` is a string char-search, not array membership.
      {
        files: ["src/lib/server/env.ts"],
        rules: ["react-doctor/js-set-map-lookups"],
      },

      // admin board: 15 independent per-dialog state slices (not one cohesive
      // group), and `subheader` JSX-as-prop into a non-memo'd AdminShell costs
      // nothing — both are the rules' documented FP shapes.
      {
        files: ["src/routes/admin/index.tsx"],
        rules: ["react-doctor/prefer-useReducer", "react-doctor/jsx-no-jsx-as-prop"],
      },

      // Full-page navigations that must escape client routing: the Spotify OAuth
      // handoff and the <noscript> no-JS fallback link.
      {
        files: ["src/routes/admin/login.tsx", "src/routes/galaxy.tsx"],
        rules: ["react-doctor/tanstack-start-no-anchor-element"],
      },
      // Loader's second fetch depends on the path resolved by the first await.
      {
        files: ["src/routes/docs.$.tsx", "src/routes/docs.index.tsx"],
        rules: ["react-doctor/tanstack-start-loader-parallel-fetch"],
      },
      // JSON round-trip in these tests ASSERTS serialisability (.not.toThrow);
      // structuredClone would defeat the test's purpose.
      {
        files: ["src/lib/server/openapi-to-postman.test.ts"],
        rules: ["react-doctor/no-json-parse-stringify-clone"],
      },
      // Synchronous no-IntersectionObserver fallback latch, not a prop reset.
      {
        files: ["src/lib/use-in-viewport.ts"],
        rules: ["react-doctor/no-adjust-state-on-prop-change"],
      },

      // mixtapes editor: the flagged effects call only local setters (no parent
      // callback), the cited no-event-handler lines are a ref-mirror (not the
      // rule's effect shape), and the "derived state" is editable local copies of
      // server data whose suggested fix (derive-in-render / key remount) would
      // discard in-progress edits and break autosave. All inapplicable here.
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
