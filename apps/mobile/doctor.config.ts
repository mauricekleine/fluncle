// React Doctor config — https://www.react.doctor/docs/configuration/config-files
// `ignore.overrides` parks confirmed false positives (with the reason) so repeat
// scans stay signal. Real issues are fixed in code, never listed here.
export default {
  ignore: {
    overrides: [
      // `contentContainerStyle={{ paddingBottom: insets.bottom + 20 }}` — the
      // safe-area inset is mount-stable on this screen (no keyboard), so the list
      // never "jumps". The canonical contentInset fix is iOS-only and would drop
      // the bottom padding on Android (last row clipped behind the nav bar).
      {
        // glob avoids the literal "(tabs)" route-group parens (extglob syntax).
        files: ["app/*/archive.tsx"],
        rules: ["react-doctor/rn-scrollview-dynamic-padding"],
      },
      // The visible-card-only playback effect reacts to the `active` prop, which
      // is driven by the parent FlashList's onViewableItemsChanged subscription —
      // an external source this cell can't observe via an in-component handler;
      // the paired setObserving(false) is a constant reset, not a chained update.
      {
        files: ["src/components/feed-card.tsx"],
        rules: ["react-doctor/no-event-handler", "react-doctor/no-chain-state-updates"],
      },
    ],
  },
};
