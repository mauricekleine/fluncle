import { describe, expect, test } from "bun:test";

import { checkByLabel, parseNamedCheck, readShowProgress } from "./preflight";

// Reproduce show.ts's `line()` EXACTLY (packages/live/src/show.ts): a token, the label
// padded to 22, one space, then the note — so the fixtures are byte-for-byte what the
// show streams. The notes are real (interpretMeter / checkSampleRate / checkDisk /
// checkPorts), multi-word, with commas and parens.
type Status = "clear" | "dark" | "hold";

function line(status: Status, label: string, note: string): string {
  const token = status === "clear" ? "[clear]" : status === "hold" ? "[hold] " : "[dark] ";

  return `  ${token} ${label.padEnd(22)} ${note}`;
}

const AUDIO_CLEAR = line("clear", "audio meter", "input :0 bounced (mean -18 dB, peak -3 dB)");
const AUDIO_HOLD = line(
  "hold",
  "audio meter",
  "input :0 — route alive, signal silent (mean −inf dB); is music playing?",
);
const RATE_CLEAR = line("clear", "sample rate", "every device reads 48 kHz");
const RATE_HOLD = line(
  "hold",
  "sample rate",
  "DDJ-FLX4 @44100 — set to 48000 in Audio MIDI Setup (resample crackle risk)",
);
const DISK_CLEAR = line("clear", "disk headroom", "312 GB free (floor 40 GB)");
const PORTS_CLEAR = line("clear", "ports", "4173 + 4180 open");
const PORTS_HOLD = line("hold", "ports", "port 4173 already held — a stray glass/bridge still up?");
const SOCKET_CLEAR = line("clear", "state socket", "the state stream is up");
const GLASS_CLEAR = line("clear", "glass", "serving at http://localhost:4173");

describe("parseNamedCheck", () => {
  test("a padded check line splits into label + token + the whole multi-word note", () => {
    expect(parseNamedCheck(AUDIO_CLEAR)).toEqual({
      label: "audio meter",
      note: "input :0 bounced (mean -18 dB, peak -3 dB)",
      token: "clear",
    });
  });

  test("the hold detail survives its em-dash, semicolons, and parens", () => {
    expect(parseNamedCheck(RATE_HOLD)?.note).toBe(
      "DDJ-FLX4 @44100 — set to 48000 in Audio MIDI Setup (resample crackle risk)",
    );
  });

  test("a one-off `[token] sentence` from say() is narration, not a check", () => {
    // These carry a token but NO padded note (single spaces) — they belong in the log.
    expect(
      parseNamedCheck("  [clear] glass placed on display 2 at 100,50 and fullscreened"),
    ).toBeUndefined();
    expect(
      parseNamedCheck("  [dark]  no caffeinate aboard — keep the machine from sleeping by hand"),
    ).toBeUndefined();
    expect(
      parseNamedCheck(
        "  [hold]  the bridge /plan never answered at http://localhost:4180/plan (20s)",
      ),
    ).toBeUndefined();
  });

  test("plain narration is not a check", () => {
    expect(parseNamedCheck("pre-flight — reading the rig")).toBeUndefined();
    expect(
      parseNamedCheck("the glass is up. OBS is yours — capture the show display."),
    ).toBeUndefined();
  });
});

describe("readShowProgress", () => {
  test("a clean pre-flight through the glass is up reads live, with every check clear", () => {
    const progress = readShowProgress([
      "fluncle live — raising the glass",
      "  topology: two-machine (mixing machine + streaming machine)",
      "  plan: dark-aurora-roller",
      "pre-flight — reading the rig",
      AUDIO_CLEAR,
      RATE_CLEAR,
      DISK_CLEAR,
      PORTS_CLEAR,
      "  all clear. The rig reads good.",
      SOCKET_CLEAR,
      GLASS_CLEAR,
      "the glass is up. OBS is yours — capture the show display.",
    ]);

    expect(progress.checks.map((c) => `${c.label}:${c.token}`)).toEqual([
      "audio meter:clear",
      "sample rate:clear",
      "disk headroom:clear",
      "ports:clear",
      "state socket:clear",
      "glass:clear",
    ]);
    expect(progress.phase).toBe("live");
    expect(progress.glassLive).toBe(true);
    expect(progress.bridgeLive).toBe(true);
    expect(progress.holds).toBe(0);
    expect(checkByLabel(progress, "audio meter")?.note).toBe(
      "input :0 bounced (mean -18 dB, peak -3 dB)",
    );
  });

  test("holding checks yield phase 'holding' and a hold count, before any glass", () => {
    const progress = readShowProgress([
      "pre-flight — reading the rig",
      AUDIO_HOLD,
      RATE_HOLD,
      DISK_CLEAR,
      PORTS_HOLD,
      "  3 checks holding. The rig is not clear to depart.",
      "",
      "  hold. Clear the blockers or re-run with --force to depart anyway.",
    ]);

    expect(progress.phase).toBe("holding");
    expect(progress.holds).toBe(3);
    expect(progress.glassLive).toBe(false);
  });

  test("one-off token sentences never enter the checklist", () => {
    const progress = readShowProgress([
      "pre-flight — reading the rig",
      AUDIO_CLEAR,
      "  [dark]  no caffeinate aboard — keep the machine from sleeping by hand",
      "  [clear] glass placed on display 2 at 100,50 and fullscreened",
    ]);

    expect(progress.checks.map((c) => c.label)).toEqual(["audio meter"]);
  });

  test("a later status for the same check replaces the earlier one (a re-read)", () => {
    const progress = readShowProgress([AUDIO_HOLD, AUDIO_CLEAR]);

    expect(progress.checks).toHaveLength(1);
    expect(progress.checks[0]?.token).toBe("clear");
    expect(progress.holds).toBe(0);
  });

  test("teardown lines read as 'down'", () => {
    const progress = readShowProgress([
      GLASS_CLEAR,
      "the glass is up. OBS is yours.",
      "standing the rig down (SIGINT)",
      "  the glass is dark. caffeinate released. crew stood down.",
    ]);

    expect(progress.phase).toBe("down");
  });

  test("nothing yet is idle", () => {
    expect(readShowProgress([]).phase).toBe("idle");
    expect(readShowProgress(["fluncle live — raising the glass"]).phase).toBe("idle");
  });
});
