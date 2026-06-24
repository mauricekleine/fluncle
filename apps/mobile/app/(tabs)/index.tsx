import { useCallback, useMemo, useState } from "react";
import { View, useWindowDimensions } from "react-native";
import { FlashList, type ViewToken } from "@shopify/flash-list";
import { type TrackListItem } from "@fluncle/contracts";
import { flattenFeed, useFindingsFeed } from "@/api/hooks";
import { FeedCard } from "@/components/feed-card";
import { color } from "@/theme/tokens";

const idOf = (f: TrackListItem) => f.logId ?? f.trackId;

// The Stories feed (RFC Unit 2). FlashList v2 vertical pager, one cell per screen.
// KNOWN RISK (RFC): FlashList #1200 — verify one-card-per-swipe on a low-end
// Android device; FlatList pagingEnabled is the documented fallback.
export default function FeedScreen() {
  const { height } = useWindowDimensions();
  const { data, fetchNextPage, hasNextPage, isFetchingNextPage } = useFindingsFeed();
  const findings = flattenFeed(data?.pages);

  const [activeId, setActiveId] = useState<string | null>(null);
  const [soundOn, setSoundOn] = useState(false);

  const onViewable = useCallback(
    ({ viewableItems }: { viewableItems: ViewToken<TrackListItem>[] }) => {
      const token = viewableItems[0];
      if (token?.item) {
        setActiveId(idOf(token.item));
      }
      // Prefetch older findings before the user reaches the end. onEndReached is
      // unreliable on a paging feed, so drive it off the visible index instead.
      const idx = token?.index ?? -1;
      if (idx >= 0 && idx >= findings.length - 3 && hasNextPage && !isFetchingNextPage) {
        void fetchNextPage();
      }
    },
    [fetchNextPage, findings.length, hasNextPage, isFetchingNextPage],
  );
  const viewabilityConfig = useMemo(() => ({ itemVisiblePercentThreshold: 80 }), []);

  // autoplay the first card before the first viewability event fires
  const current = activeId ?? (findings[0] ? idOf(findings[0]) : null);

  // A stable toggle (updater form needs no soundOn dep) and a stable renderItem so
  // FlashList doesn't rebuild every cell on each redraw — only when the active card
  // or the global sound state actually changes.
  const toggleSound = useCallback(() => setSoundOn((s) => !s), [setSoundOn]);
  const renderItem = useCallback(
    ({ item }: { item: TrackListItem }) => (
      <FeedCard
        finding={item}
        active={idOf(item) === current}
        soundOn={soundOn}
        onToggleSound={toggleSound}
      />
    ),
    [current, soundOn, toggleSound],
  );

  return (
    <View style={{ backgroundColor: color.deepField, flex: 1 }}>
      <FlashList
        data={findings}
        keyExtractor={idOf}
        renderItem={renderItem}
        pagingEnabled
        showsVerticalScrollIndicator={false}
        snapToInterval={height}
        decelerationRate="fast"
        onViewableItemsChanged={onViewable}
        viewabilityConfig={viewabilityConfig}
        onEndReached={() => {
          if (hasNextPage) {
            void fetchNextPage();
          }
        }}
        onEndReachedThreshold={0.6}
      />
    </View>
  );
}
