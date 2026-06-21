import { Pressable, StyleSheet, Text, View } from "react-native";
import { Image } from "expo-image";
import { useRouter } from "expo-router";
import { type TrackListItem } from "@fluncle/contracts";
import { color, font, radius } from "@/theme/tokens";

// A finding as an archive row (RFC Unit 3): artwork, then the music with its Log
// ID coordinate leading the content and a quiet meta line. Press washes the row in
// the Gold Veil (Ignition). The whole row links to /log/<id>. The row layout lives
// in a StyleSheet (a function returning an OBJECT style drops flexDirection under
// NativeWind's transform — return an array of static styles instead).
export function FindingRow({ finding, isLast }: { finding: TrackListItem; isLast?: boolean }) {
  const router = useRouter();
  const id = finding.logId ?? finding.trackId;
  const meta = [
    finding.bpm ? `${Math.round(finding.bpm)} BPM` : null,
    finding.key ?? null,
    finding.galaxy?.name ?? null,
  ].filter(Boolean) as string[];

  return (
    <Pressable
      onPress={() => router.push(`/log/${id}`)}
      style={({ pressed }) => [
        styles.row,
        isLast ? styles.lastRow : null,
        pressed ? styles.pressed : null,
      ]}
    >
      <Image
        source={finding.albumImageUrl}
        style={styles.art}
        contentFit="cover"
        transition={200}
      />
      <View style={styles.content}>
        {finding.logId ? (
          <Text style={[font.numeric, styles.coordinate]} numberOfLines={1}>
            {finding.logId}
          </Text>
        ) : null}
        <Text style={[font.title, { color: color.starlightCream }]} numberOfLines={1}>
          {finding.artists.join(", ")} — {finding.title}
        </Text>
        {meta.length ? (
          <Text style={[font.body, { color: color.stardust }]} numberOfLines={1}>
            {meta.join("  ·  ")}
          </Text>
        ) : null}
      </View>
    </Pressable>
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
  content: { flex: 1, gap: 3 },
  coordinate: { color: color.eclipseGlow, fontSize: 13 },
  lastRow: { borderBottomColor: "transparent" },
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
});
