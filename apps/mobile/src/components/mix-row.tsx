import { memo, type ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Image } from "expo-image";
import { type MixTrack } from "@fluncle/contracts";
import { findingMetaSegments } from "@/lib/archive-state";
import { formatKey, useKeyNotation } from "@/lib/key-notation";
import { color, font, radius } from "@/theme/tokens";

export type MixRowProps = {
  accessibilityLabel: string;
  isLast?: boolean;
  onPress?: () => void;

  position?: number;
  reasonLabel?: string;
  track: MixTrack;
  trailing?: ReactNode;
};

function RowBody({
  position,
  pressed,
  reasonLabel,
  track,
  trailing,
}: {
  position?: number;
  pressed: boolean;
  reasonLabel?: string;
  track: MixTrack;
  trailing?: ReactNode;
}) {
  const { notation } = useKeyNotation();
  const showCoordinate = track.certified && Boolean(track.logId);
  const meta = findingMetaSegments({ bpm: track.bpm, key: formatKey(track.key, notation) });
  const titleColor = track.certified ? color.starlightCream : color.stardust;

  return (
    <View style={[styles.row, pressed ? styles.pressed : null]}>
      {position === undefined ? null : (
        <Text style={[font.numeric, styles.position]}>{String(position).padStart(2, "0")}</Text>
      )}
      <Image
        contentFit="cover"
        source={track.albumImageUrl ?? undefined}
        style={styles.art}
        transition={200}
      />
      <View style={styles.content}>
        {showCoordinate ? (
          <Text
            numberOfLines={1}
            style={[font.numeric, styles.coordinate, pressed ? styles.coordinateHot : null]}
          >
            {track.logId}
          </Text>
        ) : null}
        <Text numberOfLines={1} style={[font.title, styles.title, { color: titleColor }]}>
          {`${track.artists.join(", ")} — ${track.title}`}
        </Text>
        {meta.length > 0 || reasonLabel ? (
          <View style={styles.metaRow}>
            {meta.length > 0 ? (
              <Text numberOfLines={1} style={[font.body, styles.meta]}>
                {meta.map((segment, index) => (
                  <Text key={segment.text} style={segment.numeric ? styles.metaNumeric : null}>
                    {index > 0 ? "  ·  " : ""}
                    {segment.text}
                  </Text>
                ))}
              </Text>
            ) : null}
            {reasonLabel ? (
              <View style={styles.chip}>
                <Text style={[font.label, styles.chipText]}>{reasonLabel}</Text>
              </View>
            ) : null}
          </View>
        ) : null}
      </View>
      {trailing ?? null}
    </View>
  );
}

export const MixRow = memo(function MixRow({
  accessibilityLabel,
  isLast,
  onPress,
  position,
  reasonLabel,
  track,
  trailing,
}: MixRowProps): ReactNode {
  const withBorder = (node: ReactNode) => (
    <View style={isLast ? styles.lastWrap : styles.wrap}>{node}</View>
  );

  if (onPress) {
    return withBorder(
      <Pressable
        accessible
        accessibilityLabel={accessibilityLabel}
        accessibilityRole="button"
        onPress={onPress}
      >
        {({ pressed }) => (
          <RowBody
            pressed={pressed}
            reasonLabel={reasonLabel}
            track={track}
            trailing={
              <Ionicons
                accessibilityElementsHidden
                color={color.stardust}
                importantForAccessibility="no-hide-descendants"
                name="add"
                size={20}
              />
            }
          />
        )}
      </Pressable>,
    );
  }

  return withBorder(
    <RowBody
      position={position}
      pressed={false}
      reasonLabel={reasonLabel}
      track={track}
      trailing={trailing}
    />,
  );
});

const styles = StyleSheet.create({
  art: {
    backgroundColor: color.tapeBlackFill,
    borderColor: color.dustLine,
    borderRadius: radius.artwork,
    borderWidth: 1,
    height: 56,
    width: 56,
  },
  chip: {
    backgroundColor: color.tapeBlackFill,
    borderColor: color.dustLine,
    borderRadius: 6,
    borderWidth: 1,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  chipText: { color: color.stardust, fontSize: 11 },
  content: { flex: 1, gap: 3 },
  coordinate: { color: color.eclipseGold, fontSize: 13 },
  coordinateHot: { color: color.eclipseGlow },
  lastWrap: { borderBottomColor: "transparent" },
  meta: { color: color.stardust },
  metaNumeric: {
    fontFamily: font.numeric.fontFamily,
    fontVariant: font.numeric.fontVariant,
    letterSpacing: font.numeric.letterSpacing,
  },
  metaRow: { alignItems: "center", flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 2 },
  position: { color: color.stardust, fontSize: 12, textAlign: "center", width: 20 },
  pressed: { backgroundColor: color.goldVeil },
  row: {
    alignItems: "center",
    flexDirection: "row",
    gap: 14,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  title: { flexShrink: 1 },
  wrap: {
    borderBottomColor: color.dustLine,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
});
