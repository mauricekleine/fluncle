import { useEffect } from "react";
import { StyleSheet, View, useWindowDimensions } from "react-native";
import {
  cancelAnimation,
  Easing,
  useDerivedValue,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import {
  Canvas,
  Fill,
  FractalNoise,
  Group,
  RadialGradient,
  Rect,
  vec,
} from "@shopify/react-native-skia";
import { color } from "@/theme/tokens";

export function CosmosBackdrop() {
  const { width, height } = useWindowDimensions();
  const r = Math.max(width, height) * 0.75;
  const reduced = useReducedMotion();

  const phase = useSharedValue(reduced ? 0.5 : 0);
  useEffect(() => {
    if (reduced) {
      cancelAnimation(phase);
      phase.value = 0.5;
      return;
    }

    phase.value = withRepeat(
      withTiming(1, { duration: 24000, easing: Easing.inOut(Easing.ease) }),
      -1,
      true,
    );
    return () => cancelAnimation(phase);
  }, [phase, reduced]);

  const bloomOpacity = useDerivedValue(() => 0.78 + phase.value * 0.22);

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      <Canvas style={{ flex: 1 }}>
        <Fill color={color.deepField} />
        <Group opacity={bloomOpacity}>
          <Rect x={0} y={0} width={width} height={height}>
            <RadialGradient
              c={vec(width * 0.16, height * 0.12)}
              r={r}
              colors={["rgba(245, 184, 0, 0.13)", "rgba(245, 184, 0, 0)"]}
            />
          </Rect>
        </Group>
        <Rect x={0} y={0} width={width} height={height} opacity={0.06}>
          <FractalNoise freqX={0.9} freqY={0.9} octaves={2} seed={7} />
        </Rect>
      </Canvas>
    </View>
  );
}
