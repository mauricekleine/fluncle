import { Linking } from "react-native";
import { openTarget } from "@/lib/external-link";

// The ONE seam for opening a url outside the app. Every `Linking.openURL` call site goes
// through here so hop urls (fluncle.com/out/…) resolve to their destination first and iOS
// hands the final url to the native app that owns it — see ./external-link.ts for the
// decision and the fallback contract.
//
// Fire-and-forget with a swallowed failure, matching the app's void-catch idiom: nothing
// on screen changes on a tap, and a device with no handler for the url must not throw
// into a press handler. `openTarget` never rejects; `Linking.openURL` can.
//
// A non-hop url reaches `Linking.openURL` one microtask later than it used to (the
// decision is async). No network, no user-visible difference.
export function openExternalUrl(url: string): void {
  void openTarget(url, (target) => fetch(target))
    .then((final) => Linking.openURL(final))
    .catch(() => undefined);
}
