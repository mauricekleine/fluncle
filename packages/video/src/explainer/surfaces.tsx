// On-brand schematic stand-ins for the surfaces we will screen-capture later.
// These are deliberately simple: enough to read what goes where, styled to the
// Nostalgic Cosmos, so the FORMAT is legible before any real footage exists.
// Everything here is deterministic (random(seed), never Math.random).

import { useContext } from "react";
import {
  AbsoluteFill,
  OffthreadVideo,
  random,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";

import { ExplainerContext } from "./explainer-context";
import { FACTORY_CLIPS } from "./factory-clips";
import { c, coordType, font, SAFE } from "./theme";
import { type MockSurface } from "./types";

const Window: React.FC<{ chrome?: string; children: React.ReactNode; mono?: boolean }> = ({
  chrome,
  children,
  mono,
}) => (
  <div
    style={{
      background: c.sleeveBlack,
      border: `1px solid ${c.ruleDark}`,
      borderRadius: 18,
      boxShadow: "0 40px 120px rgba(0,0,0,0.55)",
      display: "flex",
      flexDirection: "column",
      height: "100%",
      overflow: "hidden",
      width: "100%",
    }}
  >
    {chrome !== undefined ? (
      <div
        style={{
          alignItems: "center",
          background: c.tapeBlack,
          borderBottom: `1px solid ${c.ruleDark}`,
          color: c.stardust,
          display: "flex",
          fontFamily: mono ? font.mono : font.body,
          fontSize: 22,
          gap: 14,
          padding: "16px 24px",
        }}
      >
        <span style={{ color: c.eclipseGold, letterSpacing: 2 }}>●</span>
        <span style={{ color: c.ruleDark }}>●</span>
        <span style={{ color: c.ruleDark }}>●</span>
        <span style={{ marginLeft: 12 }}>{chrome}</span>
      </div>
    ) : null}
    {/* Content is centered in the pane so short mocks (and letterboxed real
        captures) sit in the middle of the window, not floating at the top. */}
    <div
      style={{
        display: "flex",
        flex: 1,
        flexDirection: "column",
        justifyContent: "center",
        minHeight: 0,
        padding: 44,
        position: "relative",
      }}
    >
      {children}
    </div>
  </div>
);

const Row: React.FC<{ left: string; right?: string; dim?: boolean }> = ({ left, right, dim }) => (
  <div
    style={{
      alignItems: "center",
      borderBottom: `1px solid ${c.ruleDark}`,
      color: dim ? c.stardust : c.starlightCream,
      display: "flex",
      fontFamily: font.body,
      fontSize: 30,
      justifyContent: "space-between",
      padding: "18px 4px",
    }}
  >
    <span>{left}</span>
    {/* The right slot is the finding's coordinate: the brand's numeral, so
        Oxanium tabular — never mono, which speaks only for the machine. */}
    {right !== undefined ? (
      <span style={{ ...coordType, color: c.eclipseGold, fontSize: 26 }}>{right}</span>
    ) : null}
  </div>
);

const Playlist: React.FC = () => (
  <div>
    <div
      style={{
        color: c.stardust,
        fontFamily: font.display,
        fontSize: 24,
        letterSpacing: 3,
        marginBottom: 18,
      }}
    >
      FLUNCLE&apos;S FINDINGS
    </div>
    <Row left="Skantia — Nemesis" right="004.7.2I" />
    <Row left="Tsuki — Coil" right="003.4.9C" />
    <Row left="Zero T — Lakeside" right="002.1.7F" />
    <Row left="Halogenix — Reverie" right="001.8.3B" dim />
  </div>
);

const Log: React.FC = () => (
  <div style={{ display: "flex", gap: 32, height: "100%" }}>
    <div
      style={{
        aspectRatio: "1",
        background: `radial-gradient(120% 120% at 30% 20%, ${c.eclipseGold}, ${c.reentryRed} 55%, ${c.deepField})`,
        borderRadius: 12,
        flex: "0 0 auto",
        height: "72%",
      }}
    />
    <div style={{ display: "flex", flexDirection: "column", justifyContent: "center" }}>
      {/* The title reads — Space Grotesk 700, the loudest text on the surface. */}
      <div
        style={{
          color: c.starlightCream,
          fontFamily: font.body,
          fontSize: 46,
          fontWeight: 700,
        }}
      >
        Skantia — Nemesis
      </div>
      {/* The Found date is a numeral: Oxanium tabular (The Tabular Rule). */}
      <div style={{ ...coordType, color: c.stardust, fontSize: 28, marginTop: 10 }}>
        Found Jun 3, 2026
      </div>
      <div style={{ ...coordType, color: c.eclipseGold, fontSize: 40, marginTop: 24 }}>
        004.7.2I
      </div>
      {/* Still a coordinate, URI scheme or not. */}
      <div style={{ ...coordType, color: c.nebulaViolet, fontSize: 26, marginTop: 8 }}>
        fluncle://004.7.2I
      </div>
    </div>
  </div>
);

const Lens: React.FC = () => (
  <div style={{ color: c.stardust, fontFamily: font.body, fontSize: 30, lineHeight: 1.7 }}>
    <div>…the roller that opened the set was an absolute weapon, a</div>
    <div>
      finding logged as{" "}
      <span
        style={{
          ...coordType,
          background: c.goldVeil,
          border: `1px solid ${c.eclipseGold}`,
          borderRadius: 8,
          color: c.eclipseGold,
          padding: "4px 12px",
        }}
      >
        fluncle://004.7.2I
      </span>{" "}
      that you can
    </div>
    <div>open straight from any page you find it on…</div>
  </div>
);

/** A rendered track video, playing, inside a player frame (scrubber + timecode).
 *  With a `src` it plays real footage (Fluncle's own output); without one it
 *  falls back to a procedural shader tile that drifts on its own phase (no two
 *  the same). Either way this is the marquee "why does it DO that?!" beat. */
const VideoTile: React.FC<{
  tint: string;
  glow: string;
  seed: string;
  w: number;
  h: number;
  src?: string;
}> = ({ tint, glow, seed, w, h, src }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  const phase = random(`phase-${seed}`) * Math.PI * 2;
  // The light source drifts, so the fallback tile looks like a shader evolving.
  const gx = 50 + Math.sin(t * 0.55 + phase) * 26;
  const gy = 42 + Math.cos(t * 0.47 + phase) * 24;
  const angle = 118 + Math.sin(t * 0.3 + phase) * 30;
  const runtime = 6 + random(`dur-${seed}`) * 5;
  const progress = (t / runtime) % 1;
  // A plausible running timecode across a per-tile clip length (m:ss, always < 60s).
  const total = 20 + Math.floor(random(`len-${seed}`) * 39);
  const elapsed = Math.floor(progress * total);
  const tc = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")}`;
  return (
    <div
      style={{
        border: `1px solid ${c.ruleDark}`,
        borderRadius: 14,
        boxShadow: "0 20px 60px rgba(0,0,0,0.5)",
        height: h,
        overflow: "hidden",
        position: "relative",
        width: w,
      }}
    >
      {src !== undefined ? (
        <OffthreadVideo
          muted
          src={staticFile(src)}
          style={{ height: "100%", objectFit: "cover", width: "100%" }}
        />
      ) : (
        <>
          <AbsoluteFill
            style={{
              background: `radial-gradient(120% 120% at ${gx}% ${gy}%, ${glow}, ${tint} 46%, ${c.deepField})`,
            }}
          />
          {/* warp bands — the "shader" texture, drifting on the tile's own angle */}
          <AbsoluteFill
            style={{
              background: `repeating-linear-gradient(${angle}deg, rgba(255,255,255,0.08) 0 2px, transparent 2px 26px)`,
              mixBlendMode: "soft-light",
              transform: `translateY(${Math.sin(t + phase) * 12}px)`,
            }}
          />
          {/* live waveform, pinned to the bottom */}
          <div
            style={{
              alignItems: "flex-end",
              bottom: 74,
              display: "flex",
              gap: 4,
              height: 68,
              justifyContent: "center",
              left: 20,
              position: "absolute",
              right: 20,
            }}
          >
            {Array.from({ length: 16 }, (_, i) => {
              const base = 0.22 + random(`w-${seed}-${i}`) * 0.5;
              const bh = 10 + (base + 0.5 * Math.abs(Math.sin(t * 5 + i * 0.6 + phase))) * 46;
              return (
                <div
                  key={i}
                  style={{
                    background: c.starlightCream,
                    borderRadius: 2,
                    height: bh,
                    opacity: 0.9,
                    width: 5,
                  }}
                />
              );
            })}
          </div>
        </>
      )}
      {/* a scrim under the player chrome so the scrubber + timecode read on any footage */}
      <div
        style={{
          background: "linear-gradient(transparent, rgba(9,10,11,0.7))",
          bottom: 0,
          height: 120,
          left: 0,
          position: "absolute",
          right: 0,
        }}
      />
      {/* scrubber + timecode — reads as a video player */}
      <div style={{ bottom: 34, left: 20, position: "absolute", right: 20 }}>
        <div
          style={{
            background: "rgba(244,234,215,0.24)",
            borderRadius: 2,
            height: 4,
            width: "100%",
          }}
        >
          <div
            style={{
              background: c.eclipseGold,
              borderRadius: 2,
              height: 4,
              width: `${progress * 100}%`,
            }}
          />
        </div>
        {/* A timecode is a numeral, not machine text: Oxanium tabular so the
            digits never jitter as it counts. */}
        <div style={{ ...coordType, color: c.starlightCream, fontSize: 20, marginTop: 12 }}>
          {tc}
        </div>
      </div>
    </div>
  );
};

const Videos: React.FC = () => {
  const { height, width } = useVideoConfig();
  // Tiles keep a portrait-video aspect off frame WIDTH so three of them read the
  // same in every orientation (tall thin columns on square/portrait otherwise).
  const w = width * 0.26;
  const h = Math.min(w * 1.66, height - 2 * SAFE);
  return (
    <div
      style={{
        alignItems: "center",
        display: "flex",
        gap: width * 0.02,
        height: "100%",
        justifyContent: "center",
      }}
    >
      <VideoTile
        glow={c.eclipseGlow}
        h={h}
        seed="a"
        src={FACTORY_CLIPS[0]}
        tint={c.reentryRed}
        w={w}
      />
      <VideoTile
        glow={c.nebulaViolet}
        h={h}
        seed="b"
        src={FACTORY_CLIPS[1]}
        tint={c.tapeBlack}
        w={w}
      />
      <VideoTile
        glow={c.eclipseGold}
        h={h}
        seed="c"
        src={FACTORY_CLIPS[2]}
        tint={c.sleeveBlack}
        w={w}
      />
    </div>
  );
};

const Voice: React.FC = () => (
  <div
    style={{
      alignItems: "center",
      display: "flex",
      flexDirection: "column",
      gap: 26,
      height: "100%",
      justifyContent: "center",
    }}
  >
    <div style={{ color: c.stardust, fontFamily: font.display, fontSize: 24, letterSpacing: 3 }}>
      RECOVERED AUDIO
    </div>
    <div style={{ alignItems: "center", display: "flex", gap: 6, height: 160 }}>
      {Array.from({ length: 48 }, (_, i) => {
        const h = 14 + random(`wave-${i}`) * 140;
        return (
          <div
            key={i}
            style={{ background: c.eclipseGold, borderRadius: 3, height: h, width: 8 }}
          />
        );
      })}
    </div>
  </div>
);

const Terminal: React.FC = () => (
  <div style={{ color: c.starlightCream, fontFamily: font.mono, fontSize: 26, lineHeight: 1.6 }}>
    <pre
      style={{ color: c.eclipseGold, fontFamily: font.mono, fontSize: 22, margin: 0 }}
    >{`  ___ ___ _   _____
 | _ \\ __/_\\ \\ / / __|
 |   / _/ _ \\ V /| _|
 |_|_\\___/_\\_\\_/ |___|`}</pre>
    <div style={{ color: c.stardust, marginTop: 20 }}>
      the rave terminal · the deep end of the Galaxy
    </div>
    <div style={{ marginTop: 18 }}>
      <span style={{ color: c.eclipseGold }}>›</span> browse the findings
    </div>
    <div>
      <span style={{ color: c.eclipseGold }}>›</span> submit a track
    </div>
    <div>
      <span style={{ color: c.eclipseGold }}>›</span> play the Galaxy
    </div>
  </div>
);

const Galaxy: React.FC = () => (
  <AbsoluteFill>
    {Array.from({ length: 70 }, (_, i) => (
      <div
        key={i}
        style={{
          background: c.starlightCream,
          borderRadius: "50%",
          height: 2 + random(`star-s-${i}`) * 3,
          left: `${random(`star-x-${i}`) * 100}%`,
          opacity: 0.3 + random(`star-o-${i}`) * 0.7,
          position: "absolute",
          top: `${random(`star-y-${i}`) * 100}%`,
          width: 2 + random(`star-s-${i}`) * 3,
        }}
      />
    ))}
    <div
      style={{
        background: c.eclipseGlow,
        borderRadius: "50%",
        boxShadow: `0 0 40px 12px ${c.eclipseGold}`,
        height: 26,
        left: "58%",
        position: "absolute",
        top: "42%",
        width: 26,
      }}
    />
    <div
      style={{
        border: `2px solid ${c.eclipseGold}`,
        borderRadius: "50%",
        height: 120,
        left: "calc(58% - 47px)",
        opacity: 0.6,
        position: "absolute",
        top: "calc(42% - 47px)",
        width: 120,
      }}
    />
    <div
      style={{
        ...coordType,
        color: c.eclipseGold,
        fontSize: 24,
        left: "63%",
        position: "absolute",
        top: "40%",
      }}
    >
      004.7.2I
    </div>
  </AbsoluteFill>
);

const Crawler: React.FC = () => (
  <div style={{ color: c.stardust, fontFamily: font.mono, fontSize: 24, lineHeight: 1.7 }}>
    <div style={{ color: c.eclipseGold }}># llms.txt — for the machines that read the web</div>
    <div>&gt; Fluncle discovers &amp; certifies drum &amp; bass bangers,</div>
    <div>&gt; logs each as a finding, keeps the full archive…</div>
    <div style={{ color: c.eclipseGold, marginTop: 18 }}># MCP tools</div>
    <div>&gt; list_findings · get_random_track · get_status</div>
    <div>&gt; search_tracks · submit_track</div>
  </div>
);

const Mixtape: React.FC = () => (
  <div>
    <div style={{ alignItems: "center", display: "flex", justifyContent: "space-between" }}>
      {/* The mixtape's name is a title, not a brand mark: Space Grotesk 700. */}
      <div
        style={{ color: c.starlightCream, fontFamily: font.body, fontSize: 40, fontWeight: 700 }}
      >
        Fluncle dreaming Nº1
      </div>
      <div style={{ ...coordType, color: c.nebulaViolet, fontSize: 34 }}>000.F.1A</div>
    </div>
    <div
      style={{
        background: `linear-gradient(100deg, ${c.tapeBlack}, ${c.nebulaVeil})`,
        borderRadius: 10,
        height: 150,
        margin: "24px 0",
      }}
    />
    <Row left="01 · Skantia — Nemesis" dim />
    <Row left="02 · Tsuki — Coil" dim />
    <Row left="03 · Zero T — Lakeside" dim />
  </div>
);

const Repo: React.FC = () => (
  <div style={{ color: c.starlightCream, fontFamily: font.mono, fontSize: 30, lineHeight: 1.8 }}>
    <div style={{ color: c.eclipseGold }}>github.com/mauricekleine/fluncle</div>
    {/* Prose reads in the body face even on a mono surface (The One Voice Rule). */}
    <div style={{ color: c.stardust, fontFamily: font.body }}>
      open source · all of it · public forever
    </div>
    <div style={{ marginTop: 22 }}>
      <span style={{ color: c.eclipseGold }}>↳</span> fluncle.com/pipeline
    </div>
  </div>
);

const BODY: Record<MockSurface, React.FC> = {
  crawler: Crawler,
  face: () => null,
  galaxy: Galaxy,
  lens: Lens,
  log: Log,
  mixtape: Mixtape,
  playlist: Playlist,
  repo: Repo,
  terminal: Terminal,
  videos: Videos,
  voice: Voice,
};

const CHROME: Partial<Record<MockSurface, string>> = {
  crawler: "www.fluncle.com/llms.txt",
  lens: "somebodys-blog.com/best-dnb-2026",
  log: "fluncle.com/log/004.7.2I",
  mixtape: "fluncle.com/mixtapes",
  playlist: "fluncle.com",
  repo: "github.com/mauricekleine/fluncle",
  terminal: "ssh rave.fluncle.com",
};

/** A talking-head placeholder: a soft portrait glow with a REC tick. */
const Face: React.FC = () => (
  <AbsoluteFill
    style={{
      alignItems: "center",
      background: `radial-gradient(60% 60% at 50% 42%, ${c.tapeBlack}, ${c.deepField})`,
      justifyContent: "center",
    }}
  >
    <div
      style={{
        alignItems: "center",
        aspectRatio: "1",
        border: `1px solid ${c.ruleDark}`,
        borderRadius: 999,
        color: c.stardust,
        display: "flex",
        fontFamily: font.display,
        fontSize: 40,
        height: "58%",
        justifyContent: "center",
        letterSpacing: 6,
      }}
    >
      YOU
    </div>
    <div
      style={{
        color: c.reentryRed,
        fontFamily: font.mono,
        fontSize: 24,
        left: 48,
        position: "absolute",
        top: 40,
      }}
    >
      ● REC
    </div>
  </AbsoluteFill>
);

/** The mock surface: full-bleed for face/videos/galaxy/voice, windowed for the
 *  web/terminal surfaces. A dashed hint names the real capture that lands here. */
export const MockSurfacePanel: React.FC<{ kind: MockSurface; label?: string }> = ({
  kind,
  label,
}) => {
  const { showCaptureHints } = useContext(ExplainerContext);
  if (kind === "face") {
    return <Face />;
  }

  const Content = BODY[kind];
  const fullBleed = kind === "videos" || kind === "galaxy" || kind === "voice";

  const inner = fullBleed ? (
    <AbsoluteFill>
      <Content />
    </AbsoluteFill>
  ) : (
    <AbsoluteFill
      style={{
        alignItems: "center",
        justifyContent: "center",
        // Proportional to the broadcast-safe margin so the window leaves room for
        // the surface tag (top) and the caption (bottom) on every aspect ratio.
        padding: `${SAFE + 96}px ${SAFE + 20}px ${SAFE + 104}px`,
      }}
    >
      <Window chrome={CHROME[kind] ?? ""} mono={kind === "terminal" || kind === "crawler"}>
        <Content />
      </Window>
    </AbsoluteFill>
  );

  return (
    <AbsoluteFill style={{ background: c.deepField }}>
      {inner}
      {/* Build-time hint naming the real capture that lands here; off by default,
          parked top-right (the one corner free of the tag, caption and PiP cam). */}
      {label !== undefined && showCaptureHints ? (
        <div
          style={{
            border: `1px dashed ${c.ruleDark}`,
            borderRadius: 8,
            color: c.stardust,
            fontFamily: font.mono,
            fontSize: 20,
            opacity: 0.7,
            padding: "6px 14px",
            position: "absolute",
            right: SAFE,
            top: SAFE,
          }}
        >
          screen capture → {label}
        </div>
      ) : null}
    </AbsoluteFill>
  );
};
