import { useCallback, useEffect, useState } from "react";
import {
  FlatList,
  type ListRenderItem,
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  View,
} from "react-native";
import { useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { flattenFeed, useFindingsFeed } from "@/api/hooks";
import { FindingRow, FindingRowSkeleton } from "@/components/finding-row";
import { CosmosBackdrop } from "@/components/cosmos-backdrop";
import { archiveView } from "@/lib/archive-state";
import { color, font } from "@/theme/tokens";

// The archive (RFC Unit 3): browse + the sonic-galaxy lens (browse-by-feel RFC). No
// search box (a DESIGN.md anti-reference). The lens is DATA-DRIVEN off the real,
// operator-named galaxies present in the loaded findings — it filters client-side by
// galaxy slug (before any galaxy is named, only "All" shows). The full public lens is
// a later slice.
export default function ArchiveScreen() {
  const router = useRouter();
  const {
    data,
    fetchNextPage,
    hasNextPage,
    isError,
    isFetchingNextPage,
    isPending,
    isRefetching,
    refetch,
  } = useFindingsFeed();
  const all = flattenFeed(data?.pages);
  const [activeSlug, setActiveSlug] = useState<string | null>(null);
  const shown = activeSlug ? all.filter((f) => f.galaxy?.slug === activeSlug) : all;

  // The distinct named galaxies present in the loaded findings, in first-seen order —
  // the chip list. Empty until the operator names the map (then only "All" renders).
  const presentGalaxies: Array<{ name: string; slug: string }> = [];
  const seenSlugs = new Set<string>();
  for (const finding of all) {
    const found = finding.galaxy;
    if (found && !seenSlugs.has(found.slug)) {
      seenSlugs.add(found.slug);
      presentGalaxies.push(found);
    }
  }

  // The galaxy lens filters client-side over loaded pages, so a sparse galaxy can look
  // empty while its findings sit unloaded further down the feed. While a filter is
  // active and the filtered list is still short, keep draining pages so the lens never
  // renders a false "quiet sector" before the feed is exhausted (P4).
  const draining = hasNextPage || isFetchingNextPage;
  useEffect(() => {
    if (activeSlug && shown.length < 8 && hasNextPage && !isFetchingNextPage) {
      void fetchNextPage();
    }
  }, [activeSlug, shown.length, hasNextPage, isFetchingNextPage, fetchNextPage]);

  // Stable renderItem so the list bails out of rebuilding every visible row on
  // each screen redraw; only re-created when the row count (last-row flag) shifts.
  const renderItem = useCallback<ListRenderItem<(typeof shown)[number]>>(
    ({ index, item }) => <FindingRow finding={item} isLast={index === shown.length - 1} />,
    [shown.length],
  );

  const view = archiveView({ count: shown.length, isError, isPending });

  return (
    <View style={{ flex: 1 }}>
      <CosmosBackdrop />
      <SafeAreaView style={{ flex: 1 }} edges={["top"]}>
        {/* Header + lens ride an opaque warm-dark pane so the list scrolls BENEATH
            chrome, never a raw cut over the cosmos (The Legible Sky Rule / H2). */}
        <View style={styles.pane}>
          <View style={styles.header}>
            <Text style={[font.display, { color: color.starlightCream, fontSize: 22 }]}>
              The archive
            </Text>
            <View style={{ alignItems: "center", flexDirection: "row", gap: 8 }}>
              <HeaderPill label="Submit a track" onPress={() => router.push("/submit")} />
            </View>
          </View>
          {/* One horizontal line forever — the lens never wraps to a second row (P5). */}
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentInsetAdjustmentBehavior="never"
            contentContainerStyle={styles.chipRow}
          >
            <GalaxyChip
              label="All"
              active={activeSlug === null}
              onPress={() => setActiveSlug(null)}
            />
            {presentGalaxies.map((g) => (
              <GalaxyChip
                key={g.slug}
                label={g.name}
                active={activeSlug === g.slug}
                onPress={() => setActiveSlug(g.slug)}
              />
            ))}
          </ScrollView>
        </View>

        {view === "loading" ? (
          <LoadingRows count={7} />
        ) : view === "error" ? (
          <ArchiveError onRetry={() => void refetch()} />
        ) : (
          <FlatList
            data={shown}
            keyExtractor={(f) => f.logId ?? f.trackId}
            renderItem={renderItem}
            // iOS NativeTabs floats a pill over the content; the sanctioned clearance is
            // the native scroll-edge adjustment — let iOS inset this (the first vertical
            // scroll view) by the real tab-bar height, then add ~20pt breathing room. A
            // hardcoded guess buried the tail under the pill (B1).
            contentInsetAdjustmentBehavior="automatic"
            contentContainerStyle={styles.listContent}
            refreshControl={
              <RefreshControl
                refreshing={isRefetching}
                onRefresh={() => void refetch()}
                tintColor={color.stardust}
                colors={[color.stardust]}
              />
            }
            onEndReached={() => {
              if (hasNextPage && !isFetchingNextPage) {
                void fetchNextPage();
              }
            }}
            onEndReachedThreshold={0.5}
            ListFooterComponent={isFetchingNextPage ? <FindingRowSkeleton isLast /> : null}
            ListEmptyComponent={
              // A filter still draining pages shows quiet skeletons, not the sector line,
              // so a sparse galaxy never flashes a false empty state (P4). Only a settled,
              // genuinely empty result reads "Quiet sector."
              draining ? (
                <LoadingRows count={4} />
              ) : (
                <Text style={[font.body, styles.emptyText]}>
                  No findings logged in this galaxy yet. Quiet sector.
                </Text>
              )
            }
          />
        )}
      </SafeAreaView>
    </View>
  );
}

// The loading state (B2) and the drain state (P4): a quiet column of placeholder rows —
// artwork square + two text bars in the Dust Veil tone, no spinner.
function LoadingRows({ count }: { count: number }) {
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {Array.from({ length: count }, (_, i) => (
        <FindingRowSkeleton key={i} isLast={i === count - 1} />
      ))}
    </View>
  );
}

// The honest network-failure state (B2): plain prose (the written voice — no em dash,
// no exclamation) plus a literal "Try again" control (the Chrome Rule) wired to refetch.
function ArchiveError({ onRetry }: { onRetry: () => void }) {
  return (
    <View style={styles.errorState}>
      <Text style={[font.body, styles.errorText]}>
        The archive didn't load. Check your connection.
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Try again"
        onPress={onRetry}
        hitSlop={8}
        style={styles.retryButton}
      >
        <Text style={[font.label, { color: color.stardust }]}>Try again</Text>
      </Pressable>
    </View>
  );
}

// A header action pill (the quiet outline the notifications entry used). Two now
// sits in the archive header: "Submit a track" (the ratified functional label; the Chrome Rule
// keeps controls literal). The push-consent screen at /notifications is reached contextually,
// not from permanent chrome — its test pill was removed 2026-07-11.
function HeaderPill({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      hitSlop={8}
      style={{
        borderColor: color.dustLine,
        borderRadius: 8,
        borderWidth: 1,
        paddingHorizontal: 12,
        paddingVertical: 6,
      }}
    >
      <Text style={[font.label, { color: color.stardust }]}>{label}</Text>
    </Pressable>
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
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      onPress={onPress}
      // The chip is ~29pt tall; the vertical hitSlop lifts the effective target past
      // the 44pt floor without changing the visual size (H4).
      hitSlop={{ bottom: 8, left: 4, right: 4, top: 8 }}
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

const styles = {
  chipRow: { gap: 8, paddingBottom: 16, paddingHorizontal: 16, paddingTop: 18 },
  emptyText: { color: color.stardust, padding: 16 },
  errorState: { alignItems: "center", gap: 16, paddingHorizontal: 16, paddingTop: 40 },
  errorText: { color: color.stardust, textAlign: "center" },
  header: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  listContent: { paddingBottom: 20, paddingTop: 6 },
  pane: {
    backgroundColor: color.deepField,
    borderBottomColor: color.dustLine,
    borderBottomWidth: 1,
  },
  retryButton: {
    borderColor: color.dustLine,
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
} as const;
