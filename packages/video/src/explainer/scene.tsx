// The Explainer chrome + building blocks: the framed stage, the four layouts,
// the surface tag, burned-in captions, the chapter card, and the star-warp seam.
// The grain + transition reuse the journey shader kit so it is genuinely the
// Fluncle look, not a generic slideshow.

import {
  AbsoluteFill,
  interpolate,
  OffthreadVideo,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";

import { GLSL, ShaderLayer } from "../remotion/cosmos";
import { MockSurfacePanel } from "./surfaces";
import { accentColor, c, font, SAFE } from "./theme";
import { type ExplainerChapter, type ExplainerClip } from "./types";

// ---------------------------------------------------------------------------
// The stage — deep-field ground, a live grain wash, a vignette to seat the eye
// ---------------------------------------------------------------------------

const GRAIN_FRAGMENT = /* glsl */ `
${GLSL.hash}
void main() {
  vec2 uv = gl_FragCoord.xy / u_res;
  float g = hash21(gl_FragCoord.xy + vec2(u_time * 57.0, u_time * 31.0));
  gl_FragColor = vec4(vec3(g), 1.0);
}
`;

export const Frame: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <AbsoluteFill style={{ backgroundColor: c.deepField }}>
    {children}
    <AbsoluteFill
      style={{
        background: "radial-gradient(120% 120% at 50% 45%, transparent 52%, rgba(0,0,0,0.6) 100%)",
        pointerEvents: "none",
      }}
    />
    <ShaderLayer fragmentShader={GRAIN_FRAGMENT} blendMode="soft-light" opacity={0.42} seed={7} />
  </AbsoluteFill>
);

// ---------------------------------------------------------------------------
// Clip — real footage (OffthreadVideo over public/) or an on-brand mock
// ---------------------------------------------------------------------------

const Clip: React.FC<{ clip: ExplainerClip; radius?: number }> = ({ clip, radius = 0 }) => {
  if (clip.kind === "video") {
    return (
      <OffthreadVideo
        src={staticFile(clip.src)}
        style={{ borderRadius: radius, height: "100%", objectFit: "cover", width: "100%" }}
      />
    );
  }
  return (
    <div style={{ borderRadius: radius, height: "100%", overflow: "hidden", width: "100%" }}>
      <MockSurfacePanel kind={clip.mock} label={clip.label} />
    </div>
  );
};

// ---------------------------------------------------------------------------
// Layouts
// ---------------------------------------------------------------------------

const FILL: React.CSSProperties = { height: "100%", width: "100%" };

export const TalkingHead: React.FC<{ face: ExplainerClip }> = ({ face }) => (
  <AbsoluteFill>
    <Clip clip={face} />
  </AbsoluteFill>
);

export const ScreenFull: React.FC<{ screen: ExplainerClip }> = ({ screen }) => (
  <AbsoluteFill>
    <Clip clip={screen} />
  </AbsoluteFill>
);

/** Picture-in-picture: the surface fills, the face sits cornered in a gold-hairline frame. */
export const Pip: React.FC<{ screen: ExplainerClip; face: ExplainerClip }> = ({ screen, face }) => (
  <AbsoluteFill>
    <Clip clip={screen} />
    <div
      style={{
        border: `2px solid ${c.eclipseGold}`,
        borderRadius: 16,
        bottom: SAFE,
        boxShadow: "0 24px 60px rgba(0,0,0,0.6)",
        height: 300,
        overflow: "hidden",
        position: "absolute",
        right: SAFE,
        width: 480,
      }}
    >
      <Clip clip={face} radius={14} />
    </div>
  </AbsoluteFill>
);

export const Split: React.FC<{ screen: ExplainerClip; face: ExplainerClip }> = ({
  screen,
  face,
}) => (
  <AbsoluteFill style={{ flexDirection: "row" }}>
    <div style={{ ...FILL, flex: 1 }}>
      <Clip clip={face} />
    </div>
    <div style={{ background: c.eclipseGold, width: 2 }} />
    <div style={{ ...FILL, flex: 1 }}>
      <Clip clip={screen} />
    </div>
  </AbsoluteFill>
);

// ---------------------------------------------------------------------------
// Surface tag (top-left) — names what you are looking at
// ---------------------------------------------------------------------------

export const SurfaceTag: React.FC<{ label: string; sub?: string }> = ({ label, sub }) => {
  const frame = useCurrentFrame();
  const x = interpolate(frame, [0, 12], [-40, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const opacity = interpolate(frame, [0, 12], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return (
    <div
      style={{
        left: SAFE,
        opacity,
        position: "absolute",
        top: SAFE,
        transform: `translateX(${x}px)`,
      }}
    >
      <div style={{ alignItems: "center", display: "flex", gap: 12 }}>
        <div style={{ background: c.eclipseGold, height: 26, width: 4 }} />
        <span
          style={{
            color: c.starlightCream,
            fontFamily: font.display,
            fontSize: 34,
            letterSpacing: 1,
          }}
        >
          {label}
        </span>
      </div>
      {sub !== undefined ? (
        <div
          style={{
            color: c.stardust,
            fontFamily: font.mono,
            fontSize: 22,
            marginLeft: 16,
            marginTop: 6,
          }}
        >
          {sub}
        </div>
      ) : null}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Captions — burned in for silent autoplay; the active line only
// ---------------------------------------------------------------------------

export const Captions: React.FC<{ lines: ExplainerChapter["captions"] }> = ({ lines }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  if (lines === undefined) {
    return null;
  }
  const ms = (frame / fps) * 1_000;
  const active = lines.find((l) => ms >= l.fromMs && ms < l.toMs);
  if (active === undefined) {
    return null;
  }
  return (
    <div
      style={{
        bottom: SAFE,
        display: "flex",
        justifyContent: "center",
        left: 0,
        position: "absolute",
        width: "100%",
      }}
    >
      <span
        style={{
          WebkitBoxDecorationBreak: "clone",
          background: "rgba(9,10,11,0.72)",
          borderRadius: 12,
          boxDecorationBreak: "clone",
          color: c.starlightCream,
          fontFamily: font.body,
          fontSize: 46,
          fontWeight: 600,
          lineHeight: 1.4,
          maxWidth: 1240,
          padding: "12px 22px",
          textAlign: "center",
        }}
      >
        {active.text}
      </span>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Chapter card — the big Oxanium title flash
// ---------------------------------------------------------------------------

export const ChapterCard: React.FC<{ chapter: ExplainerChapter }> = ({ chapter }) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const rise = interpolate(frame, [0, 10], [26, 0], { extrapolateRight: "clamp" });
  const opacity = interpolate(
    frame,
    [0, 8, durationInFrames - 10, durationInFrames],
    [0, 1, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );
  const accent = accentColor(chapter.accent);
  return (
    <AbsoluteFill
      style={{
        alignItems: "flex-start",
        background: c.deepField,
        flexDirection: "column",
        justifyContent: "center",
        opacity,
        paddingLeft: SAFE * 1.4,
      }}
    >
      <div style={{ transform: `translateY(${rise}px)` }}>
        {chapter.number !== undefined ? (
          <div
            style={{
              color: accent,
              fontFamily: font.mono,
              fontSize: 30,
              letterSpacing: 6,
              marginBottom: 18,
            }}
          >
            {`ACT ${chapter.number}`}
          </div>
        ) : null}
        <div
          style={{
            color: c.starlightCream,
            fontFamily: font.display,
            fontSize: 110,
            lineHeight: 1.02,
          }}
        >
          {chapter.title}
        </div>
        {chapter.subtitle !== undefined ? (
          <div style={{ color: c.stardust, fontFamily: font.body, fontSize: 40, marginTop: 22 }}>
            {chapter.subtitle}
          </div>
        ) : null}
        <div style={{ background: accent, height: 4, marginTop: 34, width: 180 }} />
      </div>
    </AbsoluteFill>
  );
};

// ---------------------------------------------------------------------------
// Smear transition — a directioned star-warp over the seam (travel, not a fade).
// Adapted from the set-video TravelTransition; progress is sequence-relative.
// ---------------------------------------------------------------------------

const TRANSITION_FRAGMENT = /* glsl */ `
${GLSL.hash}
void main() {
  vec2 uv = gl_FragCoord.xy / u_res;
  vec2 p = (gl_FragCoord.xy - 0.5 * u_res) / u_res.y;
  float speed = sin(u_progress * 3.14159265);
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
  vec3 col = mix(u_palette[1], u_palette[2], streak);
  col = mix(col, u_palette[3], streak * speed * 0.6);
  float edge = smoothstep(0.0, 0.14, u_progress) * smoothstep(1.0, 0.86, u_progress);
  gl_FragColor = vec4(dither8(col, uv), streak * edge);
}
`;

export const SmearTransition: React.FC<{ seed: number }> = ({ seed }) => {
  const stops: [string, string, string, string] = [
    c.deepField,
    c.eclipseGold,
    c.eclipseGlow,
    c.starlightCream,
  ];
  return <ShaderLayer fragmentShader={TRANSITION_FRAGMENT} paletteStops={stops} seed={seed} />;
};
