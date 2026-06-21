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
export default function LogScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { data: finding, isLoading } = useFinding((id ?? "").toUpperCase());

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
        ) : (
          <Text style={[font.body, { color: color.stardust, padding: 16 }]}>
            {isLoading ? "Recovering finding…" : "Finding not found."}
          </Text>
        )}
      </SafeAreaView>
    </View>
  );
}
