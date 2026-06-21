import { NativeTabs } from "expo-router/unstable-native-tabs";
import { color } from "@/theme/tokens";

// Native tab bar (real UITabBar on iOS / Material on Android). Warm-dark canon via
// the token adapter; Eclipse Gold is the selected accent (One Sun). Working labels
// (RFC D9: "Stories" is a TikTok-ism flagged for a voice pass). NativeTabs renders
// in a dev client / native build, not plain Expo Go.
export default function TabsLayout() {
  return (
    <NativeTabs
      backgroundColor={color.sleeveBlack}
      labelStyle={{ color: color.stardust }}
      tintColor={color.eclipseGold}
    >
      <NativeTabs.Trigger name="index">
        <NativeTabs.Trigger.Label>Feed</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          md="movie"
          sf={{ default: "play.rectangle", selected: "play.rectangle.fill" }}
        />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="archive">
        <NativeTabs.Trigger.Label>Archive</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          md="inventory_2"
          sf={{ default: "square.stack", selected: "square.stack.fill" }}
        />
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
