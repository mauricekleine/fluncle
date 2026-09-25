import { Linking } from "react-native";
import { openTarget } from "@/lib/external-link";

export function openExternalUrl(url: string): void {
  void openTarget(url, (target) => fetch(target))
    .then((final) => Linking.openURL(final))
    .catch(() => undefined);
}
