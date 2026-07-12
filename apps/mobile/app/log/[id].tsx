import { type ReactNode } from "react";
import { Linking, Pressable, ScrollView, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { Image } from "expo-image";
import { useFinding } from "@/api/hooks";
import { CosmosBackdrop } from "@/components/cosmos-backdrop";
import { HeatButton } from "@/components/heat-button";
import { SaveButton } from "@/components/save-button";
import { type SavableFinding } from "@/lib/saved-store";
import { useSavedFindings } from "@/lib/saved";
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

  // Device-local saves (the ungated variant): the bookmark stores a snapshot of the
  // finding so the Saved view renders it even if the archive later moves. Only a
  // finding can be saved — a mixtape lives on the web, and a dead coordinate is nothing
  // to hold onto.
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
        {/* The top chrome: the save toggle on the left (only where there is a finding
            to hold onto), the shared dismiss on the right. The X is a quiet stardust
            X — no gold (a dismiss is not a sun); the bookmark is the one control here
            that lights gold, when saved. Both carry their literal in an a11y label
            (the Chrome Rule); padding + hitSlop lift each target past the 44pt floor. */}
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
            <View style={{ gap: 8, paddingBottom: 4, paddingHorizontal: 16, paddingTop: 12 }}>
              <HeatButton
                label="Listen on Spotify"
                onPress={() => Linking.openURL(finding.spotifyUrl)}
              />
              {/* The second listen destination, present only once the exact-ISRC resolve
                  landed one. Outline (Spotify stays the single primary), text-only — the
                  Apple Music brand mark waits on the parked brand-icon dependency (a text
                  label breaks no icon idiom), so this is detail-screen-only for now. */}
              {finding.appleMusicUrl ? (
                <HeatButton
                  label="Listen on Apple Music"
                  variant="outline"
                  onPress={() => finding.appleMusicUrl && Linking.openURL(finding.appleMusicUrl)}
                />
              ) : null}
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
