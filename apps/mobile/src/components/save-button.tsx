import { type ReactNode } from "react";
import { Pressable } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { color } from "@/theme/tokens";

export function SaveButton({ onPress, saved }: { onPress: () => void; saved: boolean }): ReactNode {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: saved }}
      accessibilityLabel={saved ? "Saved" : "Save"}
      hitSlop={{ bottom: 10, left: 10, right: 10, top: 10 }}
      onPress={onPress}
      style={{ padding: 16 }}
    >
      {({ pressed }) => (
        <Ionicons
          name={saved ? "bookmark" : "bookmark-outline"}
          size={24}
          color={saved || pressed ? color.eclipseGold : color.stardust}
        />
      )}
    </Pressable>
  );
}
