// The Radio tab — a lean-back "one continuous run" surface, the app's face of
// radio.fluncle.com. Cover-led and audio-only: the ONLY sound is Fluncle's spoken
// observation (never the commercial track), the finding's cover art is the hero, and a
// shared server clock decides what's playing and how far in — so a fresh join drops in
// mid-flight exactly where every other listener is. The web plays the same observation
// over a silent looping video; here the video is dropped for the cover, which keeps the
// App-Store 5.2 posture clean (bounded brand assets + the spoken note, nothing full-
// length) and sidesteps the iOS AVPlayer range constraint on transformed video URLs.
//
// BACKGROUND AUDIO: this screen takes the radio session (doNotMix + play-in-background)
// and drives the lock-screen now-playing controls, so the observation keeps going when
// the phone locks. The shared-clock CONTROLLER runs off a JS timer, which iOS throttles
// in the background — so a backgrounded run plays the current observation and, on
// return to the foreground, resyncs to the live slot (an AppState listener). The
// UIBackgroundModes entitlement that makes this work is added by the expo-audio config
// plugin (app.config.ts) and needs a NATIVE REBUILD, not a JS reload.
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

// Fluncle's voice, recovered-log register — reused VERBATIM from the web radio's
// ratified copy (apps/web/src/routes/radio.tsx COPY), so the one surface speaks in one
// voice. In-fiction, no banned identity words (NEVER broadcast / station / tune in /
// live — the retired radio-operator metaphor); warm, dry, no exclamation marks.
const COPY = {
  // The begin-gate subtitle: what this is — one continuous run you drop into mid-flight.
  beginSubtitle: "One continuous run of findings. You drop in mid-flight, wherever I've got to.",
  // Nothing radio-eligible yet (or the run gave out).
  empty: "Nothing logged out here yet. Quiet sector tonight.",
  // Catching up to the run (buffering / resyncing) — the web's loading register.
  loading: "Catching up to the run…",
  // The now-playing indicator while an observation is on air.
  observing: "Observing",
  // The gate + screen heading (the page's own name for itself).
  title: "Fluncle, observing",
} as const;

// The shared-clock controller tick. Findings advance from the CLOCK (not the audio
// element's end): each tick recomputes the boundary decision off the segment's anchor.
const CONTROLLER_TICK_MS = 250;
// Poll the server between segments to refresh skew and catch a rolled catalogue.
const SKEW_POLL_MS = 45_000;

type Playhead = {
  // The scheduled START of this segment in the (skew-corrected) SERVER clock — the one
  // anchor the controller derives its hold/advance/resync decision from.
  segmentStartServerMs: number;
  // ms into the observation this client was placed at (mid-flight join, or 0 from head).
  offsetMs: number;
  track: TrackListItem;
};

type Phase = "idle" | "playing" | "tuning";

/** The lock-screen now-playing card for a finding (title / artist / coordinate / cover). */
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

  // The clock skew (server − client, smoothed): the client computes its own expected
  // offset from `Date.now() + skew` between polls.
  const skewRef = useRef(0);
  // The preloaded NEXT finding (always plays from its head), read without re-subscribing.
  const nextRef = useRef<TrackListItem | undefined>(undefined);
  // The on-screen playhead, read inside the controller tick without re-subscribing.
  const playheadRef = useRef<Playhead | undefined>(undefined);
  // The current phase, read inside the focus effect without re-subscribing it.
  const phaseRef = useRef<Phase>(phase);
  // Mirror the two into refs AFTER commit (never during render) so the interval ticks
  // and the focus callback read the latest values without those effects re-subscribing.
  useEffect(() => {
    playheadRef.current = playhead;
  }, [playhead]);
  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);
  // One re-entrancy guard so an in-flight advance/resync can't fire twice.
  const busyRef = useRef(false);
  // Whether the CURRENT segment's audio has been started (seeked + played) — reset on
  // every new playhead so each segment (and each focus return) re-arms exactly once.
  const startedSegRef = useRef(false);

  // The client's server-clock now: Date.now() corrected by the smoothed skew. The one
  // source of truth the controller reads — so findings advance from the schedule clock.
  const serverNow = useCallback(() => Date.now() + skewRef.current, []);

  // The observation audio — the ONLY sound on this surface. `useAudioPlayer` builds a
  // FRESH player each time the source changes (it releases the old one), so `player` is
  // NOT stable across segments. That has two consequences handled below: (1) anything
  // that must survive a segment (the blur cleanup, `stop`) reads `playerRef`, never
  // `player` directly, so those effects don't re-subscribe every segment; (2) the start
  // effect keys ON `player` precisely because a new segment IS a new player to start.
  const observationUrl = playhead?.track.observationAudioUrl ?? null;
  const player = useAudioPlayer(observationUrl);
  const status = useAudioPlayerStatus(player);
  // The current segment's player, mirrored so stable effects can pause/clear it without
  // depending on the churning `player` identity.
  const playerRef = useRef(player);
  useEffect(() => {
    playerRef.current = player;
  }, [player]);
  // Whether the Radio tab is on screen. The controller keeps the SCHEDULE moving even
  // while blurred (so the shared clock stays honest), but audio must never sound off-
  // screen — the start effect gates `play()` on this, so a segment that advances while
  // we're on another tab stays silent until we return. Defaults true (mounted = focused).
  const focusedRef = useRef(true);

  // Resolve the authoritative now-playing slot, refresh the clock skew (NTP-lite), and
  // place the playhead at the returned offset — anchoring the segment's shared-clock
  // start. `fromHead` forces a head-start (a scheduled roll onto the next segment),
  // overriding the server's mid-segment offset for an already-listening client.
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

  // Advance to the NEXT finding at a segment boundary (driven by the controller, NOT the
  // audio's end). Roll onto the preloaded next if it's ready (the smooth transition),
  // else re-resolve from the server. The next segment's shared-clock start is the
  // previous start + the previous observation length — deterministic, so every client
  // lands the boundary at the same instant. NEVER a random skip; on trouble, resync.
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
      // Refresh the next preload + skew in the background; keep the head-start we painted.
      void resolveSlot(true).catch(() => {
        // Harmless — the controller re-evaluates and the poll re-syncs.
      });

      return;
    }

    try {
      await resolveSlot();
    } catch {
      setExhausted(true);
    }
  }, [resolveSlot]);

  // Begin: take the audio floor (stop any feed audio), switch to the background-capable
  // radio session, and resolve the synced slot — a fresh joiner lands mid-flight.
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

  // Stop the run: pause the observation, drop the lock-screen controls, restore the
  // app's foreground-only session, and return to the gate.
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

  // Start the CURRENT segment's audio exactly once it's loaded: seek to the shared-clock
  // offset and play, and bind the lock-screen now-playing card. Re-arms per segment via
  // startedSegRef (reset in resolveSlot/advance), so an advance or a focus-return replays
  // the fresh element at the right offset without double-firing.
  useEffect(() => {
    // Never sound off-screen: a segment that advances while the tab is blurred updates
    // the schedule but must not play until we return (the focus effect re-arms it then).
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
    // A continuous run has no scrubbable timeline — mark it live so the lock screen
    // hides the scrub bar and seek controls.
    player.setActiveForLockScreen(true, lockMeta(playhead.track), { isLiveStream: true });
  }, [playhead, observationUrl, status.isLoaded, player, serverNow]);

  // THE SCHEDULE-CLOCK CONTROLLER. Each tick computes the boundary decision off the
  // segment anchor and either holds, advances to the preloaded next, or resyncs. One
  // busy guard keeps an in-flight advance/resync from firing twice.
  useEffect(() => {
    if (phase !== "playing" || !playhead) {
      return;
    }

    const tick = () => {
      const head = playheadRef.current;

      // Off-screen: don't advance (which would build+load a new player per segment for
      // nothing) or resync. Re-focusing resyncs to the live slot; until then, hold.
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

  // Poll the server between segments to refresh skew and catch a rolled catalogue (the
  // schedule advancing to a finding neither we nor our preload expect → hard-resync).
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
        .catch(() => {
          // Transient — the next poll or the controller re-syncs.
        });
    }, SKEW_POLL_MS);

    return () => clearInterval(id);
  }, [phase, playhead, fetchSlot, resolveSlot]);

  // Returning from the background (the timers were throttled while away): resync to the
  // live slot so the run catches back up to where everyone else is.
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

  // Leaving the Radio tab (blur) MUST stop the run — this is half of the no-overlap
  // guarantee (the other half: begin() calls claimAudioFocus() to stop the feed). On
  // blur: mark unfocused (silences any advance), pause the current player, drop the
  // lock-screen controls, restore the foreground session. On a later focus, if a run was
  // going, re-take the floor + session and resync. Deps are STABLE (`resolveSlot` only),
  // never the churning `player` — so this fires on real focus/blur, not every segment;
  // it reaches the live player through `playerRef`.
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

// The begin-gate: the run's name + what it is + the one control. `loading` holds the
// gate with a disabled catching-up button while the first slot resolves.
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

// The quiet-sector state: nothing to play. Offers a Begin to try again (the run may
// have simply not started yet).
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

// The now-playing card: the finding's cover as the hero (a slow eclipse drift, static
// under reduced motion), the coordinate above it, artist — title below, the observation
// indicator, and the one Stop control in the thumb zone (cover-led, One Sun).
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

// The observation indicator: a gold pulse + "Observing" while the note is on air, a
// quiet "Catching up to the run…" while it buffers. The pulse is decorative (the label
// carries the meaning), so it's aria-hidden and static under reduced motion.
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
