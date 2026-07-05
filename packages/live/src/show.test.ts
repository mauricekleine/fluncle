// The pre-flight parsers, tested against REAL tool output shapes (the first-set debrief:
// the meter read [dark] "meter unread" though frames flowed, and the 44.1 kHz hold named
// no devices). `interpretMeter` reads an ffmpeg `volumedetect` capture; `parseAudioDevices`
// reads `system_profiler -json SPAudioDataType`. Both pure — importing show.ts must not
// launch the rig (main() is guarded behind import.meta.main).

import { describe, expect, test } from "bun:test";

import { interpretMeter, parseAudioDevices } from "./show.ts";

// Real volumedetect stderr (captured from ffmpeg): a 440 Hz tone and digital silence.
const TONE_STDERR = [
  "[Parsed_volumedetect_0 @ 0x872c30780] n_samples: 0",
  "[Parsed_volumedetect_0 @ 0x872c30c00] n_samples: 144000",
  "[Parsed_volumedetect_0 @ 0x872c30c00] mean_volume: -21.1 dB",
  "[Parsed_volumedetect_0 @ 0x872c30c00] max_volume: -18.1 dB",
  "[Parsed_volumedetect_0 @ 0x872c30c00] histogram_18db: 12800",
].join("\n");

const SILENCE_STDERR = [
  "[Parsed_volumedetect_0 @ 0xa80c30c00] n_samples: 144000",
  "[Parsed_volumedetect_0 @ 0xa80c30c00] mean_volume: -91.0 dB",
  "[Parsed_volumedetect_0 @ 0xa80c30c00] max_volume: -91.0 dB",
].join("\n");

describe("interpretMeter", () => {
  test("a real signal reads [clear] with the mean + peak (frames flowed, level present)", () => {
    const r = interpretMeter({ stderr: TONE_STDERR, timedOut: false }, 3);
    expect(r.status).toBe("clear");
    expect(r.note).toContain("mean -21.1 dB");
    expect(r.note).toContain("peak -18.1 dB");
  });

  test("a connected-but-silent route reads [hold] 'route alive, signal silent' — NOT unread", () => {
    const r = interpretMeter({ stderr: SILENCE_STDERR, timedOut: false }, 3);
    expect(r.status).toBe("hold");
    expect(r.note).toContain("route alive, signal silent");
    // The debrief's distinction: silence is its own message, never "meter unread".
    expect(r.note).not.toContain("meter unread");
  });

  test("no frames + a wedged capture (SIGKILL on timeout) reads [hold] dead route", () => {
    const r = interpretMeter({ stderr: "", timedOut: true }, 3);
    expect(r.status).toBe("hold");
    expect(r.note).toContain("dead route");
  });

  test("a device open error reads [dark] can't-open (pick another index)", () => {
    const r = interpretMeter(
      { stderr: "[avfoundation @ 0x0] Error opening input: Input/output error", timedOut: false },
      3,
    );
    expect(r.status).toBe("dark");
    expect(r.note).toContain("couldn't open input");
  });

  test("a summary that never printed (no timeout, no error) reads [dark] meter unread", () => {
    const r = interpretMeter({ stderr: "some unrelated ffmpeg log", timedOut: false }, 3);
    expect(r.status).toBe("dark");
    expect(r.note).toContain("meter unread");
  });

  test("a -inf mean is silent, not a parse failure", () => {
    const r = interpretMeter(
      { stderr: "[Parsed_volumedetect_0 @ 0x0] mean_volume: -inf dB", timedOut: false },
      3,
    );
    expect(r.status).toBe("hold");
    expect(r.note).toContain("route alive, signal silent");
  });
});

// A trimmed `system_profiler -json SPAudioDataType` body: two 44.1 kHz devices, one 48 kHz.
const SP_JSON = JSON.stringify({
  SPAudioDataType: [
    {
      _items: [
        { _name: "USB Audio CODEC", coreaudio_device_srate: 44100 },
        { _name: "MacBook Pro Speakers", coreaudio_device_srate: 44100 },
        { _name: "Samson Q2U Microphone", coreaudio_device_srate: 48000 },
      ],
    },
  ],
});

describe("parseAudioDevices", () => {
  test("pairs each device name with its sample rate", () => {
    const devices = parseAudioDevices(SP_JSON);
    expect(devices).toHaveLength(3);
    expect(devices[0]).toEqual({ name: "USB Audio CODEC", sampleRate: 44100 });
  });

  test("a shapeless / non-JSON body degrades to [] (checkSampleRate then reads 'unread')", () => {
    expect(parseAudioDevices("not json")).toEqual([]);
    expect(parseAudioDevices("{}")).toEqual([]);
  });

  test("the offenders can be NAMED — the actionable hold the debrief asked for", () => {
    const off = parseAudioDevices(SP_JSON).filter((d) => d.sampleRate !== 48_000);
    expect(off.map((d) => `${d.name} @${d.sampleRate}`)).toEqual([
      "USB Audio CODEC @44100",
      "MacBook Pro Speakers @44100",
    ]);
  });
});
