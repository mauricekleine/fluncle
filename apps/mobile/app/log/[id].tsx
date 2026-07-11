import { type ReactNode } from "react";
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

// The labelled Found date (the Found Rule, VOICE.md): the finding's log page is
// where the Found date carries its label. Mirrors the feed card's "Found Jul 8".
function foundLabel(iso: string): string {
  const d = new Date(iso);
  return `Found ${d.toLocaleDateString("en-US", { day: "numeric", month: "short" })}`;
}

export default function LogScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { data: resolution, isLoading } = useFinding((id ?? "").toUpperCase());
  const finding = resolution?.kind === "finding" ? resolution.finding : undefined;

  // The archive row's meta idiom (finding-row.tsx): a quiet middot-joined line,
  // each segment present only when the finding carries it (key can be null — then
  // it simply says nothing). The BPM value rides font.numeric for tabular figures
  // (the Tabular Rule), the coordinate's own numeral treatment.
  const metaParts: ReactNode[] = [];
  if (finding) {
    if (finding.bpm != null) {
      metaParts.push(
        <Text key="bpm">
          <Text style={font.numeric}>{Math.round(finding.bpm)}</Text> BPM
        </Text>,
      );
    }
    if (finding.key) {
      metaParts.push(<Text key="key">{finding.key}</Text>);
    }
    if (finding.galaxy?.name) {
      metaParts.push(<Text key="galaxy">{finding.galaxy.name}</Text>);
    }
  }

  return (
    <View style={{ flex: 1 }}>
      <CosmosBackdrop />
      <SafeAreaView style={{ flex: 1 }}>
        <Pressable
          accessibilityRole="button"
          hitSlop={8}
          onPress={() => router.back()}
          style={{ padding: 16 }}
        >
          <Text style={[font.label, { color: color.stardust }]}>Close</Text>
        </Pressable>
        {finding ? (
          // The reachable bottom owns the one action (thumb-zone); the cover stays
          // the hero and the meta carries the middle (cover-led, One Sun).
          <View style={{ flex: 1 }}>
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
              <Text style={[font.title, { color: color.starlightCream }]}>
                {finding.artists.join(", ")} — {finding.title}
              </Text>
              {metaParts.length ? (
                <Text style={[font.body, { color: color.stardust }]}>
                  {metaParts.flatMap((part, i) =>
                    i > 0 ? [<Text key={`sep-${i}`}>{"  ·  "}</Text>, part] : [part],
                  )}
                </Text>
              ) : null}
              {finding.addedAt ? (
                <Text style={[font.body, { color: color.stardust }]}>
                  {foundLabel(finding.addedAt)}
                </Text>
              ) : null}
              {finding.note ? (
                <Text style={[font.body, { color: color.stardust }]}>{finding.note}</Text>
              ) : null}
            </ScrollView>
            <View style={{ paddingBottom: 4, paddingHorizontal: 16, paddingTop: 12 }}>
              <HeatButton
                label="Listen on Spotify"
                onPress={() => Linking.openURL(finding.spotifyUrl)}
              />
            </View>
          </View>
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
