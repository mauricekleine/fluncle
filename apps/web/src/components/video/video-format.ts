export function formatClock(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) {
    return "0:00";
  }

  const whole = Math.floor(totalSeconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const seconds = whole % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");

  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

export const clampFraction = (n: number) => Math.max(0, Math.min(1, n));

export function pointerFraction(clientX: number, left: number, width: number): number | null {
  if (width <= 0) {
    return null;
  }

  return clampFraction((clientX - left) / width);
}

export function clampSeconds(seconds: number, max: number): number {
  const ceiling = Number.isFinite(max) ? max : seconds;

  return Math.max(0, Math.min(ceiling, seconds));
}
