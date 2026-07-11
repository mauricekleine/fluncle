import { NativeTabs } from "expo-router/unstable-native-tabs";
import { color } from "@/theme/tokens";

// Native tab bar (real UITabBar on iOS / Material on Android). Warm-dark canon via the
// token adapter; Eclipse Gold is the selected accent (One Sun). Four top-level surfaces
// — the two ways to browse the findings (Feed / Archive), then the two operator-adopted
// audio surfaces (Radio / Mixtapes). Four short labels sit within the iOS 26 floating
// pill at 390px; the tint marks selection, so a symbol without a `.fill` twin still
// reads. Labels stay literal (the Chrome Rule). NativeTabs renders in a dev client /
// native build, not plain Expo Go.
//
// IA is an OPERATOR-TASTE CHECKPOINT: four peer tabs vs. Radio-as-tab + Mixtapes-nested
// is a taste call; four peers is proposed because each maps to a distinct web surface
// (radio.fluncle.com, /mixtapes) and neither audio surface is a child of the other.
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
      <NativeTabs.Trigger name="radio">
        <NativeTabs.Trigger.Label>Radio</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          md="radio"
          sf={{
            default: "dot.radiowaves.left.and.right",
            selected: "dot.radiowaves.left.and.right",
          }}
        />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="mixtapes">
        <NativeTabs.Trigger.Label>Mixtapes</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          md="queue_music"
          sf={{ default: "music.note.list", selected: "music.note.list" }}
        />
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
