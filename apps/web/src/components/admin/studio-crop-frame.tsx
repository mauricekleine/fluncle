import { useCallback, useRef } from "react";
import { clampCropLeftFraction, cropWidthFraction } from "@/lib/studio-clip";

// The framing rect: a draggable 9:16 portrait window over the LANDSCAPE set preview
// Built on the VibeMap pointer model
// (getBoundingClientRect + setPointerCapture + clamp), horizontal-only — the window
// keeps the full frame height and slides left↔right. The committed value is the
// rect's left-edge fraction; the page bakes it to an integer source-pixel `xOffset`
// for `create_clip` (the off-centre crop CF Media Transformations can't do, so it's
// baked at the ffmpeg cut — the panel's MT correction).
//
// Its position tracks the pointer (content, not CSS animation), so reduced-motion
// has nothing to suppress here — the VibeMap precedent.

export function StudioCropFrame({
  leftFraction,
  onChange,
  videoHeight,
  videoWidth,
}: {
  /** The rect's current left-edge fraction (0..maxLeft). */
  leftFraction: number;
  onChange: (leftFraction: number) => void;
  videoHeight: number;
  videoWidth: number;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  // The pointer offset inside the rect at grab, so the rect doesn't jump its left
  // edge to the cursor — it slides from where you grabbed it.
  const grabOffset = useRef(0);

  const widthFraction = cropWidthFraction(videoWidth, videoHeight);

  const leftFromEvent = useCallback(
    (event: React.PointerEvent, offset: number): number | null => {
      const box = boxRef.current;

      if (!box) {
        return null;
      }

      const rect = box.getBoundingClientRect();

      if (rect.width <= 0) {
        return null;
      }

      const pointerFraction = (event.clientX - rect.left) / rect.width;

      return clampCropLeftFraction(pointerFraction - offset, videoWidth, videoHeight);
    },
    [videoHeight, videoWidth],
  );

  const handlePointerDown = useCallback(
    (event: React.PointerEvent) => {
      const box = boxRef.current;

      if (!box) {
        return;
      }

      const rect = box.getBoundingClientRect();

      if (rect.width <= 0) {
        return;
      }

      const pointerFraction = (event.clientX - rect.left) / rect.width;
      // Grabbing inside the rect keeps the offset; grabbing the rail re-centres the
      // rect under the cursor.
      const inside =
        pointerFraction >= leftFraction && pointerFraction <= leftFraction + widthFraction;
      grabOffset.current = inside ? pointerFraction - leftFraction : widthFraction / 2;

      const next = leftFromEvent(event, grabOffset.current);

      if (next === null) {
        return;
      }

      dragging.current = true;
      box.setPointerCapture(event.pointerId);
      onChange(next);
    },
    [leftFraction, leftFromEvent, onChange, widthFraction],
  );

  const handlePointerMove = useCallback(
    (event: React.PointerEvent) => {
      if (!dragging.current) {
        return;
      }

      const next = leftFromEvent(event, grabOffset.current);

      if (next !== null) {
        onChange(next);
      }
    },
    [leftFromEvent, onChange],
  );

  const endDrag = useCallback(() => {
    dragging.current = false;
  }, []);

  return (
    <div
      aria-label="Framing. Drag the 9:16 window left or right to choose the portrait crop."
      className="studio-crop"
      onPointerCancel={endDrag}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      ref={boxRef}
      role="group"
    >
      {/* The dimmed-out side scrims + the bright 9:16 keep window between them. */}
      <span className="studio-crop-scrim" style={{ left: 0, width: `${leftFraction * 100}%` }} />
      <span
        className="studio-crop-scrim"
        style={{ left: `${(leftFraction + widthFraction) * 100}%`, right: 0 }}
      />
      <span
        className="studio-crop-window"
        style={{ left: `${leftFraction * 100}%`, width: `${widthFraction * 100}%` }}
      >
        <span className="studio-crop-label">9:16</span>
      </span>
    </div>
  );
}
