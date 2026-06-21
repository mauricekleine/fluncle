import { useRef, useState } from "react";
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
  const { data, fetchNextPage, hasNextPage } = useFindingsFeed();
  const findings = flattenFeed(data?.pages);

  const [activeId, setActiveId] = useState<string | null>(null);
  const [soundOn, setSoundOn] = useState(false);

  const onViewable = useRef(({ viewableItems }: { viewableItems: ViewToken<TrackListItem>[] }) => {
    const first = viewableItems[0]?.item;
    if (first) {
      setActiveId(idOf(first));
    }
  }).current;
  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 80 }).current;

  // autoplay the first card before the first viewability event fires
  const current = activeId ?? (findings[0] ? idOf(findings[0]) : null);

  return (
    <View style={{ backgroundColor: color.deepField, flex: 1 }}>
      <FlashList
        data={findings}
        keyExtractor={idOf}
        renderItem={({ item }) => (
          <FeedCard
            finding={item}
            active={idOf(item) === current}
            soundOn={soundOn}
            onToggleSound={() => setSoundOn((s) => !s)}
          />
        )}
        pagingEnabled
        showsVerticalScrollIndicator={false}
        snapToInterval={height}
        decelerationRate="fast"
        onViewableItemsChanged={onViewable}
        viewabilityConfig={viewabilityConfig}
        onEndReached={() => {
          if (hasNextPage) {
            fetchNextPage();
          }
        }}
        onEndReachedThreshold={0.6}
      />
    </View>
  );
}
