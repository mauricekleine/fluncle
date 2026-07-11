import { useCallback, useEffect, useState } from "react";
import {
  FlatList,
  Linking,
  type ListRenderItem,
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { type SearchHit } from "@fluncle/contracts/orpc";
import { flattenFeed, useArchiveSearch, useFindingsFeed } from "@/api/hooks";
import { FindingRow, FindingRowSkeleton } from "@/components/finding-row";
import { ArchiveRow } from "@/components/archive-row";
import { EntityRow } from "@/components/entity-row";
import { CosmosBackdrop } from "@/components/cosmos-backdrop";
import { archiveView } from "@/lib/archive-state";
import { type SavedFinding } from "@/lib/saved-store";
import { useSavedFindings } from "@/lib/saved";
import { partitionEntities, searchView } from "@/lib/search-state";
import { color, font } from "@/theme/tokens";

// The archive (RFC Unit 3): browse + the sonic-galaxy lens (browse-by-feel RFC) +
// SEARCH (the catalogue sprint's public `search_archive` op) + a device-local Saved
// view. The lens is DATA-DRIVEN off the real, operator-named galaxies present in the
// loaded findings — it filters client-side by galaxy slug (before any galaxy is named,
// only "All" shows). Search is a quiet magnifier in the header, mirroring the web
// palette's stance: the quietest surface doesn't get a permanent form field, it gets a
// glyph that opens one. Searching REPLACES the browse list; closing it restores the
// lens exactly where it was.

/** What the browse list is filtered to when NOT searching. */
type Browse = { kind: "all" } | { kind: "galaxy"; slug: string } | { kind: "saved" };

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

  const [browse, setBrowse] = useState<Browse>({ kind: "all" });
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");

  // A keystroke is not a query. The debounce (matching the web palette) keeps a typed
  // word from firing a round trip per character on its way to being one.
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), 180);
    return () => clearTimeout(timer);
  }, [query]);

  const saved = useSavedFindings();

  const activeSlug = browse.kind === "galaxy" ? browse.slug : null;
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

  const renderSaved = useCallback<ListRenderItem<SavedFinding>>(
    ({ index, item }) => (
      <ArchiveRow
        accessibilityLabel={`Open the log page for ${item.artists.join(", ")} — ${item.title}`}
        albumImageUrl={item.albumImageUrl}
        artists={item.artists}
        bpm={item.bpm}
        certified
        galaxyName={item.galaxyName}
        isLast={index === saved.list.length - 1}
        logId={item.logId}
        musicalKey={item.key}
        onPress={() => router.push(`/log/${item.logId ?? item.trackId}`)}
        title={item.title}
      />
    ),
    [router, saved.list.length],
  );

  const closeSearch = useCallback(() => {
    setSearching(false);
    setQuery("");
    setDebounced("");
  }, []);

  const view = archiveView({ count: shown.length, isError, isPending });

  return (
    <View style={{ flex: 1 }}>
      <CosmosBackdrop />
      <SafeAreaView style={{ flex: 1 }} edges={["top"]}>
        {/* Header + lens sit transparently on the cosmos gradient so it flows unbroken
            from the top of the screen down through the list — no separate pane band
            (the operator's ruling). The header is a flex block above the list (not an
            overlay), so rows still rest below the chips; nothing scrolls under it. */}
        <View>
          {searching ? (
            <SearchField query={query} onChangeQuery={setQuery} onClose={closeSearch} />
          ) : (
            <>
              <View style={styles.header}>
                <Text style={[font.display, { color: color.starlightCream, fontSize: 22 }]}>
                  The archive
                </Text>
                <View style={{ alignItems: "center", flexDirection: "row", gap: 8 }}>
                  <SearchIconButton onPress={() => setSearching(true)} />
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
                  active={browse.kind === "all"}
                  onPress={() => setBrowse({ kind: "all" })}
                />
                <GalaxyChip
                  label="Saved"
                  active={browse.kind === "saved"}
                  onPress={() => setBrowse({ kind: "saved" })}
                />
                {presentGalaxies.map((g) => (
                  <GalaxyChip
                    key={g.slug}
                    label={g.name}
                    active={activeSlug === g.slug}
                    onPress={() => setBrowse({ kind: "galaxy", slug: g.slug })}
                  />
                ))}
              </ScrollView>
            </>
          )}
        </View>

        {searching ? (
          <SearchResults query={debounced} onPickHit={(hit) => pickHit(hit, router)} />
        ) : browse.kind === "saved" ? (
          <SavedList list={saved.list} ready={saved.ready} renderItem={renderSaved} />
        ) : view === "loading" ? (
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

// A certified finding taps through to its coordinate (the detail modal). A track
// Fluncle never certified has no /log page, so it links OUT to Spotify — the Unlit
// Rule the search rows already render.
function pickHit(hit: SearchHit, router: ReturnType<typeof useRouter>): void {
  if (hit.certified && hit.logId) {
    router.push(`/log/${hit.logId}`);
    return;
  }
  if (hit.spotifyUrl) {
    void Linking.openURL(hit.spotifyUrl);
  }
}

// The search pane: one `search_archive` op behind a debounced query, rendered in the
// archive row idiom. Entities (artist/label/album) are jump targets grouped by kind and
// opened on the web (the app has no such page); tracks follow in the certified/unlit
// register. Empty/error states are honest and voiced; the two notes (sonic anchor,
// degraded fallback) mirror the web palette's ratified lines.
function SearchResults({
  onPickHit,
  query,
}: {
  onPickHit: (hit: SearchHit) => void;
  query: string;
}) {
  const { data, isError, isFetching } = useArchiveSearch(query);
  const results = data?.results ?? [];
  const entities = data?.entities ?? [];
  const hasResults = results.length > 0 || entities.length > 0;
  const state = searchView({ hasResults, isError, isFetching, query });
  const groups = partitionEntities(entities);

  if (state === "idle" || state === "tooShort") {
    return <View style={{ flex: 1 }} />;
  }
  if (state === "loading") {
    return <LoadingRows count={6} />;
  }
  if (state === "error") {
    return (
      <View style={styles.errorState}>
        <Text style={[font.body, styles.errorText]}>
          Search didn&apos;t run. Check your connection.
        </Text>
      </View>
    );
  }
  if (state === "empty") {
    return (
      <Text style={[font.body, styles.emptyText]}>
        {data?.kind === "coordinate" ? "No finding at that coordinate." : "Nothing out here."}
      </Text>
    );
  }

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={styles.listContent}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
    >
      {data?.anchor ? (
        <Text style={[font.body, styles.note]}>
          Near {data.anchor.title}
          {data.anchor.artists.length > 0 ? ` — ${data.anchor.artists.join(", ")}` : ""}
        </Text>
      ) : null}
      {data?.degraded ? (
        <Text style={[font.body, styles.note]}>
          Reading by name only right now — showing the closest words.
        </Text>
      ) : null}
      {groups.map((group) => (
        <View key={group.kind}>
          <Text style={[font.label, styles.groupHeading]}>{group.heading}</Text>
          {group.entities.map((entity, index) => (
            <EntityRow
              key={`${entity.kind}-${entity.slug}`}
              entity={entity}
              isLast={index === group.entities.length - 1}
            />
          ))}
        </View>
      ))}
      {results.map((hit, index) => (
        <ArchiveRow
          key={hit.trackId}
          accessibilityLabel={
            hit.certified && hit.logId
              ? `Open the log page for ${hit.artists.join(", ")} — ${hit.title}`
              : `Open ${hit.artists.join(", ")} — ${hit.title} on Spotify`
          }
          albumImageUrl={hit.albumImageUrl}
          artists={hit.artists}
          bpm={hit.bpm}
          certified={hit.certified}
          galaxyName={hit.galaxy}
          isLast={index === results.length - 1}
          logId={hit.logId}
          musicalKey={hit.key}
          onPress={() => onPickHit(hit)}
          title={hit.title}
        />
      ))}
    </ScrollView>
  );
}

// The device-local Saved view. Rows render from the stored snapshot, so a saved
// finding shows even if the archive later moves — and a coordinate that no longer
// resolves lands on the detail screen's honest "Finding not found." when tapped.
function SavedList({
  list,
  ready,
  renderItem,
}: {
  list: SavedFinding[];
  ready: boolean;
  renderItem: ListRenderItem<SavedFinding>;
}) {
  if (!ready) {
    return <LoadingRows count={4} />;
  }
  return (
    <FlatList
      data={list}
      keyExtractor={(f) => f.logId ?? f.trackId}
      renderItem={renderItem}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={styles.listContent}
      ListEmptyComponent={
        <Text style={[font.body, styles.emptyText]}>
          Nothing saved yet. Tap the bookmark on a finding to keep it here.
        </Text>
      }
    />
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
        The archive didn&apos;t load. Check your connection.
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

// The search field that replaces the header title while searching: a bordered outline
// input carrying the ratified web placeholder, and a quiet X to close (which restores
// the browse list). Icon-only chrome carries its literal in the a11y label.
function SearchField({
  onChangeQuery,
  onClose,
  query,
}: {
  onChangeQuery: (next: string) => void;
  onClose: () => void;
  query: string;
}) {
  return (
    <View style={styles.searchRow}>
      <View style={styles.searchField}>
        <Ionicons name="search" size={16} color={color.stardust} />
        <TextInput
          accessibilityLabel="Search the archive"
          autoCapitalize="none"
          autoCorrect={false}
          autoFocus
          onChangeText={onChangeQuery}
          placeholder="A name, a coordinate, or the sound of it…"
          placeholderTextColor={color.stardust}
          returnKeyType="search"
          style={styles.searchInput}
          value={query}
        />
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Close search"
        hitSlop={{ bottom: 10, left: 10, right: 10, top: 10 }}
        onPress={onClose}
        style={{ padding: 4 }}
      >
        <Ionicons name="close" size={24} color={color.stardust} />
      </Pressable>
    </View>
  );
}

// A header action pill (the quiet outline the notifications entry used): "Submit a
// track" (the ratified functional label; the Chrome Rule keeps controls literal).
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

// The quiet magnifier that opens search — a glyph, not a field, in the quietest
// surface (the web palette's stance). The padding + hitSlop lift it past the 44pt floor.
function SearchIconButton({ onPress }: { onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Search the archive"
      hitSlop={{ bottom: 10, left: 10, right: 10, top: 10 }}
      onPress={onPress}
      style={{ padding: 6 }}
    >
      <Ionicons name="search" size={20} color={color.stardust} />
    </Pressable>
  );
}

function GalaxyChip({
  active,
  label,
  onPress,
}: {
  active: boolean;
  label: string;
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
  groupHeading: {
    color: color.stardust,
    paddingBottom: 4,
    paddingHorizontal: 16,
    paddingTop: 14,
  },
  header: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  listContent: { paddingBottom: 20, paddingTop: 6 },
  note: { color: color.stardust, paddingHorizontal: 16, paddingTop: 12 },
  retryButton: {
    borderColor: color.dustLine,
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  searchField: {
    alignItems: "center",
    backgroundColor: color.tapeBlackFill,
    borderColor: color.dustLine,
    borderRadius: 8,
    borderWidth: 1,
    flex: 1,
    flexDirection: "row",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  searchInput: {
    color: color.starlightCream,
    flex: 1,
    fontFamily: font.body.fontFamily,
    padding: 0,
  },
  searchRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 8,
    paddingHorizontal: 16,
    paddingTop: 8,
  },
} as const;
