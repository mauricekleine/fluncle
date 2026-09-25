import { FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { Image } from "expo-image";
import { type MixtapeDTO } from "@fluncle/contracts";
import { useMixtapes } from "@/api/hooks";
import { CosmosBackdrop } from "@/components/cosmos-backdrop";
import { mixtapeCoverUrl } from "@/lib/media";
import { color, font, radius } from "@/theme/tokens";

const COPY = {
  empty: "No mixtapes logged yet. Quiet deck tonight.",
  error: "Couldn't reach the mixtapes. Pull to try again.",
  intro: "Checkpoints from the archive: I mix the findings into one long dream.",
  loading: "Recovering the mixtapes…",
  title: "Mixtapes",
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

export default function MixtapesScreen() {
  const { data: mixtapes, isError, isPending, isRefetching, refetch } = useMixtapes();
  const router = useRouter();

  return (
    <View style={styles.screen}>
      <CosmosBackdrop />
      <FlatList
        contentContainerStyle={styles.list}
        data={mixtapes}
        keyExtractor={(m) => m.logId ?? m.title}
        ListHeaderComponent={
          <View style={styles.header}>
            <Text style={[font.label, styles.nameplate]}>{"Fluncle's Findings"}</Text>
            <Text style={[font.display, styles.title]}>{COPY.title}</Text>
            <Text style={[font.body, styles.intro]}>{COPY.intro}</Text>
          </View>
        }
        ListEmptyComponent={
          <Text style={[font.body, styles.state]}>
            {isPending ? COPY.loading : isError ? COPY.error : COPY.empty}
          </Text>
        }
        onRefresh={() => void refetch()}
        refreshing={isRefetching}
        renderItem={({ item }) => (
          <MixtapeRow
            mixtape={item}
            onPress={() => item.logId && router.push(`/mixtape/${encodeURIComponent(item.logId)}`)}
          />
        )}
      />
    </View>
  );
}

function MixtapeRow({ mixtape, onPress }: { mixtape: MixtapeDTO; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress}>
      {({ pressed }) => (
        <View style={[styles.row, pressed ? styles.rowPressed : null]}>
          {mixtape.logId ? (
            <Image
              contentFit="cover"
              source={mixtapeCoverUrl(mixtape.logId, "thumb")}
              style={styles.cover}
              transition={200}
            />
          ) : (
            <View style={[styles.cover, styles.coverEmpty]} />
          )}
          <View style={styles.rowBody}>
            {mixtape.logId ? (
              <Text style={[font.numeric, styles.rowId, pressed ? styles.rowIdHot : null]}>
                {mixtape.logId}
              </Text>
            ) : null}
            <Text numberOfLines={2} style={[font.title, styles.rowTitle]}>
              {displayTitle(mixtape.title)}
            </Text>
            <Text style={[font.body, styles.rowMeta]}>{metaLine(mixtape)}</Text>
          </View>
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  cover: {
    borderRadius: radius.md,
    height: 72,
    width: 72,
  },
  coverEmpty: { backgroundColor: color.tapeBlack },

  header: { gap: 8, marginBottom: 8, paddingHorizontal: 10 },
  intro: { color: color.stardust, maxWidth: 340 },
  list: { gap: 4, padding: 10, paddingTop: 72 },
  nameplate: { color: color.stardust, fontSize: 12, letterSpacing: 0.5 },

  row: {
    alignItems: "center",
    borderRadius: radius.md,
    flexDirection: "row",
    gap: 14,
    paddingHorizontal: 10,
    paddingVertical: 10,
  },
  rowBody: { flex: 1, gap: 3 },
  rowId: { color: color.eclipseGold, fontSize: 13 },

  rowIdHot: { color: color.eclipseGlow },
  rowMeta: { color: color.stardust, fontSize: 13 },
  rowPressed: { backgroundColor: color.goldVeil },
  rowTitle: { color: color.starlightCream },
  screen: { backgroundColor: color.deepField, flex: 1 },
  state: { color: color.stardust, paddingHorizontal: 10, paddingVertical: 24, textAlign: "center" },
  title: { color: color.starlightCream, fontSize: 30 },
});
