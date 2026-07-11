import { type ReactNode } from "react";
import { Pressable } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { color } from "@/theme/tokens";

// The save toggle on the finding screen — a quiet bookmark. Device-local only (the
// ungated saved variant; server-synced saves wait on the marginalia RFC). At rest it
// is cold Stardust; saved, it lights Eclipse Gold (the Ignition Rule: gold is the
// certification/held light) and fills in. Icon-only chrome carries the literal in its
// a11y label (the Chrome Rule): "Save" when it will save, "Saved" when it will unsave,
// and `selected` state so a screen reader announces the toggle. Padding + hitSlop lift
// the effective target past the 44pt floor.

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
