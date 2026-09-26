import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import { Image } from "expo-image";
import { type MixtapeDTO } from "@fluncle/contracts";
import { useMixtapes } from "@/api/hooks";
import { CosmosBackdrop } from "@/components/cosmos-backdrop";
import { HeatButton } from "@/components/heat-button";
import { mixtapeCoverUrl } from "@/lib/media";
import { openExternalUrl } from "@/lib/open-external-url";
import { color, font, radius } from "@/theme/tokens";

type Member = MixtapeDTO["members"][number];

const COPY = {
  loading: "Recovering the mixtape…",
  missing: "That mixtape isn't here.",
  tracklist: "Tracklist",
} as const;

function displayTitle(title: string): string {
  return title.split(" | ")[0] ?? title;
}

function metaLine(mixtape: MixtapeDTO): string {
  const bangers = `${mixtape.memberCount} bangers`;
  const minutes = mixtape.durationMs
    ? ` · ${Math.max(1, Math.round(mixtape.durationMs / 60_000))} min`
    : "";

  return `${bangers}${minutes}`;
}

export default function MixtapeScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { data: mixtapes, isPending } = useMixtapes();
  const mixtape = mixtapes?.find((m) => m.logId === id);

  return (
    <View style={styles.screen}>
      <CosmosBackdrop />
      <SafeAreaView style={{ flex: 1 }}>
        <Pressable
          accessibilityLabel="Close"
          accessibilityRole="button"
          hitSlop={{ bottom: 10, left: 10, right: 10, top: 10 }}
          onPress={() => router.back()}
          style={styles.close}
        >
          <Ionicons color={color.stardust} name="close" size={26} />
        </Pressable>

        {mixtape ? (
          <MixtapeDetail mixtape={mixtape} />
        ) : (
          <Text style={[font.body, styles.state]}>{isPending ? COPY.loading : COPY.missing}</Text>
        )}
      </SafeAreaView>
    </View>
  );
}

function MixtapeDetail({ mixtape }: { mixtape: MixtapeDTO }) {
  const { mixcloud, youtube } = mixtape.externalUrls;

  return (
    <View style={{ flex: 1 }}>
      <ScrollView contentContainerStyle={styles.body}>
        {mixtape.logId ? (
          <Text style={[font.numeric, styles.coordinate]}>{mixtape.logId}</Text>
        ) : null}

        {mixtape.logId ? (
          <Image
            contentFit="cover"
            source={mixtapeCoverUrl(mixtape.logId, "square")}
            style={styles.cover}
            transition={250}
          />
        ) : null}

        <Text style={[font.title, styles.title]}>{displayTitle(mixtape.title)}</Text>
        <Text style={[font.body, styles.meta]}>{metaLine(mixtape)}</Text>

        {mixtape.note ? <Text style={[font.body, styles.note]}>{mixtape.note}</Text> : null}

        {mixtape.members.length ? (
          <View style={styles.tracklist}>
            <Text style={[font.label, styles.tracklistHeading]}>{COPY.tracklist}</Text>
            {mixtape.members.map((member, index) => (
              <TrackRow key={member.logId ?? member.trackId ?? String(index)} member={member} />
            ))}
          </View>
        ) : null}
      </ScrollView>

      {youtube || mixcloud ? (
        <View style={styles.actions}>
          {youtube ? (
            <View style={styles.action}>
              <HeatButton
                icon={<MaterialCommunityIcons color={color.inkOnGold} name="youtube" size={18} />}
                label="Watch on YouTube"
                onPress={() => openExternalUrl(youtube)}
              />
            </View>
          ) : null}
          {mixcloud ? (
            <View style={styles.action}>
              <HeatButton
                icon={<Ionicons color={color.starlightCream} name="musical-notes" size={16} />}
                label="Listen on Mixcloud"
                onPress={() => openExternalUrl(mixcloud)}
                variant="outline"
              />
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function TrackRow({ member }: { member: Member }) {
  return (
    <View style={styles.trackRow}>
      {member.logId ? (
        <Text style={[font.numeric, styles.trackId]}>{member.logId}</Text>
      ) : (
        <Text style={[font.numeric, styles.trackId]}> </Text>
      )}
      <Text numberOfLines={2} style={[font.body, styles.trackLine]}>
        {member.artists.join(", ")} — {member.title}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  action: { flex: 1 },
  actions: {
    flexDirection: "row",
    gap: 10,
    paddingBottom: 4,
    paddingHorizontal: 16,
    paddingTop: 12,
  },
  body: { gap: 12, padding: 16 },
  close: { alignSelf: "flex-end", padding: 16 },
  coordinate: { color: color.eclipseGlow, fontSize: 15 },
  cover: { aspectRatio: 1, borderRadius: radius.lg, width: "100%" },
  meta: { color: color.stardust },
  note: { color: color.stardust },
  screen: { backgroundColor: color.deepField, flex: 1 },
  state: { color: color.stardust, padding: 16 },
  title: { color: color.starlightCream },
  trackId: { color: color.eclipseGold, fontSize: 12, minWidth: 58 },
  trackLine: { color: color.starlightCream, flex: 1 },
  trackRow: { alignItems: "baseline", flexDirection: "row", gap: 10 },
  tracklist: { gap: 10, marginTop: 8 },
  tracklistHeading: {
    color: color.stardust,
    fontSize: 12,
    letterSpacing: 0.5,
    textTransform: "uppercase",
  },
});
