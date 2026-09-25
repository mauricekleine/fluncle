import { getInputProps } from "remotion";
import { colors } from "@fluncle/tokens";
import { FloatingType } from "../primitives/floating-type";
import { closeCardProgress, closeCardReveal } from "./close-card-timing";

export type CloseCardProps = {
  progress?: number;

  palette?: { ink?: string; accent?: string };

  floatBoost?: number;

  taglineSize?: number;

  signatureSize?: number;

  align?: React.CSSProperties["textAlign"];

  style?: React.CSSProperties;
};

const TAGLINE = "Drum & bass bangers from another dimension";

const SIGNATURE = "selected by Fluncle";

const MARGIN_X = 96;
const SAFE_BOTTOM = 230;

const CONTAINER_STYLE: React.CSSProperties = {
  bottom: SAFE_BOTTOM,
  display: "flex",
  flexDirection: "column",
  gap: 14,
  left: MARGIN_X,
  position: "absolute",
  right: MARGIN_X,
};

export const CloseCard: React.FC<CloseCardProps> = ({
  progress,
  palette,
  floatBoost = 1,
  taglineSize = 25,
  signatureSize = 52,
  align = "left",
  style,
}) => {
  const p = closeCardProgress(progress);

  if (p <= 0.001) {
    return null;
  }

  if ((getInputProps() as { hideOverlay?: boolean }).hideOverlay) {
    return null;
  }

  const { signatureP, taglineP } = closeCardReveal(p);

  const ink = palette?.ink ?? colors.starlightCream;

  const accent = palette?.accent ?? ink;

  return (
    <div
      style={{
        ...CONTAINER_STYLE,
        alignItems: align === "center" ? "center" : "flex-start",
        ...style,
      }}
    >
      <div
        style={{
          opacity: taglineP,
          transform: `translateY(${(1 - taglineP) * 16}px)`,
        }}
      >
        <FloatingType
          variant="body"
          text={TAGLINE}
          fontSize={taglineSize}
          drift={5 * floatBoost}
          driftPhase={0.4}
          align={align}
          color={ink}
        />
      </div>

      <div
        style={{
          opacity: signatureP,
          transform: `translateY(${(1 - signatureP) * 22}px)`,
        }}
      >
        <FloatingType
          variant="brandMark"
          mark={SIGNATURE}
          fontSize={signatureSize}
          drift={6 * floatBoost}
          align={align}
          color={accent}
        />
      </div>
    </div>
  );
};
