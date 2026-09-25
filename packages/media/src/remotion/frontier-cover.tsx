import { AbsoluteFill, Img, staticFile } from "remotion";
import { colors } from "@fluncle/tokens";

import { OXANIUM_STACK } from "./fonts";

export type FrontierCoverProps = {
  crewNumber?: null | number;
};

export const FrontierCover: React.FC<FrontierCoverProps> = ({ crewNumber }) => {
  const stamp =
    typeof crewNumber === "number" && crewNumber > 0
      ? `Nº ${String(crewNumber).padStart(3, "0")}`
      : null;

  return (
    <AbsoluteFill style={{ backgroundColor: colors.deepField }}>
      <Img
        src={staticFile("fluncle-cover-no-text.png")}
        style={{ height: "100%", objectFit: "cover", width: "100%" }}
      />

      <AbsoluteFill
        style={{
          background: `linear-gradient(180deg, transparent 34%, ${colors.deepField}b8 52%, ${colors.deepField}8c 68%, transparent 82%)`,
        }}
      />

      <AbsoluteFill
        style={{
          alignItems: "center",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          paddingTop: 36,
          textAlign: "center",
        }}
      >
        <div
          style={{
            color: colors.starlightCream,
            fontFamily: OXANIUM_STACK,
            fontSize: 46,
            fontWeight: 800,
            letterSpacing: "0.14em",
            lineHeight: 1,
            textShadow: `0 2px 18px ${colors.deepField}, 0 0 2px ${colors.deepField}`,
          }}
        >
          FLUNCLE&rsquo;S
        </div>
        <div
          style={{
            color: colors.starlightCream,
            fontFamily: OXANIUM_STACK,
            fontSize: 104,
            fontWeight: 800,
            letterSpacing: "0.015em",
            lineHeight: 1.04,
            textShadow: `0 3px 26px ${colors.deepField}, 0 0 2px ${colors.deepField}`,
          }}
        >
          FRONTIER
        </div>
      </AbsoluteFill>

      {stamp ? (
        <div
          style={{
            backgroundColor: `${colors.tapeBlack}e6`,
            border: `2px solid ${colors.dustLine}`,
            borderRadius: 10,
            bottom: 30,
            color: colors.starlightCream,
            fontFamily: OXANIUM_STACK,
            fontSize: 34,
            fontVariantNumeric: "tabular-nums",
            fontWeight: 800,
            left: 30,
            letterSpacing: "0.08em",
            lineHeight: 1,
            padding: "12px 18px 13px",
            position: "absolute",
          }}
        >
          {stamp}
        </div>
      ) : null}
    </AbsoluteFill>
  );
};
