import { Pressable, Text, View } from "react-native";
import { Image } from "expo-image";
import { useRouter } from "expo-router";
import { type TrackListItem } from "@fluncle/contracts";
import { color, font, radius } from "@/theme/tokens";

// A finding as an archive row (RFC Unit 3): the Log ID coordinate leads as the
// finding's identity, then album artwork, the music, and a quiet meta line.
// Rows separate with a 1px Dust Line divider; the last row drops it (the Track
// Row spec, DESIGN.md). Press washes the row in the Gold Veil (The Ignition
// Rule). The whole row links to the finding's /log/<id> page.
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
      style={({ pressed }) => ({
        alignItems: "center",
        backgroundColor: pressed ? color.goldVeil : "transparent",
        borderBottomColor: isLast ? "transparent" : color.dustLine,
        borderBottomWidth: isLast ? 0 : 1,
        flexDirection: "row",
        gap: 14,
        paddingHorizontal: 16,
        paddingVertical: 15,
      })}
    >
      {finding.logId ? (
        <Text style={[font.numeric, { color: color.eclipseGlow, width: 56 }]}>{finding.logId}</Text>
      ) : null}
      <Image
        source={finding.albumImageUrl}
        style={{
          borderColor: color.dustLine,
          borderRadius: radius.artwork,
          borderWidth: 1,
          height: 52,
          width: 52,
        }}
        contentFit="cover"
        transition={200}
      />
      <View style={{ flex: 1, gap: 5 }}>
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
