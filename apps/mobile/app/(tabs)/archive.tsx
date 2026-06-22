import { useCallback, useState } from "react";
import { FlatList, type ListRenderItem, Pressable, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { type Galaxy } from "@fluncle/contracts";
import { flattenFeed, useFindingsFeed } from "@/api/hooks";
import { FindingRow } from "@/components/finding-row";
import { CosmosBackdrop } from "@/components/cosmos-backdrop";
import { color, font, galaxies } from "@/theme/tokens";

// The archive (RFC Unit 3): browse + the four-galaxy lens. No search box (a
// DESIGN.md anti-reference). Phase 0 filters client-side over loaded findings;
// Phase 1 adds the server-side galaxy= param.
export default function ArchiveScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { data, fetchNextPage, hasNextPage, isFetchingNextPage } = useFindingsFeed();
  const all = flattenFeed(data?.pages);
  const [galaxy, setGalaxy] = useState<Galaxy | null>(null);
  const shown = galaxy ? all.filter((f) => f.galaxy?.key === galaxy) : all;

  // Stable renderItem so the list bails out of rebuilding every visible row on
  // each screen redraw; only re-created when the row count (last-row flag) shifts.
  const renderItem = useCallback<ListRenderItem<(typeof shown)[number]>>(
    ({ index, item }) => <FindingRow finding={item} isLast={index === shown.length - 1} />,
    [shown.length],
  );

  return (
    <View style={{ flex: 1 }}>
      <CosmosBackdrop />
      <SafeAreaView style={{ flex: 1 }} edges={["top"]}>
        <View
          style={{
            alignItems: "center",
            flexDirection: "row",
            justifyContent: "space-between",
            paddingHorizontal: 16,
            paddingTop: 8,
          }}
        >
          <Text style={[font.display, { color: color.starlightCream, fontSize: 22 }]}>
            The archive
          </Text>
          <Pressable
            onPress={() => router.push("/notifications")}
            hitSlop={8}
            style={{
              borderColor: color.dustLine,
              borderRadius: 8,
              borderWidth: 1,
              paddingHorizontal: 12,
              paddingVertical: 6,
            }}
          >
            <Text style={[font.label, { color: color.stardust }]}>Pings</Text>
          </Pressable>
        </View>
        <View
          style={{
            flexDirection: "row",
            flexWrap: "wrap",
            gap: 8,
            paddingBottom: 16,
            paddingHorizontal: 16,
            paddingTop: 18,
          }}
        >
          <GalaxyChip label="All" active={galaxy === null} onPress={() => setGalaxy(null)} />
          {galaxies.map((g) => (
            <GalaxyChip
              key={g.key}
              label={g.name}
              active={galaxy === g.key}
              onPress={() => setGalaxy(g.key)}
            />
          ))}
        </View>
        <FlatList
          data={shown}
          keyExtractor={(f) => f.logId ?? f.trackId}
          renderItem={renderItem}
          contentContainerStyle={{ paddingBottom: insets.bottom + 20 }}
          onEndReached={() => {
            if (hasNextPage && !isFetchingNextPage) {
              fetchNextPage();
            }
          }}
          onEndReachedThreshold={0.5}
          ListEmptyComponent={
            <Text style={[font.body, { color: color.stardust, padding: 16 }]}>
              No findings logged in this galaxy yet. Quiet sector.
            </Text>
          }
        />
      </SafeAreaView>
    </View>
  );
}

function GalaxyChip({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={{
        backgroundColor: active ? color.goldVeil : "transparent",
        borderColor: active ? color.eclipseGold : color.dustLine,
        borderRadius: 8,
        borderWidth: 1,
        paddingHorizontal: 12,
        paddingVertical: 6,
      }}
    >
      <Text style={[font.label, { color: active ? color.eclipseGlow : color.stardust }]}>
        {label}
      </Text>
    </Pressable>
  );
}
