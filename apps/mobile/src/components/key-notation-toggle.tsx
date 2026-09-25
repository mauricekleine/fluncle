import { Pressable, StyleSheet, Text, View } from "react-native";
import { type KeyNotation, useKeyNotation } from "@/lib/key-notation";
import { color, font } from "@/theme/tokens";

const NOTATION_OPTIONS: { label: string; value: KeyNotation }[] = [
  { label: "Scales", value: "scales" },
  { label: "Camelot", value: "camelot" },
];

export function KeyNotationToggle() {
  const { notation, setNotation } = useKeyNotation();

  return (
    <View accessibilityLabel="Key notation" accessibilityRole="tablist" style={styles.group}>
      {NOTATION_OPTIONS.map((option) => {
        const selected = notation === option.value;
        return (
          <Pressable
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            hitSlop={6}
            key={option.value}
            onPress={() => setNotation(option.value)}
          >
            <View style={[styles.segment, selected ? styles.segmentOn : null]}>
              <Text
                style={[
                  font.label,
                  styles.segmentText,
                  { color: selected ? color.eclipseGold : color.stardust },
                ]}
              >
                {option.label}
              </Text>
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  group: {
    borderColor: color.dustLine,
    borderRadius: 8,
    borderWidth: 1,
    flexDirection: "row",
    padding: 2,
  },
  segment: {
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  segmentOn: { backgroundColor: color.goldVeil },
  segmentText: { fontSize: 11 },
});
