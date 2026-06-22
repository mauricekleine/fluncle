import { Linking, Pressable, ScrollView, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { Image } from "expo-image";
import { useFinding } from "@/api/hooks";
import { CosmosBackdrop } from "@/components/cosmos-backdrop";
import { HeatButton } from "@/components/heat-button";
import { color, font, radius } from "@/theme/tokens";

// The finding screen + deep-link target (RFC Unit 3). Coordinates are uppercased
// before resolving (the /log lookup is case-sensitive).
// The fluncle.com home for a mixtape (it lives on the web, not in the app).
const MIXTAPE_WEB_BASE = "https://www.fluncle.com/log";

export default function LogScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { data: resolution, isLoading } = useFinding((id ?? "").toUpperCase());
  const finding = resolution?.kind === "finding" ? resolution.finding : undefined;

  return (
    <View style={{ flex: 1 }}>
      <CosmosBackdrop />
      <SafeAreaView style={{ flex: 1 }}>
        <Pressable onPress={() => router.back()} style={{ padding: 16 }}>
          <Text style={[font.label, { color: color.stardust }]}>Close</Text>
        </Pressable>
        {finding ? (
          <ScrollView contentContainerStyle={{ gap: 12, padding: 16 }}>
            {finding.logId ? (
              <Text style={[font.numeric, { color: color.eclipseGlow }]}>{finding.logId}</Text>
            ) : null}
            <Image
              source={finding.albumImageUrl}
              style={{ aspectRatio: 1, borderRadius: radius.lg, width: "100%" }}
              contentFit="cover"
              transition={250}
            />
            <Text style={[font.title, { color: color.starlightCream, fontSize: 20 }]}>
              {finding.artists.join(", ")} — {finding.title}
            </Text>
            {finding.note ? (
              <Text style={[font.body, { color: color.stardust }]}>{finding.note}</Text>
            ) : null}
            <View style={{ marginTop: 4 }}>
              <HeatButton
                label="Open in Spotify"
                onPress={() => Linking.openURL(finding.spotifyUrl)}
              />
            </View>
          </ScrollView>
        ) : resolution?.kind === "mixtape" ? (
          // A mixtape is Fluncle dreaming, a long recording that lives on the web.
          // Point the crew there instead of a flat "not found".
          <View style={{ gap: 12, padding: 16 }}>
            {resolution.logId ? (
              <Text style={[font.numeric, { color: color.eclipseGlow }]}>{resolution.logId}</Text>
            ) : null}
            <Text style={[font.body, { color: color.stardust }]}>
              That coordinate is a mixtape, not a finding. Play it on the web.
            </Text>
            <View style={{ marginTop: 4 }}>
              <HeatButton
                label="Open on fluncle.com"
                onPress={() =>
                  Linking.openURL(
                    resolution.logId
                      ? `${MIXTAPE_WEB_BASE}/${encodeURIComponent(resolution.logId)}`
                      : MIXTAPE_WEB_BASE,
                  )
                }
              />
            </View>
          </View>
        ) : (
          <Text style={[font.body, { color: color.stardust, padding: 16 }]}>
            {isLoading ? "Recovering finding…" : "Finding not found."}
          </Text>
        )}
      </SafeAreaView>
    </View>
  );
}
