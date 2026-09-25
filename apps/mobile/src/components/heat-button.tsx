import { type ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useReducedMotion } from "react-native-reanimated";
import { color, font, radius } from "@/theme/tokens";

type Props = {
  label: string;
  onPress: () => void;
  variant?: "primary" | "outline";
  disabled?: boolean;

  icon?: ReactNode;
};

export function HeatButton({ label, onPress, variant = "primary", disabled, icon }: Props) {
  const reduced = useReducedMotion();
  const outline = variant === "outline";

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: disabled ?? false }}
      disabled={disabled}
      onPress={onPress}
    >
      {({ pressed }) => (
        <View
          style={[
            styles.base,
            outline ? styles.outline : styles.primary,
            pressed ? (outline ? styles.outlinePressed : styles.primaryPressed) : null,
            pressed && !reduced ? styles.pressShift : null,
            disabled ? styles.disabled : null,
          ]}
        >
          {icon ? <View style={styles.icon}>{icon}</View> : null}
          <Text
            style={[
              font.label,
              outline
                ? pressed
                  ? styles.textOutlinePressed
                  : styles.textOutline
                : styles.textPrimary,
            ]}
          >
            {label}
          </Text>
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    alignItems: "center",
    borderRadius: radius.md,
    flexDirection: "row",
    gap: 6,
    justifyContent: "center",

    minHeight: 44,
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  disabled: { opacity: 0.6 },
  icon: { alignItems: "center", justifyContent: "center" },
  outline: {
    backgroundColor: color.tapeBlackFill,
    borderColor: color.dustLine,
    borderWidth: 1,
  },
  outlinePressed: { backgroundColor: color.goldVeil, borderColor: color.eclipseGold },
  pressShift: { transform: [{ translateY: 1 }] },
  primary: { backgroundColor: color.eclipseGold },
  primaryPressed: { backgroundColor: color.eclipseGlow },
  textOutline: { color: color.starlightCream },
  textOutlinePressed: { color: color.eclipseGlow },
  textPrimary: { color: color.inkOnGold },
});
