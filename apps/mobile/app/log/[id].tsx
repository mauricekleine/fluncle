import { type ReactNode } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { Image } from "expo-image";
import { useFinding } from "@/api/hooks";
import { CosmosBackdrop } from "@/components/cosmos-backdrop";
import { HeatButton } from "@/components/heat-button";
import { SaveButton } from "@/components/save-button";
import { openExternalUrl } from "@/lib/open-external-url";
import { type SavableFinding } from "@/lib/saved-store";
import { useSavedFindings } from "@/lib/saved";
import { color, font, radius } from "@/theme/tokens";

const MIXTAPE_WEB_BASE = "https://www.fluncle.com/log";

function foundLabel(iso: string): string {
  const d = new Date(iso);
  return `Found ${d.toLocaleDateString("en-US", { day: "numeric", month: "short" })}`;
}

export default function LogScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { data: resolution, isLoading } = useFinding((id ?? "").toUpperCase());
  const finding = resolution?.kind === "finding" ? resolution.finding : undefined;

  const { isSaved, toggle } = useSavedFindings();
  const savable: SavableFinding | undefined = finding
    ? {
        albumImageUrl: finding.albumImageUrl,
        artists: finding.artists,
        bpm: finding.bpm,
        galaxyName: finding.galaxy?.name,
        key: finding.key,
        logId: finding.logId,
        spotifyUrl: finding.spotifyUrl,
        title: finding.title,
        trackId: finding.trackId,
      }
    : undefined;
  const saved = savable ? isSaved(savable) : false;

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
        {}
        <View
          style={{
            alignItems: "center",
            flexDirection: "row",
            justifyContent: savable ? "space-between" : "flex-end",
          }}
        >
          {savable ? <SaveButton saved={saved} onPress={() => toggle(savable)} /> : null}
          <Pressable
            accessibilityLabel="Close"
            accessibilityRole="button"
            hitSlop={{ bottom: 10, left: 10, right: 10, top: 10 }}
            onPress={() => router.back()}
            style={{ padding: 16 }}
          >
            <Ionicons name="close" size={26} color={color.stardust} />
          </Pressable>
        </View>
        {finding ? (
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
            <View style={{ gap: 8, paddingBottom: 4, paddingHorizontal: 16, paddingTop: 12 }}>
              <HeatButton
                label="Listen on Spotify"
                onPress={() => openExternalUrl(finding.spotifyUrl)}
              />
              {}
              {finding.appleMusicUrl ? (
                <HeatButton
                  label="Listen on Apple Music"
                  variant="outline"
                  onPress={() => finding.appleMusicUrl && openExternalUrl(finding.appleMusicUrl)}
                />
              ) : null}
            </View>
          </View>
        ) : resolution?.kind === "mixtape" ? (
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
                  openExternalUrl(
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
