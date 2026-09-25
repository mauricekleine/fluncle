export type RailControl = {
  active: boolean;

  accessibilityLabel: string;

  label: string;
};

export function soundRail(soundOn: boolean): RailControl {
  return {
    accessibilityLabel: soundOn ? "Turn sound off" : "Turn sound on",
    active: soundOn,
    label: "Sound",
  };
}
