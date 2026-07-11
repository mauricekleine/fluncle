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
import { accentColor, c, coordType, font, pipHeight, pipWidth, SAFE } from "./theme";
import { type ExplainerChapter, type ExplainerClip, type TagSubFace } from "./types";

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
export const Pip: React.FC<{ screen: ExplainerClip; face: ExplainerClip }> = ({ screen, face }) => {
  const { width } = useVideoConfig();
  return (
    <AbsoluteFill>
      <Clip clip={screen} />
      <div
        style={{
          border: `2px solid ${c.eclipseGold}`,
          borderRadius: 16,
          bottom: SAFE,
          boxShadow: "0 24px 60px rgba(0,0,0,0.6)",
          height: pipHeight(width),
          overflow: "hidden",
          position: "absolute",
          right: SAFE,
          width: pipWidth(width),
        }}
      >
        <Clip clip={face} radius={14} />
      </div>
    </AbsoluteFill>
  );
};

/** Split: face beside walkthrough on wide frames, stacked (face over) when tall. */
export const Split: React.FC<{ screen: ExplainerClip; face: ExplainerClip }> = ({
  screen,
  face,
}) => {
  const { height, width } = useVideoConfig();
  const portrait = height > width;
  return (
    <AbsoluteFill style={{ flexDirection: portrait ? "column" : "row" }}>
      <div style={{ ...FILL, flex: 1 }}>
        <Clip clip={face} />
      </div>
      <div style={{ background: c.eclipseGold, ...(portrait ? { height: 2 } : { width: 2 }) }} />
      <div style={{ ...FILL, flex: 1 }}>
        <Clip clip={screen} />
      </div>
    </AbsoluteFill>
  );
};

// ---------------------------------------------------------------------------
// Surface tag (top-left) — names what you are looking at
// ---------------------------------------------------------------------------

/** The sub-line's face, per DESIGN.md §3: mono is the machine's voice and speaks
 *  only for a literal command; a coordinate is the brand's numeral (Oxanium,
 *  tabular); everything else simply reads. */
const subGlyph = (face: TagSubFace = "prose"): React.CSSProperties => {
  if (face === "command") {
    return { fontFamily: font.mono };
  }
  if (face === "coordinate") {
    return { ...coordType };
  }
  return { fontFamily: font.body };
};

export const SurfaceTag: React.FC<{ label: string; sub?: string; subFace?: TagSubFace }> = ({
  label,
  sub,
  subFace,
}) => {
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
      {/* A soft dark scrim so the tag holds AA on bright full-bleed surfaces
          (the videos panel, the galaxy) and stays invisible on the dark ones. */}
      <div
        style={{
          background: "radial-gradient(140% 160% at 0% 0%, rgba(9,10,11,0.66), transparent 72%)",
          inset: "-24px -80px -20px -40px",
          pointerEvents: "none",
          position: "absolute",
        }}
      />
      <div style={{ alignItems: "center", display: "flex", gap: 12, position: "relative" }}>
        <div style={{ background: c.eclipseGold, height: 26, width: 4 }} />
        {/* A section label ("the archive", "a finding"), not a brand mark: the
            body face at its 700 ceiling. */}
        <span
          style={{
            color: c.starlightCream,
            fontFamily: font.body,
            fontSize: 34,
            fontWeight: 700,
            letterSpacing: 1,
            textShadow: "0 2px 14px rgba(0,0,0,0.55)",
          }}
        >
          {label}
        </span>
      </div>
      {sub !== undefined ? (
        <div
          style={{
            ...subGlyph(subFace),
            color: c.stardust,
            fontSize: 22,
            marginLeft: 16,
            marginTop: 6,
            position: "relative",
            textShadow: "0 2px 12px rgba(0,0,0,0.6)",
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

export const Captions: React.FC<{ lines: ExplainerChapter["captions"]; reserveRight?: number }> = ({
  lines,
  reserveRight = 0,
}) => {
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
  // The caption is centered in the band LEFT of the picture-in-picture cam:
  // reserveRight is the cam's footprint, so long lines can never run under it.
  return (
    <div
      style={{
        bottom: SAFE,
        display: "flex",
        justifyContent: "center",
        left: SAFE,
        position: "absolute",
        right: SAFE + reserveRight,
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
          maxWidth: 1080,
          padding: "12px 22px",
          textAlign: "center",
          textWrap: "balance",
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
        {/* The act kicker is a numeral: Oxanium tabular (The Tabular Rule). */}
        {chapter.number !== undefined ? (
          <div
            style={{
              ...coordType,
              color: accent,
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
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    // Many thin angular lanes -> thin radial RAYS, not thick wedges. depth streaks
    // each ray along the radius so it reads as a light-year streak.
    float lane = floor(ang * (130.0 + fi * 44.0) + fi * 7.3);
    float depth = floor(rad * 6.0 - t * (1.0 + fi * 0.6));
    float s = hash21(vec2(lane, depth + fi * 31.0));
    // TUNING KNOB: the 0.94 threshold sets how SPARSE the rays are (higher =
    // fewer, calmer; lower = denser, more of a warp). The trailing 0.6 is the
    // per-ray brightness. This is the calm default; crank for more punch.
    streak += smoothstep(0.94, 1.0, s) * (0.3 + 0.6 * speed);
  }
  streak = clamp(streak, 0.0, 1.0);
  // Fade the streaks out at the very centre so they never converge into a white
  // bloom, and keep the crest gold (not cream) so the seam stays warm, not
  // blinding. The chapters show between the streaks: travel, not a gold wipe.
  streak *= smoothstep(0.03, 0.30, rad);
  vec3 col = mix(u_palette[1], u_palette[2], streak);
  float edge = smoothstep(0.0, 0.16, u_progress) * smoothstep(1.0, 0.84, u_progress);
  float a = streak * edge * 0.85;
  // The canvas is premultiplied-alpha: scale rgb by alpha so the gaps between the
  // rays are truly transparent (the chapters show through) instead of full gold.
  gl_FragColor = vec4(dither8(col, uv) * a, a);
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
