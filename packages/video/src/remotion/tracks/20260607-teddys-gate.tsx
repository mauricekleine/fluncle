// "TeddysGate" — the GLASS vehicle scene for Whiney, LaMeduza — "Teddy's Gate"
// (185 BPM liquid drum & bass on Hospital Records; analysed window from startMs
// 9950 catching a rolling breakdown that gives way to a gated back half).
//
// ARCHIVE NOTE: a dated, self-contained archive composition. It imports ONLY the
// surviving core (ShaderLayer, GLSL, CloseCard, FloatingType, Starfield, Grain,
// the audio hooks, color helpers, tokens, remotion, react) and authors its own
// scene + GLSL shader top to bottom. Deterministic: frame-/seed-/curve-derived
// only, so it re-renders identically forever.
//
// VEHICLE: the GLASS gate (the One Vehicle, doctrine 1). A wall of vertical
// liquid-glass blades forms a sealed portal down the centre of the frame,
// refracting the warm-dark cosmos behind them with a wet gel falloff per rib.
// The track is literally named "Teddy's Gate", and the energy curve is a gate:
// a held liquid roller for the first ~12s, then a relentless gated back half
// where the music slams open and shut. So the vehicle IS that gate — the blades
// PART on each energy spike, light floods the central aperture, then they snap
// closed; the supreme opening lands on the absolute energy peak (1.0) at 18.85s
// (~clip 0.94). It is on screen and holding centre from frame one (Always-Visible
// Vehicle): a dim, sealed, refracting curtain, never a late reveal.
//
// ONE SUN, through the vehicle (doctrine 1): there is no second celestial body.
// The single Eclipse Gold moment is the gold light pouring through the OPENED
// gate seam — one hot gold specular bulge at the central aperture that ignites
// only when the gate is thrown wide on the drop. Blades stay Starlight Cream;
// gold lives only in the opening (~10% of the frame, the One Sun Rule).
//
// TEXTURE FAMILY: fluent (MOODBOARD liquid-blade-curtain-rgb.webp + the liquid
// D&B descriptor). Dense film grain over flowing liquid gel, retinted to canon:
// cream blades on warm dark, one gold bulge. The RGB of the reference is dropped.
//
// CONCEPT (two sentences): a sealed wall of liquid-glass blades breathes shut
// over the warm-dark cosmos through the rolling first half, the gate held closed
// and refracting. As the gated back half hits, the blades are wrenched apart on
// each energy spike and Eclipse Gold floods the central seam, the supreme opening
// landing on the 18.85s peak before the gate eases to a held-open arrival and the
// close card settles.
//
// RESEARCH -> PIXELS: "Hospital Records" is rendered as a verified label line
// (Beatport, https://www.beatport.com/release/teddys-gate/3245591). The "liquid
// D&B" descriptor drove the wet liquid-gel blade surface and the slow refracting
// breath; the gate in the track name + the gated energy curve drove the whole
// open/shut vehicle; the absolute energy peak at 18.85s drove the supreme gold
// opening + the close timing.
//
// Determinism: frame-/seed-/curve-derived only (useCurrentFrame/fps, the audio.*
// curves, the journey clock). GPU shaders render via ANGLE/Metal (pass
// --gl=angle; the pipeline sets it by default). Grain + Retint are baked at the
// GPU level in the gate shader; the CSS <Grain /> rides as the system base
// texture over the whole frame.

import { colors } from "@fluncle/tokens";
import {
  AbsoluteFill,
  Audio,
  interpolate,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import {
  CloseCard,
  FloatingType,
  GLSL,
  Grain,
  ShaderLayer,
  Starfield,
  useBass,
  useBeat,
  useEnergy,
  useJourney,
  useOnset,
  withAlpha,
} from "../cosmos";
import { type NostalgicCosmosProps } from "../types";

// Safe margins (README): keep all type inside this inset on 1080x1920.
const MARGIN_X = 96;
const SAFE_TOP = 150;
const SAFE_BOTTOM = 230;

// Journey split: a generous travel where the gate works the back-half drops, a
// long arrive for the held-open close. The supreme peak (energy=1.0) sits at
// 18.85s of the 20s window (~clip 0.94), late in travel/early arrive, so the
// gate's biggest opening and the close reveal overlap.
const SPLIT: [number, number] = [0.12, 0.86];

// Scene type beats in seconds (placement + timing are the grammar; intensity
// rides the audio). Deliberately NOT the same spots/times as the recent batch:
// the artist mark opens upper-centre over the sealed gate, the label fact rides
// the first gated hits in the lower third, the track line lands as the gate
// opens wide, the date trails it, and the close arrives held-open.
const T = {
  artistIn: 0.4,
  artistOut: 6.4,
  labelIn: 6.0,
  labelOut: 11.4,
  metaIn: 12.6,
  metaOut: 16.2,
  trackIn: 11.6,
  trackOut: 16.4,
};

// The supreme drop window: the energy curve peaks at 1.0 at 18.85s of the 20s
// clip, with a major hit at 12.0s opening the gated section. Expressed in clip
// progress (0..1). Used only for a slow envelope; the per-spike gate opening is
// driven by instantaneous energy so EVERY gated hit parts the blades.
const GATE_SECTION_IN = 11.7 / 20; // the gated back half begins
const SUPREME_IN = 18.5 / 20;
const SUPREME_OUT = 18.95 / 20;

// === THE GLASS GATE shader ==================================================
// One ShaderLayer renders the whole vehicle: a wall of vertical liquid-glass
// blades over a warm-dark refracted cosmos, with a central aperture that the
// music throws open. Everything is baked in one fragment shader (the preferred
// GPU path): the refracted background field, the per-blade wet gel ribs, the
// opening seam, the gold light pouring through the open gate, grain, vignette,
// and the banding-killing dither.
//
// Quad law (doctrine 6): this layer fills the frame and IS the scene background,
// so it is fully opaque everywhere (alpha 1.0) with no transparent quad bounds
// to leak — there is no rectangle to print because the layer legitimately covers
// the whole frame. (The gold opening is an additive glow INSIDE the frame, not a
// separate quad.)
const GATE_FRAG = /* glsl */ `
uniform float u_open;     // 0..1 how far the gate is thrown open (drives the seam + gold)
uniform float u_seal;     // 0..1 sealed-breath of the closed blades (high in the roller)
uniform float u_warp;     // refraction strength of the liquid blades
uniform float u_goldHot;  // 0..1 extra heat on the gold pouring through the opening

${GLSL.hash}
${GLSL.valueNoise}
${GLSL.fbm}
${GLSL.paletteRamp}
${GLSL.filmGrain}
${GLSL.vignette}

// One liquid-glass blade ribbon: returns a wet gel brightness 0..1 for a given
// horizontal position within a blade cell (bx in -1..1) plus a slow vertical
// flow so the blade reads as liquid, not a flat slat.
float bladeGel(float bx, float flow) {
  // Rounded specular profile across the rib: bright wet centre, dark edges where
  // neighbouring blades meet. pow sharpens it into a glassy highlight.
  float across = 1.0 - abs(bx);
  float spec = pow(clamp(across, 0.0, 1.0), 2.2);
  // The wet highlight crawls vertically with the liquid flow so the gel runs.
  float run = 0.5 + 0.5 * sin(flow * 6.2831853);
  return spec * (0.55 + 0.45 * run);
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_res;
  // Aspect-correct x around centre so blades are vertical and evenly spaced
  // regardless of the 9:16 frame.
  float aspect = u_res.x / u_res.y;
  vec2 c = uv - 0.5;
  c.x *= aspect;

  // --- The refracted cosmos behind the glass -------------------------------
  // A slow two-layer fbm haze (the warm-dark night the gate stands in), warped
  // by the blade displacement so it reads as the cosmos seen THROUGH wet glass.
  // Kept LOW through the ramp so the background stays a deep warm cloud and the
  // gold opening is always the brightest thing (the One Sun).
  float bladeFreq = 9.0;                       // number of blades across
  float cell = c.x * bladeFreq;                // blade space
  float bx = fract(cell) * 2.0 - 1.0;          // -1..1 within a blade
  float flow = uv.y * 1.6 - u_time * 0.18;     // liquid runs down each blade
  // Refraction: bend the background sample by the blade's local slope (bx) and a
  // slow liquid wobble, scaled by u_warp so the breath of the blades distorts
  // the cosmos behind them.
  float wobble = (valueNoise(vec2(cell * 0.6, flow)) - 0.5) * 2.0;
  vec2 refr = uv + vec2(bx * 0.035 + wobble * 0.012, 0.0) * u_warp;
  vec2 q = (refr - 0.5);
  q.x *= aspect;
  float warpField = fbm(q * 1.4 + vec2(0.0, u_time * 0.03), 4);
  float field = fbm(q * 2.2 + warpField * 0.6 + vec2(u_time * 0.018, u_seed * 0.7), 6);
  float bg = field * field * 0.16 + (1.0 - uv.y) * (0.03 + u_energy * 0.03);
  vec3 col = paletteRamp(clamp(bg, 0.0, 0.30));

  // --- The central aperture (the gate opening) -----------------------------
  // A vertical gap down the middle. When the gate is shut (u_open ~ 0) the gap is
  // hairline; on a drop (u_open -> 1) it widens. Blades to the LEFT of the gap
  // slide left, blades to the RIGHT slide right, so the gate physically parts.
  // The opening is kept NARROW (max half-width ~0.12) so the gold pouring through
  // it stays ~10% of the frame (the One Sun Rule) and never floods the whole shot.
  float halfGap = mix(0.004, 0.115, u_open);   // half-width of the opening in c.x space
  float side = sign(c.x);
  // Push blade space outward from the centre by the gap so the curtain opens.
  float openShift = side * halfGap * bladeFreq;
  float cellO = (c.x * bladeFreq) - openShift;
  float bxO = fract(cellO) * 2.0 - 1.0;
  // A blade only exists OUTSIDE the gap; inside the gap there is no glass.
  float outsideGap = step(halfGap, abs(c.x));

  // --- The liquid-glass blades ---------------------------------------------
  // Cream wet gel ribs, present from frame one (the sealed curtain). A subtle
  // sealed-breath (u_seal) brightens the closed blades so the shut gate still
  // shimmers in the roller. Blades are STARLIGHT CREAM glass — never gold; gold is
  // reserved entirely for the opening (the One Sun). So they are coloured by a
  // direct deep-field -> cream lerp that BYPASSES the gold ramp stop, keeping the
  // curtain a cool inky cream rather than a wall of amber bars.
  float gel = bladeGel(bxO, flow) * outsideGap;
  // Sealed breath: a slow swell across the whole curtain when the gate is shut.
  float breath = 0.5 + 0.5 * sin(u_time * 0.7 + uv.y * 2.0);
  float bladeLum = gel * (0.30 + u_seal * 0.24 * breath + u_energy * 0.10);
  // Cream glass: warm-dark in the body, only the wettest highlight climbs toward
  // cream. Kept dim (max ~0.5) so the curtain reads inky, not white, and the frame
  // stays a warm dark with the opening the brightest thing.
  vec3 creamGlass = mix(u_palette[0], u_palette[3], clamp(bladeLum * 1.05, 0.0, 0.5));
  vec3 bladeCol = creamGlass;
  // Thin dark seams between blades (where ribs meet) keep them reading as glass.
  float seam = smoothstep(0.92, 1.0, abs(bxO)) * outsideGap;
  bladeCol *= (1.0 - seam * 0.5);
  // Composite blades over the refracted cosmos.
  col = mix(col, bladeCol, clamp(bladeLum * 1.5, 0.0, 1.0) * outsideGap);

  // --- THE ONE SUN: gold light pouring through the OPEN gate ----------------
  // Inside the aperture the warm-dark cosmos shows through, lit from beyond by a
  // single Eclipse Gold source. This is the ONLY gold in the frame and it only
  // blazes when the gate is open (u_open) — the One Sun moment expressed THROUGH
  // the vehicle, never a second body. A tall thin hot slit, brightest at the seam
  // centre, falling off to the blade edges and concentrated in the upper-middle so
  // the lower-third type stays legible (the gold does not flood the bottom).
  float gap = 1.0 - smoothstep(0.0, halfGap, abs(c.x)); // 1 at centre, 0 at blade edge
  // Vertical shaping: the glow column peaks just above centre and falls off toward
  // the top and (hard) toward the bottom third where the track line + close sit.
  float vy = uv.y - 0.46;
  float columnV = exp(-vy * vy * 7.0) * smoothstep(-0.42, -0.18, uv.y - 0.5 + 0.5);
  // Keep gold out of the bottom ~30% so type holds AA over it.
  columnV *= smoothstep(0.30, 0.46, uv.y);
  float column = gap * columnV;
  // The gold strengthens with how open the gate is and the drop heat, scaled DOWN
  // so even the supreme opening keeps gold to roughly a tenth of the frame.
  float goldAmt = column * u_open * (0.35 + u_goldHot * 0.55);
  // Hot core -> a cream-hot sliver only at the very centre of the slit.
  vec3 gold = mix(u_palette[2], u_palette[3], smoothstep(0.75, 1.0, gap) * 0.45);
  col += gold * goldAmt;
  // A faint warm bleed of the gold spilling onto the inner blade edges (light
  // catching the wet glass nearest the opening), kept tight and upper-middle.
  float spill = smoothstep(halfGap + 0.09, halfGap, abs(c.x)) * u_open * 0.4 * columnV;
  col += u_palette[2] * spill * (0.25 + u_goldHot * 0.4) * gel;

  // --- Finish: vignette toward warm dark, organic grain, dither ------------
  col *= mix(0.30, 1.0, vignette(uv, 0.98, 0.85));
  col = filmGrain(col, uv, u_time, 0.12);
  // Fully opaque: this layer IS the scene background, covering the whole frame
  // (no transparent quad bounds to leak a rectangle).
  gl_FragColor = vec4(dither8(col, uv), 1.0);
}
`;

export const TeddysGate: React.FC<NostalgicCosmosProps> = ({ track, audio, palette, seed }) => {
  const { fps, durationInFrames } = useVideoConfig();

  // Shared narrative clock.
  const { arc, phase, phaseProgress, progress } = useJourney({ split: SPLIT });

  // Audio-reactive scalars.
  const energy = useEnergy(audio.energyCurve, { smoothingFrames: 4 });
  const bass = useBass(audio.bassCurve, { smoothingFrames: 3 });
  const { pulse } = useBeat(audio.beatGrid, { decay: 3.4 });
  const onset = useOnset(audio.onsets, 130);

  // The gated back half: a slow envelope that lets the gate "want" to open once
  // the rolling intro has passed. Frame-derived. In the first half this stays 0,
  // so the gate breathes shut (the roller); after ~11.7s it rises and the
  // instantaneous energy spikes can throw the blades wide.
  const gateSection = interpolate(progress, [GATE_SECTION_IN, GATE_SECTION_IN + 0.06], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // The supreme opening: a localized boost across the 18.85s peak so the biggest
  // gold flood lands exactly on energy=1.0.
  const supreme = interpolate(progress, [SUPREME_IN, SUPREME_OUT], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // How far the gate is thrown open. Driven by instantaneous energy so EVERY
  // gated hit physically parts the blades, gated up by the back-half envelope so
  // the rolling intro keeps the gate shut. The supreme peak forces it wide. A
  // beat kick gives each opening a snap. Capped below 1 except on the supreme so
  // the gap never blows out the whole frame.
  const openRaw = gateSection * (energy * 0.9 + pulse * 0.12 * energy) + supreme * 0.5;
  const open = Math.min(1, openRaw);

  // Sealed-breath of the closed curtain: strong in the roller (low gate section),
  // fading as the gate starts working. A floor keeps the shut gate alive.
  const seal = Math.max(0.25, 1 - gateSection * 0.7);

  // Refraction strength: the blades distort the cosmos more on the bass swell so
  // the wet glass breathes with the sub.
  const warp = 0.7 + bass * 0.7 + open * 0.4;

  // Extra heat on the gold pouring through the open gate: rides the drop so the
  // single gold moment burns hottest on the peak. Floored to nothing in the
  // intro so the only gold ever seen is in the opened gate.
  const goldHot = Math.min(1, open * (0.5 + energy * 0.6) + supreme * 0.4);

  // Starfield drift opens with energy; the cosmos breathes, never scrolls
  // (doctrine 7: positional drift monotonic, audio drives speed/brightness only).
  const driftBoost = 1 + energy * 1.4;
  const floatBoost = 1 + energy * 0.6;

  // Onset = a brief gold exposure spike in the opening + a grain kick. Gated by
  // how open the gate is so the intro stays quiet and the gated hits spark.
  const exposure = onset * 0.12 * (0.2 + open * 0.8);
  const grainKick = onset * 0.06;

  // The gate shader rides the CANON warm ramp regardless of the artwork (the
  // Warm Dark Rule). Teddy's Gate artwork is near-monochrome greys, so there is
  // no artwork hue to admit; the ramp is the canon Deep Field -> Re-entry Red ->
  // Eclipse Gold -> Starlight Cream. This keeps gold the single sun.
  const gateStops: [string, string, string, string] = [
    colors.deepField,
    colors.reentryRed,
    colors.eclipseGold,
    colors.starlightCream,
  ];

  return (
    <AbsoluteFill style={{ backgroundColor: palette.background || colors.deepField }}>
      {/* Audio: the analysed clip, trimmed to the window via startFrom. */}
      <Audio
        src={staticFile(audio.file)}
        startFrom={Math.round((audio.startMs / 1000) * fps)}
        endAt={Math.round((audio.startMs / 1000) * fps) + durationInFrames}
      />

      {/* THE ONE VEHICLE: the glass gate. Present and holding centre from frame
          one (Always-Visible Vehicle) — a sealed, refracting liquid-glass curtain
          in the roller, thrown open on each gated hit with Eclipse Gold pouring
          through the seam (the One Sun, through the vehicle). Grain + Retint baked
          in-shader (the preferred GPU grain). */}
      <AbsoluteFill>
        <ShaderLayer
          fragmentShader={GATE_FRAG}
          paletteStops={gateStops}
          seed={(seed % 9973) + 1}
          energyCurve={audio.energyCurve}
          bassCurve={audio.bassCurve}
          beatGrid={audio.beatGrid}
          beatDecay={3.4}
          uniforms={{
            u_goldHot: goldHot,
            u_open: open,
            u_seal: seal,
            u_warp: warp,
          }}
        />
      </AbsoluteFill>

      {/* Starfield over the gate: drifts faster as energy lifts. Always there,
          subtle, behind the glass haze. */}
      <Starfield
        seed={seed}
        density={110}
        depth={3}
        drift={{ x: 0.003 * driftBoost, y: -0.009 * driftBoost }}
        maxSize={2.3}
        twinkle={0.4}
      />

      {/* Onset exposure spike: a brief additive gold veil centred on the gate
          seam, gated up by how open the gate is so it only sparks on the hits. */}
      {exposure > 0.001 ? (
        <AbsoluteFill
          style={{
            background: `radial-gradient(40% 70% at 50% 50%,
              ${withAlpha(colors.eclipseGlow, exposure)} 0%,
              ${withAlpha(colors.eclipseGold, 0)} 60%)`,
            mixBlendMode: "screen",
            pointerEvents: "none",
          }}
        />
      ) : null}

      {/* Lower scrim: a warm-dark pane seating all the bottom-third type so it
          holds AA over the gate (The Legible Sky Rule — make the pane more
          opaque, never the text dimmer). A one-direction gradient toward Deep
          Field so it reads as the night deepening at the bottom. */}
      <AbsoluteFill
        style={{
          background: `linear-gradient(180deg,
            ${withAlpha(colors.deepField, 0)} 50%,
            ${withAlpha(colors.deepField, 0.55)} 78%,
            ${withAlpha(colors.deepField, 0.84)} 100%)`,
          pointerEvents: "none",
        }}
      />

      {/* --- TYPE TIMELINE (all inside the safe inset) ------------------------ */}
      <AbsoluteFill
        style={{
          paddingBottom: SAFE_BOTTOM,
          paddingLeft: MARGIN_X,
          paddingRight: MARGIN_X,
          paddingTop: SAFE_TOP,
        }}
      >
        {/* The artists as the brand-led opening mark, upper-centre over the
            sealed gate, gone before the gate opens. */}
        <TimedBlock
          inSec={T.artistIn}
          outSec={T.artistOut}
          fps={fps}
          style={{ left: MARGIN_X, position: "absolute", right: MARGIN_X, top: SAFE_TOP + 40 }}
        >
          <FloatingType
            variant="brandMark"
            mark={track.artists.join(", ")}
            fontSize={70}
            drift={7 * floatBoost}
            color={colors.starlightCream}
          />
        </TimedBlock>

        {/* The verified label fact (research -> pixels), riding the first gated
            hits in the lower third. Oxanium meta voice, in Stardust so it stays
            subordinate to the track line. */}
        <TimedBlock
          inSec={T.labelIn}
          outSec={T.labelOut}
          fps={fps}
          style={{ bottom: SAFE_BOTTOM + 168, left: MARGIN_X, position: "absolute" }}
        >
          <FloatingType
            variant="meta"
            text="Hospital Records"
            fontSize={30}
            drift={5 * floatBoost}
            driftPhase={1.1}
            color={colors.stardust}
          />
        </TimedBlock>

        {/* On the gate opening: Artist — Title (the only sanctioned em dash). */}
        <TimedBlock
          inSec={T.trackIn}
          outSec={T.trackOut}
          fps={fps}
          style={{
            bottom: SAFE_BOTTOM + 150,
            left: MARGIN_X,
            position: "absolute",
            right: MARGIN_X,
          }}
        >
          <FloatingType
            variant="trackLine"
            track={track}
            fontSize={46}
            drift={6 * floatBoost}
            color={colors.starlightCream}
          />
        </TimedBlock>

        {/* Discovered date (tabular Oxanium), trailing the track line. */}
        <TimedBlock
          inSec={T.metaIn}
          outSec={T.metaOut}
          fps={fps}
          style={{ bottom: SAFE_BOTTOM + 100, left: MARGIN_X, position: "absolute" }}
        >
          <FloatingType
            variant="meta"
            track={track}
            fontSize={32}
            drift={5 * floatBoost}
            driftPhase={0.7}
            color={colors.stardust}
          />
        </TimedBlock>

        {/* The close card, driven by the journey's "arrive" phase so it reveals
            as the gate eases held-open. The one permitted gold type moment. */}
        <div
          style={{
            bottom: SAFE_BOTTOM + 220,
            left: MARGIN_X,
            position: "absolute",
            right: MARGIN_X,
          }}
        >
          <CloseCard
            arc={phase === "arrive" ? phaseProgress : 0}
            floatBoost={floatBoost}
            palette={{ accent: colors.eclipseGold, ink: colors.starlightCream }}
          />
        </div>
      </AbsoluteFill>

      {/* GRAIN OVER EVERYTHING, ALWAYS — the system base texture over the whole
          frame (the in-shader grain is the material grain; this is the overlay). */}
      <Grain
        opacity={0.13 + grainKick}
        intensity={0.85}
        seed={(seed % 97) + 1}
        framePool={14}
        blendMode="overlay"
      />

      {/* A faint cinematic vignette to seat the type and hold the warm dark. */}
      <AbsoluteFill
        style={{
          background: `radial-gradient(130% 100% at 50% 48%,
            ${withAlpha(colors.deepField, 0)} 55%,
            ${withAlpha(colors.deepField, 0.5)} 100%)`,
          pointerEvents: "none",
        }}
      />

      {/* arc reference keeps the journey clock observably consumed at the scene
          level (the close card already reads the arrive phase). */}
      <span style={{ display: "none" }}>{arc.toFixed(3)}</span>
    </AbsoluteFill>
  );
};

// --- Helpers ---------------------------------------------------------------

/**
 * A block that fades + floats in/out over a [inSec, outSec) window. Pure: the
 * envelope is frame-derived. Mounts always (cheap) so layout is stable.
 */
const TimedBlock: React.FC<{
  inSec: number;
  outSec: number;
  fps: number;
  style?: React.CSSProperties;
  children: React.ReactNode;
}> = ({ inSec, outSec, fps, style, children }) => {
  const frame = useCurrentFrame();
  const sec = frame / fps;
  const fade = 0.6;

  const opacity = interpolate(sec, [inSec, inSec + fade, outSec - fade, outSec], [0, 1, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const rise = interpolate(sec, [inSec, inSec + fade, outSec - fade, outSec], [26, 0, 0, -18], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  if (opacity <= 0.001) {
    return null;
  }

  return <div style={{ ...style, opacity, transform: `translateY(${rise}px)` }}>{children}</div>;
};

export default TeddysGate;
