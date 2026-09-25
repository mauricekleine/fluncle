import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, StyleSheet, Text, View } from "react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect } from "expo-router";
import { Image } from "expo-image";
import { type AudioMetadata, useAudioPlayer, useAudioPlayerStatus } from "expo-audio";
import { type TrackListItem } from "@fluncle/contracts";
import { useRadioSlotFetcher } from "@/api/hooks";
import {
  claimAudioFocus,
  configureAudioSession,
  configureRadioAudioSession,
} from "@/audio/session";
import { CosmosBackdrop } from "@/components/cosmos-backdrop";
import { HeatButton } from "@/components/heat-button";
import { radioArtworkUrl } from "@/lib/media";
import {
  radioBoundaryDecision,
  radioSkewSample,
  segmentMs,
  smoothSkew,
} from "@/lib/radio-schedule";
import { color, font, radius } from "@/theme/tokens";

const COPY = {
  beginSubtitle: "One continuous run of findings. You drop in mid-flight, wherever I've got to.",

  empty: "Nothing logged out here yet. Quiet sector tonight.",

  loading: "Catching up to the run…",

  observing: "Observing",

  title: "Fluncle, observing",
} as const;

const CONTROLLER_TICK_MS = 250;

const SKEW_POLL_MS = 45_000;

type Playhead = {
  segmentStartServerMs: number;

  offsetMs: number;
  track: TrackListItem;
};

type Phase = "idle" | "playing" | "tuning";

function lockMeta(track: TrackListItem): AudioMetadata {
  return {
    albumTitle: track.logId,
    artist: track.artists.join(", "),
    artworkUrl: track.albumImageUrl,
    title: track.title,
  };
}

export default function RadioScreen() {
  const fetchSlot = useRadioSlotFetcher();

  const [phase, setPhase] = useState<Phase>("idle");
  const [playhead, setPlayhead] = useState<Playhead | undefined>(undefined);
  const [exhausted, setExhausted] = useState(false);

  const skewRef = useRef(0);

  const nextRef = useRef<TrackListItem | undefined>(undefined);

  const playheadRef = useRef<Playhead | undefined>(undefined);

  const phaseRef = useRef<Phase>(phase);

  useEffect(() => {
    playheadRef.current = playhead;
  }, [playhead]);
  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  const busyRef = useRef(false);

  const startedSegRef = useRef(false);

  const serverNow = useCallback(() => Date.now() + skewRef.current, []);

  const observationUrl = playhead?.track.observationAudioUrl ?? null;
  const player = useAudioPlayer(observationUrl);
  const status = useAudioPlayerStatus(player);

  const playerRef = useRef(player);
  useEffect(() => {
    playerRef.current = player;
  }, [player]);

  const focusedRef = useRef(true);

  const resolveSlot = useCallback(
    async (fromHead = false): Promise<void> => {
      const { receivedAt, sentAt, slot } = await fetchSlot();
      skewRef.current = smoothSkew(
        skewRef.current,
        radioSkewSample(slot.serverEpochMs, sentAt, receivedAt),
      );

      const offsetMs = fromHead ? 0 : slot.offsetMs;

      nextRef.current = slot.nextTrack;
      startedSegRef.current = false;
      setExhausted(false);
      setPlayhead({
        offsetMs,
        segmentStartServerMs: Date.now() + skewRef.current - offsetMs,
        track: slot.currentTrack,
      });
    },
    [fetchSlot],
  );

  const advance = useCallback(async () => {
    const current = playheadRef.current;
    const preloaded = nextRef.current;

    if (current && preloaded) {
      nextRef.current = undefined;
      startedSegRef.current = false;
      setExhausted(false);
      setPlayhead({
        offsetMs: 0,
        segmentStartServerMs:
          current.segmentStartServerMs + segmentMs(current.track.observationDurationMs),
        track: preloaded,
      });

      void resolveSlot(true).catch(() => {});

      return;
    }

    try {
      await resolveSlot();
    } catch {
      setExhausted(true);
    }
  }, [resolveSlot]);

  const begin = useCallback(() => {
    claimAudioFocus();
    configureRadioAudioSession();
    setPhase("tuning");
    resolveSlot()
      .then(() => setPhase("playing"))
      .catch(() => {
        setExhausted(true);
        setPhase("playing");
      });
  }, [resolveSlot]);

  const stop = useCallback(() => {
    playerRef.current.pause();
    playerRef.current.setActiveForLockScreen(false);
    configureAudioSession();
    startedSegRef.current = false;
    setPlayhead(undefined);
    nextRef.current = undefined;
    setExhausted(false);
    setPhase("idle");
  }, []);

  useEffect(() => {
    if (
      !focusedRef.current ||
      !playhead ||
      !observationUrl ||
      !status.isLoaded ||
      startedSegRef.current
    ) {
      return;
    }

    startedSegRef.current = true;

    const seg = segmentMs(playhead.track.observationDurationMs);
    const expected = serverNow() - playhead.segmentStartServerMs;

    void player.seekTo(Math.max(0, Math.min(expected, seg)) / 1000);
    player.play();

    player.setActiveForLockScreen(true, lockMeta(playhead.track), { isLiveStream: true });
  }, [playhead, observationUrl, status.isLoaded, player, serverNow]);

  useEffect(() => {
    if (phase !== "playing" || !playhead) {
      return;
    }

    const tick = () => {
      const head = playheadRef.current;

      if (!focusedRef.current || !head || busyRef.current) {
        return;
      }

      const seg = segmentMs(head.track.observationDurationMs);
      const decision = radioBoundaryDecision(head.segmentStartServerMs, seg, serverNow());

      if (decision === "advance") {
        busyRef.current = true;
        void advance().finally(() => {
          busyRef.current = false;
        });

        return;
      }

      if (decision === "resync") {
        busyRef.current = true;
        void resolveSlot()
          .catch(() => setExhausted(true))
          .finally(() => {
            busyRef.current = false;
          });
      }
    };

    const id = setInterval(tick, CONTROLLER_TICK_MS);

    return () => clearInterval(id);
  }, [phase, playhead, advance, resolveSlot, serverNow]);

  useEffect(() => {
    if (phase !== "playing" || !playhead) {
      return;
    }

    const id = setInterval(() => {
      void fetchSlot()
        .then(({ receivedAt, sentAt, slot }) => {
          skewRef.current = smoothSkew(
            skewRef.current,
            radioSkewSample(slot.serverEpochMs, sentAt, receivedAt),
          );

          const head = playheadRef.current;
          const movedOn =
            head !== undefined &&
            slot.currentTrack.trackId !== head.track.trackId &&
            slot.currentTrack.trackId !== nextRef.current?.trackId;

          if (movedOn && !busyRef.current) {
            busyRef.current = true;
            void resolveSlot()
              .catch(() => undefined)
              .finally(() => {
                busyRef.current = false;
              });
          }
        })
        .catch(() => {});
    }, SKEW_POLL_MS);

    return () => clearInterval(id);
  }, [phase, playhead, fetchSlot, resolveSlot]);

  useEffect(() => {
    if (phase !== "playing") {
      return;
    }

    const sub = AppState.addEventListener("change", (next) => {
      if (next === "active" && !busyRef.current) {
        busyRef.current = true;
        void resolveSlot()
          .catch(() => setExhausted(true))
          .finally(() => {
            busyRef.current = false;
          });
      }
    });

    return () => sub.remove();
  }, [phase, resolveSlot]);

  useFocusEffect(
    useCallback(() => {
      focusedRef.current = true;

      if (phaseRef.current === "playing") {
        claimAudioFocus();
        configureRadioAudioSession();
        startedSegRef.current = false;
        void resolveSlot().catch(() => setExhausted(true));
      }

      return () => {
        focusedRef.current = false;
        playerRef.current.pause();
        playerRef.current.setActiveForLockScreen(false);
        configureAudioSession();
      };
    }, [resolveSlot]),
  );

  if (phase === "idle") {
    return <RadioGate onBegin={begin} />;
  }

  if (exhausted) {
    return <RadioMessage onBegin={begin}>{COPY.empty}</RadioMessage>;
  }

  if (!playhead) {
    return <RadioGate loading onBegin={begin} />;
  }

  return <NowPlaying observing={status.playing} onStop={stop} track={playhead.track} />;
}

function RadioGate({ loading = false, onBegin }: { loading?: boolean; onBegin: () => void }) {
  return (
    <View style={styles.screen}>
      <CosmosBackdrop />
      <SafeAreaView style={styles.gate}>
        <Text style={[font.display, styles.gateTitle]}>{COPY.title}</Text>
        <Text style={[font.body, styles.gateSubtitle]}>{COPY.beginSubtitle}</Text>
        <View style={styles.gateAction}>
          <HeatButton
            disabled={loading}
            label={loading ? COPY.loading : "Begin"}
            onPress={onBegin}
          />
        </View>
      </SafeAreaView>
    </View>
  );
}

function RadioMessage({ children, onBegin }: { children: string; onBegin: () => void }) {
  return (
    <View style={styles.screen}>
      <CosmosBackdrop />
      <SafeAreaView style={styles.gate}>
        <Text style={[font.body, styles.gateSubtitle]} role="status">
          {children}
        </Text>
        <View style={styles.gateAction}>
          <HeatButton label="Begin" onPress={onBegin} variant="outline" />
        </View>
      </SafeAreaView>
    </View>
  );
}

function NowPlaying({
  observing,
  onStop,
  track,
}: {
  observing: boolean;
  onStop: () => void;
  track: TrackListItem;
}) {
  const reduced = useReducedMotion();
  const artwork = radioArtworkUrl(track);

  const drift = useSharedValue(0);
  useEffect(() => {
    drift.value = reduced
      ? 0
      : withRepeat(withTiming(1, { duration: 22000, easing: Easing.inOut(Easing.ease) }), -1, true);
  }, [drift, reduced]);
  const coverStyle = useAnimatedStyle(() => ({
    transform: [{ scale: 1 + drift.value * 0.05 }, { translateY: -drift.value * 5 }],
  }));

  return (
    <View style={styles.screen}>
      <CosmosBackdrop />
      <SafeAreaView style={styles.nowPlaying}>
        <View style={styles.stage}>
          {track.logId ? (
            <Text style={[font.numeric, styles.coordinate]}>{track.logId}</Text>
          ) : null}

          <Animated.View style={[styles.coverWrap, coverStyle]}>
            {artwork ? (
              <Image contentFit="cover" source={artwork} style={styles.cover} transition={250} />
            ) : (
              <View style={[styles.cover, styles.coverEmpty]} />
            )}
          </Animated.View>

          <Text numberOfLines={2} style={[font.title, styles.trackTitle]}>
            {track.artists.join(", ")} — {track.title}
          </Text>

          <ObservationIndicator observing={observing} reduced={reduced} />
        </View>

        <View style={styles.stopAction}>
          <HeatButton label="Stop" onPress={onStop} variant="outline" />
        </View>
      </SafeAreaView>
    </View>
  );
}

function ObservationIndicator({ observing, reduced }: { observing: boolean; reduced: boolean }) {
  const pulse = useSharedValue(0);
  useEffect(() => {
    pulse.value =
      observing && !reduced
        ? withRepeat(withTiming(1, { duration: 1100, easing: Easing.inOut(Easing.ease) }), -1, true)
        : 0;
  }, [observing, reduced, pulse]);
  const dotStyle = useAnimatedStyle(() => ({ opacity: 0.5 + pulse.value * 0.5 }));

  return (
    <View style={styles.indicator}>
      {observing ? <Animated.View aria-hidden style={[styles.dot, dotStyle]} /> : null}
      <Text style={[font.label, styles.indicatorLabel]}>
        {observing ? COPY.observing : COPY.loading}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  coordinate: { color: color.eclipseGlow, fontSize: 15 },
  cover: {
    borderRadius: radius.lg,
    height: "100%",
    width: "100%",
  },
  coverEmpty: { backgroundColor: color.tapeBlack },
  coverWrap: {
    aspectRatio: 1,
    maxWidth: 360,
    overflow: "hidden",
    width: "82%",
  },
  dot: {
    backgroundColor: color.eclipseGold,
    borderRadius: 4,
    height: 8,
    width: 8,
  },
  gate: { alignItems: "center", flex: 1, gap: 14, justifyContent: "center", padding: 32 },
  gateAction: { marginTop: 10, minWidth: 200 },
  gateSubtitle: { color: color.stardust, maxWidth: 320, textAlign: "center" },
  gateTitle: { color: color.starlightCream, fontSize: 30, textAlign: "center" },
  indicator: { alignItems: "center", flexDirection: "row", gap: 8, minHeight: 22 },
  indicatorLabel: { color: color.stardust, fontSize: 12, letterSpacing: 0.4 },
  nowPlaying: { flex: 1, justifyContent: "space-between", padding: 24 },
  screen: { backgroundColor: color.deepField, flex: 1 },
  stage: { alignItems: "center", flex: 1, gap: 18, justifyContent: "center" },
  stopAction: { alignSelf: "center", minWidth: 160 },
  trackTitle: { color: color.starlightCream, maxWidth: 360, textAlign: "center" },
});
