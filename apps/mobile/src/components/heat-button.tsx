// The Ignition Rule as a control (DESIGN.md): interaction HEATS gold, press lands
// 1px down. Reduced-motion drops the translate (color-only feedback). RFC Unit 4.
//
// Structure mirrors finding-row.tsx and submit.tsx's CandidateRow: a Pressable
// style FUNCTION drops its output under NativeWind 4.2.5 (verified live — the
// primary actions rendered as bare text on the backdrop), so the Pressable stays
// layout-free and ALL visual styling lives on a plain inner View via StyleSheet;
// only the pressed/heat conditionals ride the children-as-function `pressed` param.
import { type ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useReducedMotion } from "react-native-reanimated";
import { color, font, radius } from "@/theme/tokens";

type Props = {
  label: string;
  onPress: () => void;
  variant?: "primary" | "outline";
  disabled?: boolean;
  // Optional leading node (a Spotify mark, a magnifier, …). The caller owns the
  // icon so this component stays free of any icon-library coupling.
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
    // A real 44pt touch target (paddingVertical 9 + a ~15px label line only reached
    // ~33pt); minHeight floors it to the platform minimum.
    minHeight: 44,
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  disabled: { opacity: 0.6 },
  icon: { alignItems: "center", justifyContent: "center" },
  outline: {
    // DESIGN.md Outline: Dust Line border over translucent Tape Black (30%). The
    // fill lifts the border off Deep Field past WCAG 1.4.11's 3:1 boundary floor.
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
