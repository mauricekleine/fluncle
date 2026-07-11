import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { FlashList, type ViewToken } from "@shopify/flash-list";
import { type TrackListItem } from "@fluncle/contracts";
import { flattenFeed, useFindingsFeed } from "@/api/hooks";
import { FeedCard, NATIVE_TAB_BAR_HEIGHT } from "@/components/feed-card";
import { feedCopy, resolveFeedState } from "@/lib/feed-state";
import { color, font, radius } from "@/theme/tokens";

const idOf = (f: TrackListItem) => f.logId ?? f.trackId;

type FeedList = {
  fetchNextPage: () => Promise<unknown>;
  findings: TrackListItem[];
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
};

// The Stories feed (RFC Unit 2). This shell resolves the four honest states (H4) — no
// card ever renders on a blank, spinning, or lying screen — and hands the populated feed
// to <FeedPager>. Any data in hand wins; only a truly empty query falls to
// loading / error / empty.
export default function FeedScreen() {
  const { data, fetchNextPage, hasNextPage, isError, isFetchingNextPage, isPending, refetch } =
    useFindingsFeed();
  const findings = flattenFeed(data?.pages);
  const state = resolveFeedState({ count: findings.length, isError, isPending });

  if (state === "loading") {
    return <FeedLoading />;
  }
  if (state === "error") {
    return <FeedError onRetry={() => void refetch()} />;
  }
  if (state === "empty") {
    return <FeedEmpty />;
  }

  return (
    <FeedPager
      fetchNextPage={fetchNextPage}
      findings={findings}
      hasNextPage={hasNextPage}
      isFetchingNextPage={isFetchingNextPage}
    />
  );
}

// The populated pager. FlashList v2 vertical pager, one cell per screen.
// KNOWN RISK (RFC): FlashList #1200 — verify one-card-per-swipe on a low-end
// Android device; FlatList pagingEnabled is the documented fallback.
function FeedPager({ fetchNextPage, findings, hasNextPage, isFetchingNextPage }: FeedList) {
  const { height } = useWindowDimensions();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [soundOn, setSoundOn] = useState(false);

  // The viewability callback must keep a stable identity (RN warns otherwise), so
  // it reads live pagination state through a ref refreshed each render.
  const stateRef = useRef({ fetchNextPage, findings, hasNextPage, isFetchingNextPage });
  stateRef.current = { fetchNextPage, findings, hasNextPage, isFetchingNextPage };

  const onViewable = useRef(({ viewableItems }: { viewableItems: ViewToken<TrackListItem>[] }) => {
    const token = viewableItems[0];
    if (token?.item) {
      setActiveId(idOf(token.item));
    }
    // Prefetch older findings before the user reaches the end. onEndReached is
    // unreliable on a paging feed, so drive it off the visible index instead.
    const idx = token?.index ?? -1;
    const s = stateRef.current;
    if (idx >= 0 && idx >= s.findings.length - 3 && s.hasNextPage && !s.isFetchingNextPage) {
      void s.fetchNextPage();
    }
  }).current;
  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 80 }).current;

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
    <View style={styles.screen}>
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
      {isFetchingNextPage ? <FeedFooter /> : null}
    </View>
  );
}

/** A slow opacity pulse for the quiet loading/fetch indicators; static under reduce. */
function Pulse({ children, style }: { children: ReactNode; style?: object }) {
  const reduced = useReducedMotion();
  const t = useSharedValue(0);
  useEffect(() => {
    t.value = reduced
      ? 0
      : withRepeat(withTiming(1, { duration: 1100, easing: Easing.inOut(Easing.ease) }), -1, true);
  }, [reduced, t]);
  const pulse = useAnimatedStyle(() => ({ opacity: reduced ? 0.7 : 0.45 + t.value * 0.45 }));
  return <Animated.View style={[pulse, style]}>{children}</Animated.View>;
}

/** First paint: a quiet warm-dark hold (never a spinner on black). */
function FeedLoading() {
  return (
    <View style={[styles.screen, styles.center]}>
      <Pulse>
        <Text style={[font.body, styles.quiet]}>{feedCopy.loading}</Text>
      </Pulse>
    </View>
  );
}

/** An honest failure with a literal retry (the Chrome Rule). */
function FeedError({ onRetry }: { onRetry: () => void }) {
  return (
    <View style={[styles.screen, styles.center]}>
      <Text style={[font.title, styles.title]}>{feedCopy.error.title}</Text>
      <Text style={[font.body, styles.body]}>{feedCopy.error.body}</Text>
      <Pressable
        accessibilityLabel={feedCopy.error.retry}
        accessibilityRole="button"
        hitSlop={8}
        onPress={onRetry}
        style={({ pressed }) => [styles.retry, pressed ? styles.retryPressed : null]}
      >
        {({ pressed }) => (
          <Text style={[font.label, { color: pressed ? color.inkOnGold : color.starlightCream }]}>
            {feedCopy.error.retry}
          </Text>
        )}
      </Pressable>
    </View>
  );
}

/** No findings yet — the written Fluncle voice, forward-looking. */
function FeedEmpty() {
  return (
    <View style={[styles.screen, styles.center]}>
      <Text style={[font.title, styles.title]}>{feedCopy.empty.title}</Text>
      <Text style={[font.body, styles.body]}>{feedCopy.empty.body}</Text>
    </View>
  );
}

/** A quiet "loading more" beat at the bottom while the next page fetches. */
function FeedFooter() {
  const insets = useSafeAreaInsets();
  return (
    <Pulse style={[styles.footer, { bottom: insets.bottom + NATIVE_TAB_BAR_HEIGHT + 8 }]}>
      <Text style={[font.label, styles.quiet]}>{feedCopy.footer}</Text>
    </Pulse>
  );
}

const styles = StyleSheet.create({
  body: { color: color.stardust, maxWidth: 280, textAlign: "center" },
  center: { alignItems: "center", gap: 12, justifyContent: "center", padding: 32 },
  footer: { alignSelf: "center", position: "absolute" },
  quiet: { color: color.stardust },
  retry: {
    backgroundColor: color.tapeBlack,
    borderColor: color.stardust,
    borderRadius: radius.lg,
    borderWidth: 1,
    marginTop: 8,
    paddingHorizontal: 22,
    paddingVertical: 11,
  },
  // Ignition: the control heats to a gold fill on press (dark ink on top).
  retryPressed: { backgroundColor: color.eclipseGold, borderColor: color.eclipseGold },
  screen: { backgroundColor: color.deepField, flex: 1 },
  title: { color: color.starlightCream, textAlign: "center" },
});
