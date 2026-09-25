import { NativeTabs } from "expo-router/unstable-native-tabs";
import { color } from "@/theme/tokens";

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
      <NativeTabs.Trigger name="mix">
        <NativeTabs.Trigger.Label>Decks</NativeTabs.Trigger.Label>

        <NativeTabs.Trigger.Icon
          renderingMode="template"
          src={{
            default: require("../../assets/decks-tab-icon.png"),
            selected: require("../../assets/decks-tab-icon.png"),
          }}
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
