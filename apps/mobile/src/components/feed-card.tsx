// One finding, full-screen (RFC Unit 2). Per-cell player, the media ladder, the
// native overlay (shared across rungs), the cover-card eclipse drift, and the
// background-pause rule. The de-risk spike target.
import { useCallback, useEffect } from "react";
import { Linking, Share, Text, View, useWindowDimensions } from "react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Image } from "expo-image";
import { useVideoPlayer, VideoView } from "expo-video";
import { useAudioPlayer } from "expo-audio";
import { type TrackListItem } from "@fluncle/contracts";
import { resolveCardMedia } from "@/lib/media";
import { useBackgroundPause } from "@/audio/session";
import { HeatButton } from "@/components/heat-button";
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

  // Only the visible card plays; sound follows the global toggle.
  useEffect(() => {
    if (media.kind === "video") {
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
  }, [active, soundOn, media.kind]);

  // No background audio (reinforces the session rule; covers calls / route changes).
  const pauseAll = useCallback(() => {
    if (media.kind === "video") {
      player.pause();
    } else {
      audio.pause();
    }
  }, [media.kind]);
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

      {/* legibility scrim (Legible Sky Rule) */}
      <View
        pointerEvents="none"
        style={{
          backgroundColor: "rgba(9, 10, 11, 0.55)",
          bottom: 0,
          height: height * 0.5,
          left: 0,
          position: "absolute",
          right: 0,
        }}
      />

      <View
        style={{ bottom: insets.bottom + 24, gap: 8, left: 16, position: "absolute", right: 16 }}
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

        <View style={{ flexDirection: "row", gap: 10, marginTop: 8 }}>
          <HeatButton
            label="Open in Spotify"
            variant="primary"
            onPress={() => Linking.openURL(finding.spotifyUrl)}
          />
          <HeatButton
            label="Share"
            variant="outline"
            onPress={() => Share.share({ url: finding.logPageUrl ?? finding.spotifyUrl })}
          />
          <HeatButton
            label={soundOn ? "Sound on" : "Muted"}
            variant="outline"
            onPress={onToggleSound}
          />
        </View>
      </View>
    </View>
  );
}
