// The Ignition Rule as a control (DESIGN.md): interaction HEATS gold, press lands
// 1px down. Reduced-motion drops the translate (color-only feedback). RFC Unit 4.
import { Pressable, Text } from "react-native";
import { useReducedMotion } from "react-native-reanimated";
import { color, font } from "@/theme/tokens";

type Props = {
  label: string;
  onPress: () => void;
  variant?: "primary" | "outline";
  disabled?: boolean;
};

export function HeatButton({ label, onPress, variant = "primary", disabled }: Props) {
  const reduced = useReducedMotion();

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        {
          alignItems: "center",
          borderRadius: 8,
          opacity: disabled ? 0.6 : 1,
          paddingHorizontal: 14,
          paddingVertical: 9,
          transform: pressed && !reduced ? [{ translateY: 1 }] : [],
        },
        variant === "primary"
          ? { backgroundColor: pressed ? color.eclipseGlow : color.eclipseGold }
          : {
              backgroundColor: pressed ? color.goldVeil : "transparent",
              borderColor: pressed ? color.eclipseGold : color.dustLine,
              borderWidth: 1,
            },
      ]}
    >
      {({ pressed }) => (
        <Text
          style={[
            font.label,
            {
              color:
                variant === "primary"
                  ? color.inkOnGold
                  : pressed
                    ? color.eclipseGlow
                    : color.starlightCream,
            },
          ]}
        >
          {label}
        </Text>
      )}
    </Pressable>
  );
}
