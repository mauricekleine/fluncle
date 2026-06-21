import { Pressable, Text, View } from "react-native";
import { Image } from "expo-image";
import { useRouter } from "expo-router";
import { type TrackListItem } from "@fluncle/contracts";
import { color, font, radius } from "@/theme/tokens";

// A finding as an archive row (RFC Unit 3): Log ID coordinate, artwork, the music,
// quiet chips. The whole row links to the log page.
export function FindingRow({ finding }: { finding: TrackListItem }) {
  const router = useRouter();
  const id = finding.logId ?? finding.trackId;
  const chips = [
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
        borderBottomColor: color.dustLine,
        borderBottomWidth: 1,
        flexDirection: "row",
        gap: 12,
        paddingHorizontal: 16,
        paddingVertical: 12,
      })}
    >
      {finding.logId ? (
        <Text style={[font.numeric, { color: color.eclipseGlow, width: 64 }]}>{finding.logId}</Text>
      ) : null}
      <Image
        source={finding.albumImageUrl}
        style={{ borderRadius: radius.artwork, height: 44, width: 44 }}
        contentFit="cover"
        transition={200}
      />
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={[font.title, { color: color.starlightCream }]} numberOfLines={1}>
          {finding.artists.join(", ")} — {finding.title}
        </Text>
        {chips.length ? (
          <Text style={[font.body, { color: color.stardust }]} numberOfLines={1}>
            {chips.join("  ·  ")}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}
