import { memo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Image } from "expo-image";
import { useRouter } from "expo-router";
import { type TrackListItem } from "@fluncle/contracts";
import { findingLineParts, findingMetaSegments } from "@/lib/archive-state";
import { color, font, radius } from "@/theme/tokens";

// A finding as an archive row (RFC Unit 3): artwork, then the music with its Log
// ID coordinate leading the content and a quiet meta line. The whole row links to
// /log/<id>. Press HEATS the row (The Ignition Rule): the Gold Veil washes the row
// and the coordinate ignites from its resting Stardust to Eclipse Glow — the web
// track-row idiom (styles.css: the Log ID rests muted, heats to accent on hover),
// and the One Sun Rule keeps the coordinate unlit at rest so nothing competes.
//
// The horizontal layout lives on a plain inner View with a STATIC StyleSheet style
// (the most robust path): a Pressable style FUNCTION dropped flexDirection under
// NativeWind, and FlashList v2 mishandled flex-row item roots — so the row layout
// is a plain View and the archive list uses FlatList (see archive.tsx).
export const FindingRow = memo(function FindingRow({
  finding,
  isLast,
}: {
  finding: TrackListItem;
  isLast?: boolean;
}) {
  const router = useRouter();
  const id = finding.logId ?? finding.trackId;
  const line = findingLineParts(finding.artists, finding.title);
  const meta = findingMetaSegments({
    bpm: finding.bpm,
    galaxyName: finding.galaxy?.name,
    key: finding.key,
  });
  const label = `${line.artists} — ${line.title}`;

  return (
    <Pressable
      accessible
      accessibilityRole="button"
      accessibilityLabel={`Open the log page for ${label}`}
      onPress={() => router.push(`/log/${id}`)}
    >
      {({ pressed }) => (
        <View style={[styles.row, isLast ? styles.lastRow : null, pressed ? styles.pressed : null]}>
          <Image
            source={finding.albumImageUrl}
            style={styles.art}
            contentFit="cover"
            transition={200}
          />
          <View style={styles.content}>
            {finding.logId ? (
              <Text
                style={[font.numeric, styles.coordinate, pressed ? styles.coordinateHot : null]}
                numberOfLines={1}
              >
                {finding.logId}
              </Text>
            ) : null}
            {/* The title never shrinks; the artist list is the shrinkable half, so a
                long artist list ellipsizes rather than deleting the title (H3). */}
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
        </View>
      )}
    </Pressable>
  );
});

// A quiet placeholder row for the loading state (B2) and the load-more footer (P3):
// the artwork square and two text bars in the Dust Veil tone, no spinner. It mirrors
// the real row's geometry so the list doesn't jump when the findings arrive.
export function FindingRowSkeleton({ isLast }: { isLast?: boolean }) {
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[styles.row, isLast ? styles.lastRow : null]}
    >
      <View style={[styles.art, styles.skeletonFill]} />
      <View style={styles.content}>
        <View style={[styles.skeletonBar, styles.skeletonBarShort]} />
        <View style={[styles.skeletonBar, styles.skeletonBarLong]} />
      </View>
    </View>
  );
}

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
  skeletonBar: {
    backgroundColor: color.dustVeil,
    borderRadius: 4,
    height: 12,
  },
  skeletonBarLong: { width: "62%" },
  skeletonBarShort: { width: "38%" },
  skeletonFill: { backgroundColor: color.dustVeil },
  title: { color: color.starlightCream, flexShrink: 0 },
  titleLine: { flexDirection: "row" },
});
