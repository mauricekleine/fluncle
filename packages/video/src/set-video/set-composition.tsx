import { type FC } from "react";
import {
  AbsoluteFill,
  type CalculateMetadataFunction,
  interpolate,
  Sequence,
  Series,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { colors } from "@fluncle/tokens";

import { FloatingType, GLSL, type NostalgicCosmosProps, ShaderLayer } from "../remotion/cosmos";

export type SetChapterSpec = {
  logId: string;

  startMs: number;

  durationMs: number;

  props: NostalgicCosmosProps;
};

export type SetCompositionProps = {
  chapters: SetChapterSpec[];
  fps: number;

  mixtape: { logId: string; title: string };

  continuity: { energy: number[]; hopMs: number };

  hideOverlay: true;
};

const framesOf = (ms: number, fps: number): number => Math.max(1, Math.round((ms / 1000) * fps));

export const calculateSetMetadata: CalculateMetadataFunction<SetCompositionProps> = ({ props }) => {
  const fps = props.fps || 30;
  const durationInFrames = props.chapters.reduce(
    (sum, ch) => sum + framesOf(ch.durationMs, fps),
    0,
  );
  return { durationInFrames: Math.max(1, durationInFrames), fps, height: 1080, width: 1920 };
};

const chapterContext = import.meta.webpackContext("../remotion/set-workbench", {
  recursive: false,
  regExp: /\.tsx$/,
});

const chapterComponents: Record<string, FC<NostalgicCosmosProps>> = {};
for (const key of chapterContext.keys()) {
  const mod = chapterContext(key);
  const candidate = mod.default ?? Object.values(mod).find((v) => typeof v === "function");
  if (typeof candidate === "function") {
    const id = key.replace(/^\.\//, "").replace(/\.tsx$/, "");
    chapterComponents[id] = candidate as FC<NostalgicCosmosProps>;
  }
}

const HoldingFill: FC<{ background: string }> = ({ background }) => (
  <AbsoluteFill style={{ backgroundColor: background }} />
);

const TRANSITION_MS = 1_400;

const TRANSITION_FRAGMENT = `
${GLSL.hash}

// A radial star-warp: streaks stream outward from centre, accelerating then easing
// over u_progress (0->1 across the transition window). Alpha is the streak itself,
// so the chapters show THROUGH the gaps (travel between worlds, not a crossfade).
void main() {
  vec2 uv = gl_FragCoord.xy / u_res;
  vec2 p = (gl_FragCoord.xy - 0.5 * u_res) / u_res.y;
  float speed = sin(u_progress * 3.14159265);        // 0 -> 1 -> 0 (blooms in, eases out)
  float t = u_time * (0.5 + 3.0 * speed);
  float ang = atan(p.y, p.x);
  float rad = length(p);

  float streak = 0.0;
  for (int i = 0; i < 4; i++) {
    float fi = float(i);
    float lane = floor(ang * (16.0 + fi * 8.0) + fi * 7.3);
    float depth = floor(rad * 5.0 - t * (1.0 + fi * 0.6));
    float s = hash21(vec2(lane, depth + fi * 31.0));
    streak += smoothstep(0.86, 1.0, s) * (0.35 + 0.65 * speed);
  }
  streak = clamp(streak, 0.0, 1.0);

  // Both neighbours' worlds carried in the palette: cool ground -> outgoing glow ->
  // incoming glow -> cream crest, so the streaks read as travel between two skies.
  vec3 col = mix(u_palette[1], u_palette[2], streak);
  col = mix(col, u_palette[3], streak * speed * 0.6);

  float edge = smoothstep(0.0, 0.14, u_progress) * smoothstep(1.0, 0.86, u_progress);
  float a = streak * edge;
  // The ShaderLayer canvas is premultiplied-alpha: scale rgb by alpha so the gaps
  // between the streaks are truly transparent (the chapters travel THROUGH) rather
  // than washing the seam with the palette color.
  gl_FragColor = vec4(dither8(col, uv) * a, a);
}
`;

const TravelTransition: FC<{ from: SetChapterSpec; to: SetChapterSpec }> = ({ from, to }) => {
  const stops: [string, string, string, string] = [
    from.props.palette.background,
    from.props.palette.glow ?? from.props.palette.accent,
    to.props.palette.glow ?? to.props.palette.accent,
    to.props.palette.ink,
  ];
  return (
    <ShaderLayer fragmentShader={TRANSITION_FRAGMENT} paletteStops={stops} seed={to.props.seed} />
  );
};

const TYPE_MOMENT_MS = 6_000;
const MARGIN = 84;

const useMomentEnvelope = (): number => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const sec = frame / fps;
  const hold = TYPE_MOMENT_MS / 1000;
  return interpolate(sec, [0, 0.8, hold - 0.9, hold], [0, 1, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
};

const SetTypePlate: FC<{ chapter: SetChapterSpec }> = ({ chapter }) => {
  const opacity = useMomentEnvelope();
  const { track, palette } = chapter.props;
  if (opacity <= 0.001) {
    return null;
  }
  const ink = palette.ink || colors.starlightCream;
  const dim = colors.stardust;
  return (
    <AbsoluteFill style={{ opacity }}>
      <div
        style={{
          bottom: 96,
          display: "flex",
          flexDirection: "column",
          gap: 10,
          left: MARGIN,
          position: "absolute",
        }}
      >
        <FloatingType variant="trackLine" track={track} fontSize={44} color={ink} drift={4} />
      </div>

      <div
        style={{
          alignItems: "flex-end",
          display: "flex",
          flexDirection: "column",
          gap: 8,
          position: "absolute",
          right: MARGIN,
          top: 72,
        }}
      >
        <FloatingType
          variant="meta"
          track={track}
          fontSize={26}
          color={dim}
          align="right"
          drift={3}
        />
        {track.logId ? (
          <FloatingType
            variant="logId"
            track={track}
            fontSize={22}
            color={dim}
            align="right"
            drift={3}
          />
        ) : null}
      </div>
    </AbsoluteFill>
  );
};

const ContinuityLayer: FC<{ continuity: SetCompositionProps["continuity"] }> = ({ continuity }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const ms = (frame / fps) * 1000;
  const idx = Math.min(
    continuity.energy.length - 1,
    Math.max(0, Math.floor(ms / Math.max(1, continuity.hopMs))),
  );
  const energy = continuity.energy[idx] ?? 0.5;

  const weight = 0.06 + (1 - Math.min(1, energy)) * 0.18;
  return (
    <AbsoluteFill
      style={{
        background: `radial-gradient(ellipse 120% 120% at 50% 48%, rgba(0,0,0,0) 42%, ${colors.deepField} 100%)`,
        opacity: weight,
        pointerEvents: "none",
      }}
    />
  );
};

const CLOSE_MS = 7_000;

const SetCloseCard: FC<{ mixtape: SetCompositionProps["mixtape"] }> = ({ mixtape }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const sec = frame / fps;
  const progress = interpolate(sec, [0, (CLOSE_MS / 1000) * 0.85], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const revealCoord = interpolate(progress, [0, 0.5], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const revealSign = interpolate(progress, [0.35, 1], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return (
    <AbsoluteFill>
      <div
        style={{
          bottom: 120,
          display: "flex",
          flexDirection: "column",
          gap: 18,
          left: MARGIN,
          position: "absolute",
        }}
      >
        <div style={{ opacity: revealCoord, transform: `translateY(${(1 - revealCoord) * 18}px)` }}>
          <FloatingType
            variant="body"
            text="Drum & bass bangers from another dimension"
            fontSize={26}
            color={colors.starlightCream}
            drift={4}
          />
        </div>
        <div style={{ opacity: revealCoord, transform: `translateY(${(1 - revealCoord) * 16}px)` }}>
          <FloatingType
            variant="logId"
            track={{ artists: [], discoveredAt: "", logId: mixtape.logId, title: "" }}
            fontSize={40}
            drift={3}
          />
        </div>
        <div style={{ opacity: revealSign, transform: `translateY(${(1 - revealSign) * 22}px)` }}>
          <FloatingType variant="brandMark" mark="selected by Fluncle" fontSize={54} drift={5} />
        </div>
      </div>
    </AbsoluteFill>
  );
};

export const SetComposition: FC<SetCompositionProps> = ({ chapters, fps, mixtape, continuity }) => {
  const starts: number[] = [];
  let acc = 0;
  for (const ch of chapters) {
    starts.push(acc);
    acc += framesOf(ch.durationMs, fps);
  }
  const totalFrames = acc;
  const closeFrames = framesOf(CLOSE_MS, fps);
  const transitionFrames = framesOf(TRANSITION_MS, fps);

  return (
    <AbsoluteFill style={{ backgroundColor: colors.deepField }}>
      <Series>
        {chapters.map((ch) => {
          const Comp = chapterComponents[ch.logId];
          return (
            <Series.Sequence key={ch.logId} durationInFrames={framesOf(ch.durationMs, fps)}>
              {Comp ? (
                <Comp {...ch.props} />
              ) : (
                <HoldingFill background={ch.props.palette.background} />
              )}
            </Series.Sequence>
          );
        })}
      </Series>

      <ContinuityLayer continuity={continuity} />

      {chapters.map((ch, i) => {
        if (i === 0) {
          return null;
        }
        const prev = chapters[i - 1];
        const start = starts[i] ?? 0;
        const from = Math.max(0, start - Math.round(transitionFrames / 2));
        return prev ? (
          <Sequence key={`t-${ch.logId}`} from={from} durationInFrames={transitionFrames}>
            <TravelTransition from={prev} to={ch} />
          </Sequence>
        ) : null;
      })}

      {chapters.map((ch, i) => (
        <Sequence
          key={`type-${ch.logId}`}
          from={starts[i] ?? 0}
          durationInFrames={framesOf(TYPE_MOMENT_MS, fps)}
        >
          <SetTypePlate chapter={ch} />
        </Sequence>
      ))}

      <Sequence from={Math.max(0, totalFrames - closeFrames)} durationInFrames={closeFrames}>
        <SetCloseCard mixtape={mixtape} />
      </Sequence>
    </AbsoluteFill>
  );
};
