// One finding, full-screen (RFC Unit 2). Per-cell player, the media ladder, the
// native overlay (a right action rail + bottom caption), the cover-card eclipse
// drift, and the background-pause rule. The de-risk spike target.
import { memo, type ReactNode, useCallback, useEffect, useId, useMemo } from "react";
import {
  Linking,
  Pressable,
  Share,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import { Image } from "expo-image";
import { useVideoPlayer, VideoView } from "expo-video";
import { useAudioPlayer, useAudioPlayerStatus } from "expo-audio";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import { type TrackListItem } from "@fluncle/contracts";
import { resolveCardMedia } from "@/lib/media";
import { observationRail, soundRail } from "@/lib/feed-rail";
import { useBackgroundPause } from "@/audio/session";
import { color, font } from "@/theme/tokens";

// The floating iOS 26 tab bar's clearance. expo-router NativeTabs renders a real
// native UITabBar and — unlike React Navigation's JS tab bar — exposes NO height hook
// (only `usePlacement`, for bottom accessories). Its automatic content insets adjust
// the scrolling content, not overlays absolutely positioned inside a full-bleed card,
// so the caption + rail have to clear the bar themselves. ~49pt is the standard
// UITabBar height, which the floating bar rides above the home-indicator safe area
// (`insets.bottom`); a small per-element pad lifts the caption/rail just clear of it.
// Documented constant, not a measured API — the operator verifies the exact clearance
// in the simulator after merge.
export const NATIVE_TAB_BAR_HEIGHT = 49;

// OPERATOR RULING 2026-07-11: no scrim pane. The earlier AA-worst-case fix laid a
// multi-stop warm-dark gradient over the lower screen; on lighter footage it read as a
// clearly visible dark opaque box (TikTok doesn't do it either). So the footage stays
// UNVEILED — no gradient — and legibility rides firm per-glyph shadows instead (the
// TikTok-style treatment: a wide, warm-dark, high-alpha text shadow on every overlay
// glyph; see `TEXT_SHADOW` below). The tradeoff is accepted by the operator: against a
// pure-white cover the thin caption strokes can dip under the WCAG AA 4.5:1 target, and
// that worst case is taken knowingly for footage-first parity over an occluding box.
const TEXT_SHADOW = {
  // Warm near-black (r>g>b, never pure black — DESIGN.md), wide + strong so a light
  // glyph reads on light footage without a pane behind it.
  textShadowColor: "rgba(9, 6, 3, 0.92)",
  textShadowOffset: { height: 1, width: 0 },
  textShadowRadius: 10,
} as const;

type Props = {
  finding: TrackListItem;
  active: boolean;
  soundOn: boolean;
  onToggleSound: () => void;
};

function foundLabel(iso: string): string {
  const d = new Date(iso);
  return `Found ${d.toLocaleDateString("en-US", { day: "numeric", month: "short" })}`;
}

export const FeedCard = memo(function FeedCard({ finding, active, soundOn, onToggleSound }: Props) {
  const { height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const reduced = useReducedMotion();
  // The floor every bottom overlay sits above: the home-indicator inset plus the
  // floating tab bar (H3 — the caption/date and the bottom rail control used to hide
  // under it).
  const bottomFloor = insets.bottom + NATIVE_TAB_BAR_HEIGHT;
  // Stabilize the resolved media so effects can depend on the object itself (not
  // computed `media.kind`/`media.previewUrl` member reads) and only re-run when the
  // finding actually changes.
  const media = useMemo(() => resolveCardMedia(finding), [finding]);

  const player = useVideoPlayer(media.kind === "video" ? media.videoUrl : null, (p) => {
    p.loop = true;
    p.muted = true;
  });
  const audio = useAudioPlayer(
    media.kind === "cover" && media.previewUrl ? media.previewUrl : null,
  );

  // The recovered observation (VOICE.md's first-heard surface): Fluncle's own
  // voice over the finding, on its own player so it never collides with the
  // card's video/preview track. Only loaded when the finding actually has one.
  const observationUrl = finding.observationAudioUrl ?? null;
  const observation = useAudioPlayer(observationUrl);
  const observationStatus = useAudioPlayerStatus(observation);
  const observing = active && observationStatus.playing;
  // Stable rail labels + a11y hints (the Chrome Rule); the icon/gold tint carry state.
  const observationControl = observationRail(observing);
  // The observation and the card's sound are mutually exclusive: while the observation
  // plays, the Sound control renders its muted state (never gold), and the audio effect
  // below keeps the card track silent. When it ends, `soundOn` restores the card's sound.
  const soundControl = soundRail(soundOn, observing);

  // Only the visible card plays; sound follows the global toggle. While the
  // observation plays it owns the one sound source — keep the card media silent.
  useEffect(() => {
    if (media.kind === "video") {
      // eslint-disable-next-line react-hooks/immutability -- expo-video exposes `muted` as the documented imperative player API.
      player.muted = !soundOn || observing;
      if (active && !observing) {
        player.play();
      } else {
        player.pause();
      }
    } else if (media.previewUrl) {
      if (active && soundOn && !observing) {
        audio.play();
      } else {
        audio.pause();
      }
    }
  }, [active, audio, media, observing, player, soundOn]);

  // Scrolling the card away stops a playing observation (visible-card-only rule).
  useEffect(() => {
    if (!active && observationStatus.playing) {
      observation.pause();
    }
  }, [active, observation, observationStatus.playing]);

  // Hold the wake lock while this card is the one actually making sound (an
  // audible video, or Fluncle's observation) so a long clip never lets the
  // screen sleep mid-listen. A stable per-card tag keeps the calls idempotent;
  // the cleanup always releases, so locks can't leak on pause/scroll/unmount.
  const keepAwakeTag = useId();
  const audibleVideo = active && media.kind === "video" && soundOn && !observing;
  const playing = observing || audibleVideo;
  useEffect(() => {
    if (!playing) {
      return;
    }
    void activateKeepAwakeAsync(keepAwakeTag);
    return () => {
      void deactivateKeepAwake(keepAwakeTag);
    };
  }, [keepAwakeTag, playing]);

  const stopObservation = useCallback(() => {
    observation.pause();
  }, [observation]);

  const toggleObservation = useCallback(() => {
    if (observing) {
      stopObservation();
      return;
    }
    player.pause();
    audio.pause();
    void observation.seekTo(0);
    observation.play();
  }, [observing, stopObservation, player, audio, observation]);

  // No background audio (reinforces the session rule; covers calls / route changes).
  const pauseAll = useCallback(() => {
    if (media.kind === "video") {
      player.pause();
    } else {
      audio.pause();
    }
    if (observing) {
      observation.pause();
    }
  }, [audio, media, observation, observing, player]);
  useBackgroundPause(pauseAll);

  // Cover rung: a slow eclipse drift (The Light-Years cover card is alive, not static).
  const drift = useSharedValue(0);
  useEffect(() => {
    drift.value =
      media.kind === "cover" && !reduced
        ? withRepeat(
            withTiming(1, { duration: 22000, easing: Easing.inOut(Easing.ease) }),
            -1,
            true,
          )
        : 0;
  }, [drift, media, reduced]);
  const coverStyle = useAnimatedStyle(() => ({
    transform: [
      { scale: 1 + drift.value * 0.06 },
      { translateX: -drift.value * 6 },
      { translateY: -drift.value * 4 },
    ],
  }));

  return (
    <View style={{ height, overflow: "hidden" }} className="bg-deep-field">
      {media.kind === "video" ? (
        <VideoView
          player={player}
          style={{ flex: 1 }}
          contentFit="cover"
          nativeControls={false}
          pointerEvents="none"
        />
      ) : (
        <Animated.View style={[{ flex: 1 }, coverStyle]}>
          <Image source={media.coverUrl} style={{ flex: 1 }} contentFit="cover" transition={250} />
        </Animated.View>
      )}

      {/* No scrim pane (operator ruling 2026-07-11 — it read as a dark box on light
          footage). The footage stays unveiled; per-glyph shadows carry legibility. */}

      {/* Right action rail (TikTok-style). Each control keeps ONE stable label (the
          Chrome Rule); the icon + the gold tint carry state, never the word. Icons stay
          legible via a drop shadow; gold marks the active state (Ignition). */}
      <View style={[styles.rail, { bottom: bottomFloor + 28 }]}>
        {observationUrl ? (
          <RailAction
            accessibilityLabel={observationControl.accessibilityLabel}
            active={observationControl.active}
            icon={
              <Ionicons
                name={observing ? "headset" : "headset-outline"}
                size={28}
                color={observing ? color.eclipseGold : color.starlightCream}
                style={[styles.icon, styles.observationNudge]}
              />
            }
            label={observationControl.label}
            onPress={toggleObservation}
          />
        ) : null}
        <RailAction
          icon={
            <MaterialCommunityIcons
              name="spotify"
              size={30}
              color={color.starlightCream}
              style={[styles.icon, styles.spotifyNudge]}
            />
          }
          label="Spotify"
          onPress={() => Linking.openURL(finding.spotifyUrl)}
        />
        <RailAction
          icon={
            <Ionicons
              name="share-outline"
              size={29}
              color={color.starlightCream}
              style={styles.icon}
            />
          }
          label="Share"
          onPress={() => Share.share({ url: finding.logPageUrl ?? finding.spotifyUrl })}
        />
        <RailAction
          accessibilityLabel={soundControl.accessibilityLabel}
          icon={
            <Ionicons
              name={soundControl.active ? "volume-high" : "volume-mute"}
              size={29}
              color={soundControl.active ? color.eclipseGold : color.starlightCream}
              style={styles.icon}
            />
          }
          active={soundControl.active}
          label={soundControl.label}
          onPress={onToggleSound}
        />
      </View>

      {/* Bottom caption (narrowed to clear the rail, sitting tight above the tab pill —
          operator ruling: it floated too far above the bar). The title leads (PRODUCT.md
          — artist + title first); the gold coordinate sits below it at reduced prominence,
          still the identity mark but no longer out-shouting. Every glyph carries the firm
          per-glyph shadow (no scrim pane) so it reads on light footage. */}
      <View style={{ bottom: bottomFloor + 10, gap: 8, left: 16, position: "absolute", right: 96 }}>
        <Text
          style={[font.title, styles.captionShadow, { color: color.starlightCream }]}
          numberOfLines={2}
        >
          {finding.artists.join(", ")} — {finding.title}
        </Text>
        {finding.note ? (
          <Text
            style={[font.body, styles.captionShadow, { color: color.stardust }]}
            numberOfLines={3}
          >
            {finding.note}
          </Text>
        ) : null}
        <View style={styles.captionMeta}>
          {finding.logId ? (
            <Text style={[font.numeric, styles.captionShadow, styles.logId]}>{finding.logId}</Text>
          ) : null}
          <Text style={[font.body, styles.captionShadow, { color: color.stardust }]}>
            {foundLabel(finding.addedAt)}
          </Text>
        </View>
      </View>
    </View>
  );
});

function RailAction({
  accessibilityLabel,
  icon,
  label,
  onPress,
  active,
}: {
  accessibilityLabel?: string;
  active?: boolean;
  icon: ReactNode;
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      hitSlop={6}
      onPress={onPress}
      style={({ pressed }) => [styles.railItem, pressed ? styles.railPressed : null]}
    >
      <View style={styles.railIcon}>{icon}</View>
      <Text
        style={[font.label, styles.railLabel, active ? styles.railLabelActive : null]}
        numberOfLines={1}
      >
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  // The gold coordinate, demoted below the title: the identity gold (not the brighter
  // Eclipse Glow) at a size under the title's, so it reads as a mark, not a headline.
  captionMeta: { alignItems: "baseline", flexDirection: "row", gap: 8 },
  // The firm per-glyph shadow that replaces the scrim pane (operator ruling): with no
  // gradient behind it, every caption glyph carries this warm-dark halo so it reads on
  // light footage. The rail icons + labels share it too.
  captionShadow: TEXT_SHADOW,
  icon: TEXT_SHADOW,
  logId: { color: color.eclipseGold, fontSize: 13 },
  // The four rail items already share one wrapper (RailAction + the 36×36 centered
  // `railIcon`), so this is not a structural leftover — it's the glyph itself. The
  // Ionicons headset advance box centers, but the mic boom hanging off the left earcup
  // pulls the visible artwork's centroid left of the rail axis (the same optical drift
  // spotify corrects below). Nudge it back onto the axis. Magnitude is an optical
  // estimate; the operator fine-tunes the sign/amount in-sim after merge.
  observationNudge: { transform: [{ translateX: 2 }] },
  rail: { alignItems: "center", gap: 16, position: "absolute", right: 6 },
  railIcon: { alignItems: "center", height: 36, justifyContent: "center", width: 36 },
  // Wide enough for the longest stable label ("Observation") on one line.
  railItem: { alignItems: "center", gap: 3, width: 80 },
  railLabel: {
    color: color.starlightCream,
    fontSize: 11,
    textAlign: "center",
    ...TEXT_SHADOW,
  },
  railLabelActive: { color: color.eclipseGold },
  railPressed: { opacity: 0.6 },
  // The spotify brand mark's three waves sit optically left of the circle's true
  // center (true of the glyph in any icon font), so nudge it onto the rail axis.
  spotifyNudge: { transform: [{ translateX: 4 }] },
});
