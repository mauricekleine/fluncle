import { memo, type ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Image } from "expo-image";
import { findingLineParts, findingMetaSegments } from "@/lib/archive-state";
import { color, font, radius } from "@/theme/tokens";

// A finding OR an uncertified track as an archive row — the shared presentational
// twin of finding-row.tsx, reused by the search results and the Saved view. It never
// decides its own destination: the caller owns onPress and the a11y label, so the
// same row serves a certified finding (taps to /log) and a track that links OUT to
// Spotify.
//
// THE UNLIT RULE (DESIGN.md), mirrored from the web palette: a certified finding
// carries its Log ID coordinate in Oxanium and heats to Eclipse Glow on press (the
// Gold Veil washes the row). A track Fluncle never certified catches only the cold
// Dust Veil, carries no coordinate, and shows a quiet "leaves the app" arrow instead
// — never labelled, never introduced, never given a noun. "Finding" stays the only
// named object. Layout is a plain inner View with a static StyleSheet style (a
// Pressable style FUNCTION drops flexDirection under NativeWind — see finding-row.tsx).

export type ArchiveRowProps = {
  accessibilityLabel: string;
  albumImageUrl?: string | null;
  artists: string[];
  bpm?: number | null;
  certified: boolean;
  galaxyName?: string | null;
  isLast?: boolean;
  logId?: string | null;
  // Not named `key`: React reserves that prop. This is the musical key segment.
  musicalKey?: string | null;
  onPress: () => void;
  title: string;
};

export const ArchiveRow = memo(function ArchiveRow({
  accessibilityLabel,
  albumImageUrl,
  artists,
  bpm,
  certified,
  galaxyName,
  isLast,
  logId,
  musicalKey,
  onPress,
  title,
}: ArchiveRowProps): ReactNode {
  const line = findingLineParts(artists, title);
  const meta = findingMetaSegments({ bpm, galaxyName, key: musicalKey });
  const showCoordinate = certified && Boolean(logId);

  return (
    <Pressable
      accessible
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
    >
      {({ pressed }) => (
        <View style={[styles.row, isLast ? styles.lastRow : null, pressed ? styles.pressed : null]}>
          <Image
            source={albumImageUrl ?? undefined}
            style={styles.art}
            contentFit="cover"
            transition={200}
          />
          <View style={styles.content}>
            {showCoordinate ? (
              <Text
                style={[font.numeric, styles.coordinate, pressed ? styles.coordinateHot : null]}
                numberOfLines={1}
              >
                {logId}
              </Text>
            ) : null}
            <View style={styles.titleLine}>
              <Text style={[font.title, styles.artists]} numberOfLines={1} ellipsizeMode="tail">
                {line.artists}
              </Text>
              <Text style={[font.title, styles.title]} numberOfLines={1}>
                {` — ${line.title}`}
              </Text>
            </View>
            {meta.length ? (
              <Text style={[font.body, styles.meta]} numberOfLines={1}>
                {meta.map((segment, index) => (
                  <Text key={segment.text} style={segment.numeric ? styles.metaNumeric : null}>
                    {index > 0 ? "  ·  " : ""}
                    {segment.text}
                  </Text>
                ))}
              </Text>
            ) : null}
          </View>
          {/* An uncertified track has no coordinate; the cold "leaves the app" arrow
              says it links out (the row's a11y label names Spotify). aria-hidden so the
              icon doesn't double-read over that label. */}
          {showCoordinate ? null : (
            <Ionicons
              name="open-outline"
              size={16}
              color={color.stardust}
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
            />
          )}
        </View>
      )}
    </Pressable>
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
  artists: { color: color.starlightCream, flexShrink: 1 },
  content: { flex: 1, gap: 3 },
  coordinate: { color: color.stardust, fontSize: 13 },
  coordinateHot: { color: color.eclipseGlow },
  lastRow: { borderBottomColor: "transparent" },
  meta: { color: color.stardust },
  metaNumeric: {
    fontFamily: font.numeric.fontFamily,
    fontVariant: font.numeric.fontVariant,
    letterSpacing: font.numeric.letterSpacing,
  },
  pressed: { backgroundColor: color.goldVeil },
  row: {
    alignItems: "center",
    borderBottomColor: color.dustLine,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: 14,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  title: { color: color.starlightCream, flexShrink: 0 },
  titleLine: { flexDirection: "row" },
});
