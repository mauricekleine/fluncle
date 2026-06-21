import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { FlashList } from "@shopify/flash-list";
import { SafeAreaView } from "react-native-safe-area-context";
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
  const { data } = useFindingsFeed();
  const all = flattenFeed(data?.pages);
  const [galaxy, setGalaxy] = useState<Galaxy | null>(null);
  const shown = galaxy ? all.filter((f) => f.galaxy?.key === galaxy) : all;

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
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, padding: 16 }}>
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
        <FlashList
          data={shown}
          keyExtractor={(f) => f.logId ?? f.trackId}
          renderItem={({ item }) => <FindingRow finding={item} />}
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
