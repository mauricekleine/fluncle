import { memo, type ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Image } from "expo-image";
import { type MixTrack } from "@fluncle/contracts";
import { findingMetaSegments } from "@/lib/archive-state";
import { color, font, radius } from "@/theme/tokens";

// A set-builder row — the archive-row twin for the Mix tab: cover, then the music with its
// coordinate leading the content and a quiet key·BPM meta line. Serves three jobs with one
// shape: an OPENER / CANDIDATE (the whole row presses to add — `onPress`), each candidate
// carrying its reason chip; and a CHAIN row (no `onPress`, a trailing remove control).
//
// THE UNLIT RULE (DESIGN.md), mirrored from the web mix-builder: a certified finding carries
// its Log ID in Oxanium gold and heats to Eclipse Glow on press; a track Fluncle never
// certified carries no coordinate and rests in the cold Dust Veil register (its title +
// artists dimmed to Stardust) — never labelled, never introduced, never given a noun. The
// register is the whole statement; there is no badge and no heading naming the tier.
//
// Layout is a plain inner View with a static StyleSheet style: a Pressable style FUNCTION
// drops flexDirection under NativeWind (see finding-row.tsx), so all layout is static and
// only the pressed/heat conditionals ride the children-as-function `pressed` param.

export type MixRowProps = {
  accessibilityLabel: string;
  isLast?: boolean;
  onPress?: () => void;
  reasonLabel?: string;
  track: MixTrack;
  trailing?: ReactNode;
};

function RowBody({
  pressed,
  reasonLabel,
  track,
  trailing,
}: {
  pressed: boolean;
  reasonLabel?: string;
  track: MixTrack;
  trailing?: ReactNode;
}) {
  const showCoordinate = track.certified && Boolean(track.logId);
  const meta = findingMetaSegments({ bpm: track.bpm, key: track.key });
  const titleColor = track.certified ? color.starlightCream : color.stardust;

  return (
    <View style={[styles.row, pressed ? styles.pressed : null]}>
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
  reasonLabel,
  track,
  trailing,
}: MixRowProps): ReactNode {
  const withBorder = (node: ReactNode) => (
    <View style={isLast ? styles.lastWrap : styles.wrap}>{node}</View>
  );

  // An add row (opener / candidate): the whole row presses to add, with a quiet "+" affordance.
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

  // A chain row: not pressable itself; the caller supplies a trailing control (the remove ✕).
  return withBorder(
    <RowBody pressed={false} reasonLabel={reasonLabel} track={track} trailing={trailing} />,
  );
});

const styles = StyleSheet.create({
  art: {
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
