import { useCallback, useEffect, useState } from "react";
import {
  FlatList,
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
import { archiveCopy, archiveView } from "@/lib/archive-state";
import { openExternalUrl } from "@/lib/open-external-url";
import { type ReplicaFinding, useReplicaFindings } from "@/lib/replica";
import { type SavedFinding } from "@/lib/saved-store";
import { useSavedFindings } from "@/lib/saved";
import { partitionEntities, partitionTracks, searchView } from "@/lib/search-state";
import { color, font } from "@/theme/tokens";

type Browse = { kind: "all" } | { kind: "saved" };

export default function ArchiveScreen() {
  const router = useRouter();
  const {
    data,
    fetchNextPage,
    hasNextPage,
    isError,
    isFetchingNextPage,
    isPaused,
    isPending,
    isRefetching,
    refetch,
  } = useFindingsFeed();
  const all = flattenFeed(data?.pages);

  const [browse, setBrowse] = useState<Browse>({ kind: "all" });
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), 180);
    return () => clearTimeout(timer);
  }, [query]);

  const saved = useSavedFindings();

  const shown = all;

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

  const view = archiveView({ count: shown.length, isError, isPaused, isPending });

  const replica = useReplicaFindings(view === "offline");

  return (
    <View style={{ flex: 1 }}>
      <CosmosBackdrop />
      <SafeAreaView style={{ flex: 1 }} edges={["top"]}>
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
                  <AccountIconButton onPress={() => router.push("/account")} />
                  <HeaderPill label="Submit a track" onPress={() => router.push("/submit")} />
                </View>
              </View>

              <View style={styles.chipRow}>
                <FilterChip
                  label="All"
                  active={browse.kind === "all"}
                  onPress={() => setBrowse({ kind: "all" })}
                />
                <FilterChip
                  label="Saved"
                  active={browse.kind === "saved"}
                  onPress={() => setBrowse({ kind: "saved" })}
                />
              </View>
            </>
          )}
        </View>

        {searching ? (
          <SearchResults query={debounced} onPickHit={(hit) => pickHit(hit, router)} />
        ) : browse.kind === "saved" ? (
          <SavedList list={saved.list} ready={saved.ready} renderItem={renderSaved} />
        ) : view === "offline" ? (
          !replica.ready ? (
            <LoadingRows count={7} />
          ) : replica.findings.length > 0 ? (
            <ReplicaList findings={replica.findings} onOpen={(id) => router.push(`/log/${id}`)} />
          ) : (
            <ArchiveOffline />
          )
        ) : view === "loading" ? (
          <LoadingRows count={7} />
        ) : view === "error" ? (
          <ArchiveError onRetry={() => void refetch()} />
        ) : (
          <FlatList
            data={shown}
            keyExtractor={(f) => f.logId ?? f.trackId}
            renderItem={renderItem}

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
              <Text style={[font.body, styles.emptyText]}>
                No findings logged yet. Quiet sector tonight.
              </Text>
            }
          />
        )}
      </SafeAreaView>
    </View>
  );
}

function pickHit(hit: SearchHit, router: ReturnType<typeof useRouter>): void {
  if (hit.certified && hit.logId) {
    router.push(`/log/${hit.logId}`);
    return;
  }
  if (hit.spotifyUrl) {
    openExternalUrl(hit.spotifyUrl);
  }
}

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
  const entityGroups = partitionEntities(entities);
  const trackGroups = partitionTracks(results);

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
          Reading by name only right now. These are the closest words I&apos;ve got.
        </Text>
      ) : null}
      {entityGroups.map((group) => (
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
      {trackGroups.map((group) => (
        <View key={group.heading}>
          <Text style={[font.label, styles.groupHeading]}>{group.heading}</Text>
          {group.hits.map((hit, index) => (
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
              isLast={index === group.hits.length - 1}
              logId={hit.logId}
              musicalKey={hit.key}
              onPress={() => onPickHit(hit)}
              title={hit.title}
            />
          ))}
        </View>
      ))}
    </ScrollView>
  );
}

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

function ReplicaList({
  findings,
  onOpen,
}: {
  findings: ReplicaFinding[];
  onOpen: (logId: string) => void;
}) {
  return (
    <FlatList
      data={findings}
      keyExtractor={(finding) => finding.logId}
      renderItem={({ index, item }) => (
        <ArchiveRow
          accessibilityLabel={`Open the log page for ${item.artists.join(", ")} — ${item.title}`}
          albumImageUrl={item.albumImageUrl}
          artists={item.artists}
          bpm={item.bpm}
          certified
          isLast={index === findings.length - 1}
          logId={item.logId}
          musicalKey={item.key}
          onPress={() => onOpen(item.logId)}
          title={item.title}
        />
      )}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={styles.listContent}
    />
  );
}

function LoadingRows({ count }: { count: number }) {
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {Array.from({ length: count }, (_, i) => (
        <FindingRowSkeleton key={i} isLast={i === count - 1} />
      ))}
    </View>
  );
}

function ArchiveOffline() {
  return (
    <View style={styles.errorState}>
      <Text accessibilityLiveRegion="polite" style={[font.body, styles.errorText]}>
        {archiveCopy.offline}
      </Text>
    </View>
  );
}

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

function AccountIconButton({ onPress }: { onPress: () => void }) {
  return (
    <Pressable
      accessibilityLabel="Your account"
      accessibilityRole="button"
      hitSlop={{ bottom: 10, left: 10, right: 10, top: 10 }}
      onPress={onPress}
      style={{ padding: 6 }}
    >
      <Ionicons name="person-circle-outline" size={22} color={color.stardust} />
    </Pressable>
  );
}

function FilterChip({
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
  chipRow: {
    flexDirection: "row",
    gap: 8,
    paddingBottom: 16,
    paddingHorizontal: 16,
    paddingTop: 18,
  },
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
