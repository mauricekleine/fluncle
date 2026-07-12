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
import { useAudioPlayer } from "expo-audio";
import { LinearGradient } from "expo-linear-gradient";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import { type TrackListItem } from "@fluncle/contracts";
import { resolveCardMedia } from "@/lib/media";
import { soundRail } from "@/lib/feed-rail";
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

// OPERATOR RULING 2026-07-12: the scrim returns (third iteration). The previous fix
// removed the gradient entirely because iteration two had a visible ONSET LINE — its
// first stop jumped 0→0.35 alpha at 14% of the height, a perceptible edge on light
// footage. The direction was right; the failure was the hard start. This iteration is a
// bottom gradient that reaches FULL opacity at the very bottom screen edge (behind the
// tab bar too) with an IMPERCEPTIBLE onset: many stops on an eased curve where alpha
// stays under ~0.05 through the first third of the gradient's height, so there is no
// human-visible start line even on a pure-white cover. The per-glyph shadows below stay
// — they COMPOSE with the scrim (the caption/rail sit in the gradient's ≥0.7 zone, and
// the shadows carry the last mile). See SCRIM_* below for the exact stops.
const TEXT_SHADOW = {
  // Warm near-black (r>g>b, never pure black — DESIGN.md), wide + strong so a light
  // glyph reads on light footage; composes over the scrim below it.
  textShadowColor: "rgba(9, 6, 3, 0.92)",
  textShadowOffset: { height: 1, width: 0 },
  textShadowRadius: 10,
} as const;

// THE SCRIM (operator ruling 2026-07-12). A warm near-black (rgb(9,6,3) — never pure
// #000, DESIGN.md) bottom-to-top gradient. Two properties are load-bearing:
//
//  1. IMPERCEPTIBLE ONSET — no visible start line. The alpha ramp is eased (a soft
//     quadratic toe): it holds under ~0.05 through the first third of the gradient
//     (locations ≤ 0.34 → alpha ≤ 0.04), so where the box begins over the cover there is
//     nothing an eye can catch. This is the exact failure of iteration two (0→0.35 at
//     14%) inverted.
//  2. OPAQUE FLOOR — alpha 1.0 at the very bottom edge, so the area behind the floating
//     (translucent) native tab bar reads as solid warm-black, not a fading cover.
//
// Rendered bottom-anchored and sized by `scrimHeight()` so the highest overlay (the
// rail's top) lands inside the ≥0.7 band. Colours and locations index-align.
const SCRIM_RGB = "9, 6, 3";
const SCRIM_COLORS = [
  `rgba(${SCRIM_RGB}, 0)`,
  `rgba(${SCRIM_RGB}, 0.01)`,
  `rgba(${SCRIM_RGB}, 0.04)`,
  `rgba(${SCRIM_RGB}, 0.12)`,
  `rgba(${SCRIM_RGB}, 0.3)`,
  `rgba(${SCRIM_RGB}, 0.55)`,
  `rgba(${SCRIM_RGB}, 0.8)`,
  `rgba(${SCRIM_RGB}, 0.95)`,
  `rgba(${SCRIM_RGB}, 1)`,
] as const;
const SCRIM_LOCATIONS = [0, 0.16, 0.34, 0.44, 0.52, 0.58, 0.64, 0.8, 1] as const;
// The rail is the tallest bottom overlay: three RailAction stacks (icon box 36 + label,
// gap 16) rising from the shared bottom line. This is the height of that band, used to
// size the scrim so the rail's TOP sits inside the opaque ≥0.7 zone.
const RAIL_BAND = 196;

// The scrim's total height, from the opaque bottom edge up to its imperceptible toe.
// Sized so the highest overlay (bottomLine + RAIL_BAND from the bottom) lands at ~0.66
// down the gradient — inside the ≥0.7 band (alpha ≈ 0.82 there) — while the top third
// stays under 0.05. Clamped to the screen so it never overflows; the operator verifies
// the exact clearance on-device (as with NATIVE_TAB_BAR_HEIGHT).
function scrimHeight(overlayTop: number, screenHeight: number): number {
  return Math.min(screenHeight, overlayTop / 0.34);
}

// OPERATOR RULING 2026-07-11 (device pass): the firm TEXT_SHADOW above is right for the
// thin text strokes (caption + rail labels), but on an Ionicons/MaterialCommunityIcons
// glyph — a large, solid, font-rendered shape — a radius-10, 0.92-alpha shadow smears
// into a dark blotchy backdrop behind every icon, very visible on light footage. Icons
// carry a far tighter halo instead: a small radius at low alpha, enough to hold the
// glyph's edge against a light cover without reading as a pane. The labels underneath
// keep the firm shadow and do the real legibility work.
const ICON_SHADOW = {
  textShadowColor: "rgba(9, 6, 3, 0.55)",
  textShadowOffset: { height: 1, width: 0 },
  textShadowRadius: 3,
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
  // INVARIANT: the rail and the caption share a bottom line. Both bottom overlays anchor
  // their bottom edge here (tab-bar floor + a little tightened air), so the rail's last
  // label ("Sound") bottom-aligns with the caption's last line (the coordinate + Found
  // row) — one line, not two staggered ones (operator device pass).
  const bottomLine = bottomFloor + 10;
  // The scrim rises from the opaque bottom edge past the tallest overlay (the rail top)
  // and fades to nothing above it — sized so the rail/caption band sits in its ≥0.7 zone.
  const scrimH = scrimHeight(bottomLine + RAIL_BAND, height);
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

  // Stable rail labels + a11y hints (the Chrome Rule); the icon + gold tint carry state.
  const soundControl = soundRail(soundOn);

  // Only the visible card plays; sound follows the global toggle.
  useEffect(() => {
    if (media.kind === "video") {
      // eslint-disable-next-line react-hooks/immutability -- expo-video exposes `muted` as the documented imperative player API.
      player.muted = !soundOn;
      if (active) {
        player.play();
      } else {
        player.pause();
      }
    } else if (media.previewUrl) {
      if (active && soundOn) {
        audio.play();
      } else {
        audio.pause();
      }
    }
  }, [active, audio, media, player, soundOn]);

  // Hold the wake lock while this card is the one actually making sound (an audible
  // video) so a long clip never lets the screen sleep mid-listen. A stable per-card tag
  // keeps the calls idempotent; the cleanup always releases, so locks can't leak on
  // pause/scroll/unmount.
  const keepAwakeTag = useId();
  const playing = active && media.kind === "video" && soundOn;
  useEffect(() => {
    if (!playing) {
      return;
    }
    void activateKeepAwakeAsync(keepAwakeTag);
    return () => {
      void deactivateKeepAwake(keepAwakeTag);
    };
  }, [keepAwakeTag, playing]);

  // No background audio (reinforces the session rule; covers calls / route changes).
  const pauseAll = useCallback(() => {
    if (media.kind === "video") {
      player.pause();
    } else {
      audio.pause();
    }
  }, [audio, media, player]);
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

      {/* The scrim (operator ruling 2026-07-12): a warm near-black gradient anchored to
          the bottom edge, opaque at the very bottom (behind the tab bar) and fading to an
          imperceptible onset above the overlays — no visible start line on a light cover.
          Non-interactive so the rail below still takes every tap. */}
      <LinearGradient
        colors={SCRIM_COLORS}
        end={{ x: 0, y: 1 }}
        locations={SCRIM_LOCATIONS}
        pointerEvents="none"
        start={{ x: 0, y: 0 }}
        style={{ bottom: 0, height: scrimH, left: 0, position: "absolute", right: 0 }}
      />

      {/* Right action rail (TikTok-style): Spotify / Share / Sound. Observation discovery
          moved to the Radio tab (operator ruling 2026-07-12), so the card rail no longer
          carries it. Each control keeps ONE stable label (the Chrome Rule); the icon + the
          gold tint carry state, never the word. Every glyph renders inside a fixed 36×36
          centered box (styles.railIcon) so all three advance boxes center on the rail axis
          identically, regardless of the glyph's internal artwork — no per-glyph nudges.
          Icons carry the tight ICON_SHADOW halo; gold marks the active state (Ignition). */}
      <View style={[styles.rail, { bottom: bottomLine }]}>
        <RailAction
          icon={
            <MaterialCommunityIcons
              name="spotify"
              size={30}
              color={color.starlightCream}
              style={styles.icon}
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
          per-glyph shadow, which composes over the scrim so it reads on light footage. */}
      <View style={{ bottom: bottomLine, gap: 8, left: 16, position: "absolute", right: 96 }}>
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
  // The firm per-glyph shadow that composes over the scrim (operator ruling): every
  // caption glyph carries this warm-dark halo on top of the gradient so it reads on light
  // footage. The rail labels share it; the rail icons use the tighter ICON_SHADOW (the
  // firm one smeared into a dark blotch behind the solid glyphs — device pass).
  captionShadow: TEXT_SHADOW,
  // Rail glyphs: the tight halo, not the firm text shadow (see ICON_SHADOW). Every icon
  // renders inside the fixed 36×36 `railIcon` box, so its advance box centers on the rail
  // axis on its own — no per-glyph translateX estimates.
  icon: ICON_SHADOW,
  logId: { color: color.eclipseGold, fontSize: 13 },
  rail: { alignItems: "center", gap: 16, position: "absolute", right: 6 },
  railIcon: { alignItems: "center", height: 36, justifyContent: "center", width: 36 },
  // Wide enough for the longest stable label ("Spotify") on one line.
  railItem: { alignItems: "center", gap: 3, width: 80 },
  railLabel: {
    color: color.starlightCream,
    fontSize: 11,
    textAlign: "center",
    ...TEXT_SHADOW,
  },
  railLabelActive: { color: color.eclipseGold },
  railPressed: { opacity: 0.6 },
});
