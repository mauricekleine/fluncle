import { memo, type ReactNode, useCallback, useEffect, useId, useMemo, useState } from "react";
import { Pressable, Share, StyleSheet, Text, View, useWindowDimensions } from "react-native";
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
import { useEvent } from "expo";
import { Image } from "expo-image";
import { useVideoPlayer, VideoView } from "expo-video";
import { useAudioPlayer, useAudioPlayerStatus } from "expo-audio";
import { LinearGradient } from "expo-linear-gradient";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import { type TrackListItem } from "@fluncle/contracts";
import { openExternalUrl } from "@/lib/open-external-url";
import { resolveCardMedia } from "@/lib/media";
import { soundRail } from "@/lib/feed-rail";
import { useBackgroundPause } from "@/audio/session";
import { color, font } from "@/theme/tokens";

export const NATIVE_TAB_BAR_HEIGHT = 49;

const START_SYNC_WINDOW_MS = 2500;

const TEXT_SHADOW = {
  textShadowColor: "rgba(9, 6, 3, 0.92)",
  textShadowOffset: { height: 1, width: 0 },
  textShadowRadius: 10,
} as const;

const SCRIM_RGB = "9, 6, 3";
const SCRIM_COLORS = [
  `rgba(${SCRIM_RGB}, 0)`,
  `rgba(${SCRIM_RGB}, 0)`,
  `rgba(${SCRIM_RGB}, 0)`,
  `rgba(${SCRIM_RGB}, 0.005)`,
  `rgba(${SCRIM_RGB}, 0.032)`,
  `rgba(${SCRIM_RGB}, 0.091)`,
  `rgba(${SCRIM_RGB}, 0.191)`,
  `rgba(${SCRIM_RGB}, 0.322)`,
  `rgba(${SCRIM_RGB}, 0.475)`,
  `rgba(${SCRIM_RGB}, 0.634)`,
  `rgba(${SCRIM_RGB}, 0.776)`,
  `rgba(${SCRIM_RGB}, 0.89)`,
  `rgba(${SCRIM_RGB}, 0.962)`,
  `rgba(${SCRIM_RGB}, 0.995)`,
  `rgba(${SCRIM_RGB}, 1)`,
] as const;
const SCRIM_LOCATIONS = [
  0, 0.071, 0.143, 0.214, 0.286, 0.357, 0.429, 0.5, 0.571, 0.643, 0.714, 0.786, 0.857, 0.929, 1,
] as const;

const RAIL_BAND = 196;

function scrimHeight(overlayTop: number, screenHeight: number): number {
  return Math.min(screenHeight, overlayTop / 0.28);
}

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

  const bottomFloor = insets.bottom + NATIVE_TAB_BAR_HEIGHT;

  const bottomLine = bottomFloor - 24;

  const scrimH = scrimHeight(bottomLine + RAIL_BAND, height);

  const media = useMemo(() => resolveCardMedia(finding), [finding]);

  const player = useVideoPlayer(media.kind === "video" ? media.videoUrl : null, (p) => {
    p.loop = true;
    p.muted = true;
    p.audioMixingMode = "mixWithOthers";
  });

  const audio = useAudioPlayer(media.previewUrl ?? null);

  const hasBed = media.previewUrl !== undefined;
  const soundControl = soundRail(soundOn);

  const { status: videoStatus } = useEvent(player, "statusChange", { status: player.status });
  const audioStatus = useAudioPlayerStatus(audio);
  const videoReady =
    media.kind !== "video" || videoStatus === "readyToPlay" || videoStatus === "error";
  const bedReady = audioStatus.isLoaded;

  const wantsBed = active && soundOn && hasBed;
  const [bedWaitElapsed, setBedWaitElapsed] = useState(false);
  useEffect(() => {
    setBedWaitElapsed(false);

    if (!wantsBed || bedReady) {
      return;
    }

    const timer = setTimeout(() => setBedWaitElapsed(true), START_SYNC_WINDOW_MS);

    return () => clearTimeout(timer);
  }, [wantsBed, bedReady, media]);

  const startVisual = active && videoReady && (!wantsBed || bedReady || bedWaitElapsed);
  const startBed = active && soundOn && hasBed && bedReady && videoReady;
  useEffect(() => {
    if (media.kind === "video") {
      if (startVisual) {
        player.play();
      } else {
        player.pause();
      }
    }
    if (media.previewUrl) {
      if (startBed) {
        audio.play();
      } else {
        audio.pause();
      }
    }
  }, [audio, media, player, startBed, startVisual]);

  const keepAwakeTag = useId();
  const playing = startBed;
  useEffect(() => {
    if (!playing) {
      return;
    }
    void activateKeepAwakeAsync(keepAwakeTag);
    return () => {
      void deactivateKeepAwake(keepAwakeTag);
    };
  }, [keepAwakeTag, playing]);

  const pauseAll = useCallback(() => {
    if (media.kind === "video") {
      player.pause();
    }
    audio.pause();
  }, [audio, media, player]);
  useBackgroundPause(pauseAll);

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
        <View style={{ flex: 1 }}>
          <VideoView
            player={player}
            style={StyleSheet.absoluteFill}
            contentFit="cover"
            nativeControls={false}
            pointerEvents="none"
          />

          {videoStatus !== "readyToPlay" ? (
            <Image
              source={media.posterUrl}
              style={StyleSheet.absoluteFill}
              contentFit="cover"
              transition={150}
              pointerEvents="none"
            />
          ) : null}
        </View>
      ) : (
        <Animated.View style={[{ flex: 1 }, coverStyle]}>
          <Image source={media.coverUrl} style={{ flex: 1 }} contentFit="cover" transition={250} />
        </Animated.View>
      )}

      <LinearGradient
        colors={SCRIM_COLORS}
        end={{ x: 0, y: 1 }}
        locations={SCRIM_LOCATIONS}
        pointerEvents="none"
        start={{ x: 0, y: 0 }}
        style={{ bottom: 0, height: scrimH, left: 0, position: "absolute", right: 0 }}
      />

      <View style={[styles.rail, { bottom: bottomLine }]}>
        <RailAction
          icon={
            <MaterialCommunityIcons
              name="spotify"
              size={30}
              color={color.starlightCream}

              style={[styles.icon, { transform: [{ translateX: 1.5 }] }]}
            />
          }
          label="Spotify"
          onPress={() => openExternalUrl(finding.spotifyUrl)}
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
          accessibilityLabel={hasBed ? soundControl.accessibilityLabel : undefined}
          disabled={!hasBed}
          icon={
            <Ionicons
              name={hasBed && soundControl.active ? "volume-high" : "volume-mute"}
              size={29}
              color={hasBed && soundControl.active ? color.eclipseGold : color.starlightCream}
              style={styles.icon}
            />
          }
          active={hasBed && soundControl.active}
          label={soundControl.label}
          onPress={onToggleSound}
        />
      </View>

      <View style={{ bottom: bottomLine, gap: 8, left: 16, position: "absolute", right: 100 }}>
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
  disabled,
  icon,
  label,
  onPress,
  active,
}: {
  accessibilityLabel?: string;
  active?: boolean;
  disabled?: boolean;
  icon: ReactNode;
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      accessibilityState={{ disabled, selected: active }}
      disabled={disabled}
      hitSlop={6}
      onPress={onPress}
      style={({ pressed }) => [
        styles.railItem,
        disabled ? styles.railDisabled : null,
        pressed ? styles.railPressed : null,
      ]}
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
  captionMeta: { alignItems: "baseline", flexDirection: "row", gap: 8 },

  captionShadow: TEXT_SHADOW,

  icon: ICON_SHADOW,
  logId: { color: color.eclipseGold, fontSize: 13 },

  rail: { alignItems: "center", gap: 16, position: "absolute", right: 12 },

  railDisabled: { opacity: 0.35 },
  railIcon: { alignItems: "center", height: 36, justifyContent: "center", width: 36 },

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
