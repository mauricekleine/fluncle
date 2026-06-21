// One finding, full-screen (RFC Unit 2). Per-cell player, the media ladder, the
// native overlay (a right action rail + bottom caption), the cover-card eclipse
// drift, and the background-pause rule. The de-risk spike target.
import { type ReactNode, useCallback, useEffect, useState } from "react";
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
import { FontAwesome, Ionicons } from "@expo/vector-icons";
import { Image } from "expo-image";
import { LinearGradient } from "expo-linear-gradient";
import { useVideoPlayer, VideoView } from "expo-video";
import { useAudioPlayer, useAudioPlayerStatus } from "expo-audio";
import { type TrackListItem } from "@fluncle/contracts";
import { resolveCardMedia } from "@/lib/media";
import { useBackgroundPause } from "@/audio/session";
import { color, font } from "@/theme/tokens";

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

export function FeedCard({ finding, active, soundOn, onToggleSound }: Props) {
  const { height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const reduced = useReducedMotion();
  const media = resolveCardMedia(finding);

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
  const [observing, setObserving] = useState(false);

  // Only the visible card plays; sound follows the global toggle. While the
  // observation plays it owns the one sound source — keep the card media silent.
  useEffect(() => {
    if (media.kind === "video") {
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
  }, [active, soundOn, media.kind, observing]);

  // The observation stops itself when the clip ends; resume nothing automatically.
  useEffect(() => {
    if (observationStatus.didJustFinish) {
      setObserving(false);
    }
  }, [observationStatus.didJustFinish]);

  // Scrolling the card away stops a playing observation (visible-card-only rule).
  useEffect(() => {
    if (!active && observing) {
      observation.pause();
      setObserving(false);
    }
  }, [active, observing]);

  const stopObservation = useCallback(() => {
    observation.pause();
    setObserving(false);
  }, [observation]);

  const toggleObservation = useCallback(() => {
    if (observing) {
      stopObservation();
      return;
    }
    player.pause();
    audio.pause();
    observation.seekTo(0);
    observation.play();
    setObserving(true);
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
      setObserving(false);
    }
  }, [media.kind, observing, observation]);
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
  }, [media.kind, reduced]);
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

      {/* legibility scrim (Legible Sky Rule): a gradient, transparent → warm dark. */}
      <LinearGradient
        pointerEvents="none"
        colors={["transparent", "rgba(9, 10, 11, 0.9)"]}
        style={{ bottom: 0, height: height * 0.6, left: 0, position: "absolute", right: 0 }}
      />

      {/* Right action rail (TikTok-style). Icons stay legible on any background via
          a drop shadow; gold marks the active sound state (Ignition). */}
      <View style={[styles.rail, { bottom: insets.bottom + 28 }]}>
        {observationUrl ? (
          <RailAction
            accessibilityLabel={observing ? "Stop the observation" : "Hear Fluncle's note"}
            active={observing}
            icon={
              <Ionicons
                name={observing ? "chatbubble-ellipses" : "chatbubble-ellipses-outline"}
                size={28}
                color={observing ? color.eclipseGold : color.starlightCream}
                style={styles.icon}
              />
            }
            label={observing ? "Playing" : "Note"}
            onPress={toggleObservation}
          />
        ) : null}
        <RailAction
          icon={
            <FontAwesome
              name="spotify"
              size={29}
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
          icon={
            <Ionicons
              name={soundOn ? "volume-high" : "volume-mute"}
              size={29}
              color={soundOn ? color.eclipseGold : color.starlightCream}
              style={styles.icon}
            />
          }
          active={soundOn}
          label={soundOn ? "Sound" : "Muted"}
          onPress={onToggleSound}
        />
      </View>

      {/* Bottom caption (narrowed to clear the rail). */}
      <View
        style={{ bottom: insets.bottom + 24, gap: 8, left: 16, position: "absolute", right: 84 }}
      >
        {finding.logId ? (
          <Text style={[font.numeric, { color: color.eclipseGlow }]}>{finding.logId}</Text>
        ) : null}
        <Text style={[font.title, { color: color.starlightCream }]} numberOfLines={2}>
          {finding.artists.join(", ")} — {finding.title}
        </Text>
        {finding.note ? (
          <Text style={[font.body, { color: color.stardust }]} numberOfLines={3}>
            {finding.note}
          </Text>
        ) : null}
        <Text style={[font.body, { color: color.stardust }]}>{foundLabel(finding.addedAt)}</Text>
      </View>
    </View>
  );
}

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
  icon: {
    textShadowColor: "rgba(0, 0, 0, 0.55)",
    textShadowOffset: { height: 1, width: 0 },
    textShadowRadius: 6,
  },
  rail: { alignItems: "center", gap: 16, position: "absolute", right: 6 },
  railIcon: { alignItems: "center", height: 36, justifyContent: "center", width: 36 },
  railItem: { alignItems: "center", gap: 3, width: 60 },
  railLabel: {
    color: color.starlightCream,
    fontSize: 11,
    textAlign: "center",
    textShadowColor: "rgba(0, 0, 0, 0.55)",
    textShadowOffset: { height: 1, width: 0 },
    textShadowRadius: 6,
  },
  railLabelActive: { color: color.eclipseGold },
  railPressed: { opacity: 0.6 },
  // The FontAwesome spotify glyph also sits left of its advance box (optical alignment).
  spotifyNudge: { transform: [{ translateX: 5 }] },
});
