import net from "node:net";
import { basename, resolve } from "node:path";

import { BRIDGE_PORT, BRIDGE_WS_PATH, GLASS_PORT } from "./contract";

const PKG_ROOT = resolve(import.meta.dir, "..");
const BRIDGE_ENTRY = resolve(PKG_ROOT, "src/bridge/serve.ts");
const GLASS_ENTRY = resolve(PKG_ROOT, "src/glass/serve.ts");
const GLASS_URL = `http://localhost:${GLASS_PORT}`;
const BRIDGE_PLAN_URL = `http://localhost:${BRIDGE_PORT}/plan`;
const BRIDGE_WS_URL = `ws://localhost:${BRIDGE_PORT}${BRIDGE_WS_PATH}`;

const DISK_FLOOR_GB = 40;

const REQUIRED_SAMPLE_RATE = 48_000;

type Options = {
  plan: string | undefined;
  oneMac: boolean;
  displayIndex: number | undefined;
  audioIndex: number;
  checkOnly: boolean;
  noBrowser: boolean;
  force: boolean;
  help: boolean;
};

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    audioIndex: -1,
    checkOnly: false,
    displayIndex: undefined,
    force: false,
    help: false,
    noBrowser: false,
    oneMac: false,
    plan: undefined,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--plan":
        opts.plan = argv[++i];
        break;
      case "--one-mac":
        opts.oneMac = true;
        break;
      case "--display-index": {
        const raw = argv[++i];
        const n = Number(raw);
        if (!Number.isInteger(n) || n < 0) {
          throw new Error(
            `--display-index wants a non-negative integer, got ${raw ?? "(nothing)"}`,
          );
        }
        opts.displayIndex = n;
        break;
      }
      case "--audio-index": {
        const raw = argv[++i];
        const n = Number(raw);
        if (!Number.isInteger(n) || n < 0) {
          throw new Error(`--audio-index wants a non-negative integer, got ${raw ?? "(nothing)"}`);
        }
        opts.audioIndex = n;
        break;
      }
      case "--check-only":
        opts.checkOnly = true;
        break;
      case "--no-browser":
        opts.noBrowser = true;
        break;
      case "--force":
        opts.force = true;
        break;
      case "-h":
      case "--help":
        opts.help = true;
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  return opts;
}

const HELP = `fluncle live — the show orchestrator (Unit T)

  bun run --cwd packages/live show [flags]

Brings the rig up in order: pre-flight (audio meter, 48 kHz, disk, ports) →
the bridge (waits for /plan + the state socket) → the glass → the pinned
Chromium fullscreen on the show display, with caffeinate holding the machine
awake. SIGINT (Ctrl-C) tears it all back down.

Flags
  --plan <handle|logId> load a plan (a galaxy-slug handle — the normal live flow — or a
                        mixtape logId); the bridge fingerprints its tracklist
  --one-mac             the fallback topology (mixing + streaming on one machine)
  --display-index <N>   which display the glass takes (default: the last one)
  --audio-index <N>     the avfoundation audio input to meter (default: auto — prefers M-Track/USB audio, never an Aggregate)
  --check-only          run pre-flight and report, launch nothing
  --no-browser          raise the servers but do not launch Chromium
  --force               launch even if a pre-flight check is holding
  -h, --help            this screen

Once up: press Enter to confirm the glass is on the show display, 'p' to
re-place it (display IDs reorder on reconnect), 'p N' to re-place on display N,
or 'q' to stand the rig down. The full runbook is docs/live-show-setup.md.`;

type CheckStatus = "clear" | "hold" | "dark";

type CheckResult = { status: CheckStatus; note: string };

function line(status: CheckStatus, label: string, note: string): void {
  const token = status === "clear" ? "[clear]" : status === "hold" ? "[hold] " : "[dark] ";
  console.log(`  ${token} ${label.padEnd(22)} ${note}`);
}

function say(text: string): void {
  console.log(text);
}

type RunResult = { ok: boolean; stdout: string; stderr: string; timedOut: boolean };

async function run(cmd: string[], timeoutMs = 8_000): Promise<RunResult> {
  const bin = cmd[0];
  if (bin === undefined || Bun.which(bin) === null) {
    return { ok: false, stderr: `no ${bin ?? "command"} aboard`, stdout: "", timedOut: false };
  }
  try {
    const proc = Bun.spawn(cmd, { stderr: "pipe", stdin: "ignore", stdout: "pipe" });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill(9);
    }, timeoutMs);
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    clearTimeout(timer);
    return { ok: exitCode === 0 && !timedOut, stderr, stdout, timedOut };
  } catch (err) {
    return { ok: false, stderr: String(err), stdout: "", timedOut: false };
  }
}

function portOccupied(port: number): Promise<boolean> {
  return new Promise((resolvePort) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const settle = (held: boolean): void => {
      socket.destroy();
      resolvePort(held);
    };
    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
    socket.setTimeout(1_000, () => settle(false));
  });
}

async function checkAudio(audioIndex: number): Promise<CheckResult> {
  const list = await run([
    "ffmpeg",
    "-hide_banner",
    "-f",
    "avfoundation",
    "-list_devices",
    "true",
    "-i",
    "",
  ]);
  if (list.stderr.includes("no ffmpeg aboard")) {
    return { note: "no ffmpeg aboard — can't read the meter here", status: "dark" };
  }
  const audioDevices = [
    ...list.stderr.matchAll(/\[AVFoundation[^\]]*\]\s+\[(\d+)\]\s+(.+)/g),
  ].filter((m) => list.stderr.slice(0, m.index ?? 0).includes("audio devices"));
  if (audioDevices.length === 0) {
    return {
      note: "no avfoundation audio device answered — running dark (no capture rig here?)",
      status: "dark",
    };
  }

  if (audioIndex < 0) {
    const byName = (re: RegExp) =>
      audioDevices.find((m) => re.test(m[2] ?? "") && !/aggregate/i.test(m[2] ?? ""));
    const pick =
      byName(/m-track|usb audio/i) ??
      byName(/blackhole/i) ??
      audioDevices.find((m) => !/aggregate/i.test(m[2] ?? "")) ??
      audioDevices[0];
    audioIndex = Number(pick?.[1] ?? 0);
  }

  const cap = await run(
    [
      "ffmpeg",
      "-hide_banner",
      "-f",
      "avfoundation",
      "-i",
      `:${audioIndex}`,
      "-t",
      "3",
      "-af",
      "volumedetect",
      "-f",
      "null",
      "-",
    ],
    7_000,
  );
  return interpretMeter(cap, audioIndex);
}

const METER_SILENCE_FLOOR_DB = -70;

export function interpretMeter(
  cap: { stderr: string; timedOut: boolean },
  audioIndex: number,
): CheckResult {
  const parseDb = (m: RegExpMatchArray | null): number | null => {
    if (!m) {
      return null;
    }
    const raw = (m[1] ?? "").toLowerCase();
    if (raw === "-inf" || raw === "nan") {
      return -Infinity;
    }
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  };
  const mean = parseDb(cap.stderr.match(/mean_volume:\s*(-?\d+(?:\.\d+)?|-?inf|nan)\s*dB/i));
  const max = parseDb(cap.stderr.match(/max_volume:\s*(-?\d+(?:\.\d+)?|-?inf|nan)\s*dB/i));
  if (mean === null) {
    if (cap.timedOut) {
      return {
        note: `input :${audioIndex} delivered no meter in 3s — dead route (nothing playing, or the wrong input; route the master through the M-Track / PC MASTER OUT)`,
        status: "hold",
      };
    }
    if (/Input\/output error|Error opening|Invalid device/i.test(cap.stderr)) {
      return {
        note: `couldn't open input :${audioIndex} — pick another with --audio-index N`,
        status: "dark",
      };
    }
    return {
      note: `couldn't read a level off input :${audioIndex} — meter unread`,
      status: "dark",
    };
  }
  if (mean > METER_SILENCE_FLOOR_DB) {
    const peak = max !== null && Number.isFinite(max) ? `, peak ${max} dB` : "";
    return { note: `input :${audioIndex} bounced (mean ${mean} dB${peak})`, status: "clear" };
  }
  return {
    note: `input :${audioIndex} — route alive, signal silent (mean ${mean === -Infinity ? "−inf" : mean} dB); is music playing?`,
    status: "hold",
  };
}

export type AudioDevice = { name: string; sampleRate: number };

export function parseAudioDevices(json: string): AudioDevice[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  const groups = (parsed as { SPAudioDataType?: unknown }).SPAudioDataType;
  if (!Array.isArray(groups)) {
    return [];
  }
  const out: AudioDevice[] = [];
  for (const group of groups) {
    const items = (group as { _items?: unknown })._items;
    if (!Array.isArray(items)) {
      continue;
    }
    for (const item of items) {
      const rec = item as { _name?: unknown; coreaudio_device_srate?: unknown };
      const name = typeof rec._name === "string" ? rec._name : null;
      const rate = Number(rec.coreaudio_device_srate);
      if (name !== null && Number.isFinite(rate)) {
        out.push({ name, sampleRate: rate });
      }
    }
  }
  return out;
}

async function checkSampleRate(): Promise<CheckResult> {
  const prof = await run(["system_profiler", "-json", "SPAudioDataType"]);
  if (prof.stderr.includes("no system_profiler aboard") || prof.stdout.length === 0) {
    return {
      note: "sample rate unread — confirm 48 kHz by hand (Audio MIDI Setup)",
      status: "dark",
    };
  }
  const devices = parseAudioDevices(prof.stdout);
  if (devices.length === 0) {
    return {
      note: "sample rate unread — confirm 48 kHz by hand (Audio MIDI Setup)",
      status: "dark",
    };
  }
  const off = devices.filter((d) => d.sampleRate !== REQUIRED_SAMPLE_RATE);
  if (off.length === 0) {
    return { note: `every device reads ${REQUIRED_SAMPLE_RATE / 1000} kHz`, status: "clear" };
  }
  const named = off.map((d) => `${d.name} @${d.sampleRate}`).join(", ");
  return {
    note: `${named} — set to ${REQUIRED_SAMPLE_RATE} in Audio MIDI Setup (resample crackle risk)`,
    status: "hold",
  };
}

async function checkDisk(): Promise<CheckResult> {
  const df = await run(["df", "-k", PKG_ROOT]);
  if (!df.ok) {
    return { note: "disk headroom unread", status: "dark" };
  }
  const dataLine = df.stdout.trim().split("\n").at(-1) ?? "";
  const cols = dataLine.split(/\s+/);

  const availKb = Number(cols[3]);
  if (!Number.isFinite(availKb)) {
    return { note: "disk headroom unread", status: "dark" };
  }
  const availGb = availKb / 1024 / 1024;
  return availGb >= DISK_FLOOR_GB
    ? { note: `${availGb.toFixed(0)} GB free (floor ${DISK_FLOOR_GB} GB)`, status: "clear" }
    : {
        note: `only ${availGb.toFixed(0)} GB free — a set can outrun the floor (${DISK_FLOOR_GB} GB)`,
        status: "hold",
      };
}

async function checkPorts(): Promise<CheckResult> {
  const [glassHeld, bridgeHeld] = await Promise.all([
    portOccupied(GLASS_PORT),
    portOccupied(BRIDGE_PORT),
  ]);
  const held: number[] = [];
  if (glassHeld) {
    held.push(GLASS_PORT);
  }
  if (bridgeHeld) {
    held.push(BRIDGE_PORT);
  }
  return held.length === 0
    ? { note: `${GLASS_PORT} + ${BRIDGE_PORT} open`, status: "clear" }
    : {
        note: `port ${held.join(" + ")} already held — a stray glass/bridge still up?`,
        status: "hold",
      };
}

async function preflight(opts: Options): Promise<boolean> {
  say("\npre-flight — reading the rig\n");
  const results: CheckResult[] = [];

  const audio = await checkAudio(opts.audioIndex);
  line(audio.status, "audio meter", audio.note);
  results.push(audio);

  const rate = await checkSampleRate();
  line(rate.status, "sample rate", rate.note);
  results.push(rate);

  const disk = await checkDisk();
  line(disk.status, "disk headroom", disk.note);
  results.push(disk);

  const ports = await checkPorts();
  line(ports.status, "ports", ports.note);
  results.push(ports);

  const holds = results.filter((r) => r.status === "hold").length;
  const darks = results.filter((r) => r.status === "dark").length;
  say("");
  if (holds > 0) {
    say(`  ${holds} check${holds === 1 ? "" : "s"} holding. The rig is not clear to depart.`);
    return false;
  }
  if (darks > 0) {
    say(
      `  clear to depart — ${darks} check${darks === 1 ? "" : "s"} ran dark (unreadable here); confirm those by hand.`,
    );
  } else {
    say("  all clear. The rig reads good.");
  }
  return true;
}

type Child = { name: string; proc: Bun.Subprocess };

const children: Child[] = [];

function spawnChild(name: string, cmd: string[], cwd: string): Bun.Subprocess {
  const proc = Bun.spawn(cmd, { cwd, stderr: "inherit", stdin: "ignore", stdout: "inherit" });
  children.push({ name, proc });
  return proc;
}

async function waitForHttp(url: string, label: string, timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1_500) });
      if (res.ok) {
        return true;
      }
    } catch {}
    await Bun.sleep(300);
  }
  say(`  [hold]  ${label} never answered at ${url} (${timeoutMs / 1000}s)`);
  return false;
}

function waitForSocket(url: string, timeoutMs = 8_000): Promise<boolean> {
  return new Promise((resolveSocket) => {
    let settled = false;
    const socket = new WebSocket(url);
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      socket.close();
      resolveSocket(false);
    }, timeoutMs);
    socket.addEventListener("open", () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.close();
      resolveSocket(true);
    });
    socket.addEventListener("error", () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolveSocket(false);
    });
  });
}

function resolveChromiumEnv(value: string): { bin: string; procName: string } {
  const trimmed = value.replace(/\/+$/, "");
  if (trimmed.endsWith(".app")) {
    const name = basename(trimmed).replace(/\.app$/, "");
    return { bin: `${trimmed}/Contents/MacOS/${name}`, procName: name };
  }
  return { bin: trimmed, procName: basename(trimmed) };
}

function findChromium(): { bin: string; procName: string } | undefined {
  const pinned = process.env.FLUNCLE_CHROMIUM;
  const candidates: Array<{ bin: string; procName: string }> = [];
  if (pinned !== undefined && pinned.length > 0) {
    candidates.push(resolveChromiumEnv(pinned));
  }
  candidates.push(
    { bin: "/Applications/Chromium.app/Contents/MacOS/Chromium", procName: "Chromium" },
    {
      bin: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      procName: "Google Chrome",
    },
  );
  return candidates.find((c) => existsSync(c.bin));
}

function existsSync(path: string): boolean {
  try {
    return Bun.file(path).size > 0;
  } catch {
    return false;
  }
}

type DisplayFrame = { x: number; y: number; w: number; h: number };

async function readDisplays(): Promise<DisplayFrame[]> {
  const jxa =
    'ObjC.import("AppKit"); const s = $.NSScreen.screens; const out = []; ' +
    "for (let i = 0; i < s.count; i++) { const f = s.objectAtIndex(i).frame; " +
    "out.push({ x: f.origin.x, y: f.origin.y, w: f.size.width, h: f.size.height }); } JSON.stringify(out);";
  const res = await run(["osascript", "-l", "JavaScript", "-e", jxa]);
  if (!res.ok) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(res.stdout.trim());
    return Array.isArray(parsed) ? (parsed as DisplayFrame[]) : [];
  } catch {
    return [];
  }
}

async function placeGlass(procName: string, displayIndex: number | undefined): Promise<void> {
  const displays = await readDisplays();
  if (displays.length === 0) {
    say("  [dark]  no displays read (headless?) — place the glass by hand, then fullscreen it");
    return;
  }
  const index = displayIndex ?? displays.length - 1;
  const target = displays[index];
  if (target === undefined) {
    say(`  [hold]  display ${index} does not exist (${displays.length} attached, 0-indexed)`);
    return;
  }
  const mainHeight = displays[0]?.h ?? target.h;
  const axX = Math.round(target.x);
  const axY = Math.round(mainHeight - (target.y + target.h));
  const applescript = [
    `tell application "System Events" to tell process "${procName}"`,
    "  set frontmost to true",
    `  set position of front window to {${axX}, ${axY}}`,
    '  set value of attribute "AXFullScreen" of front window to true',
    "end tell",
  ].join("\n");
  const res = await run(["osascript", "-e", applescript]);
  if (res.ok) {
    say(`  [clear] glass placed on display ${index} at ${axX},${axY} and fullscreened`);
  } else {
    say(
      `  [dark]  couldn't drive the window (grant Accessibility to your terminal): ${res.stderr.trim()}`,
    );
  }
}

function launchChromium(bin: string): Bun.Subprocess {
  const profileDir = resolve(PKG_ROOT, ".show-profile");
  const proc = Bun.spawn(
    [
      bin,
      `--app=${GLASS_URL}`,
      "--start-fullscreen",
      "--disable-backgrounding-occluded-windows",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-features=CalculateNativeWinOcclusion",
      "--autoplay-policy=no-user-gesture-required",
      "--no-first-run",
      "--no-default-browser-check",
      `--user-data-dir=${profileDir}`,
    ],
    { stderr: "ignore", stdin: "ignore", stdout: "ignore" },
  );
  children.push({ name: "chromium", proc });
  return proc;
}

let tearingDown = false;

function teardown(reason: string): void {
  if (tearingDown) {
    return;
  }
  tearingDown = true;
  say(`\nstanding the rig down (${reason})`);
  for (const child of [...children].reverse()) {
    try {
      child.proc.kill();
    } catch {}
  }
  say("  the glass is dark. caffeinate released. crew stood down.");
  process.exit(0);
}

function watchStdin(procName: string, initialIndex: number | undefined): void {
  if (!process.stdin.isTTY) {
    return;
  }
  let index = initialIndex;
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    const cmd = chunk.trim();
    if (cmd === "") {
      say("  confirmed — the glass is on the show display. The crew is aboard.");
      return;
    }
    if (cmd === "q") {
      teardown("operator stood the rig down");
      return;
    }
    if (cmd === "p" || cmd.startsWith("p ")) {
      const arg = cmd.slice(1).trim();
      if (arg.length > 0) {
        const n = Number(arg);
        if (Number.isInteger(n) && n >= 0) {
          index = n;
        }
      }
      void placeGlass(procName, index);
      return;
    }
    say("  keys: Enter confirm · p re-place · p N re-place on display N · q stand down");
  });
}

async function main(): Promise<void> {
  let opts: Options;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    say(String(err instanceof Error ? err.message : err));
    say("\n" + HELP);
    process.exit(2);
  }

  if (opts.help) {
    say(HELP);
    process.exit(0);
  }

  say("fluncle live — raising the glass");
  say(
    opts.oneMac
      ? "  topology: one-Mac fallback (mixing + streaming on one machine)"
      : "  topology: two-machine (mixing machine + streaming machine)",
  );
  if (opts.plan !== undefined) {
    say(`  plan: ${opts.plan}`);
  }

  const clear = await preflight(opts);
  if (!clear && !opts.force) {
    say("\n  hold. Clear the blockers or re-run with --force to depart anyway.");
    process.exit(1);
  }
  if (opts.checkOnly) {
    say("\n  --check-only: pre-flight done, nothing launched.");
    process.exit(clear ? 0 : 1);
  }

  process.on("SIGINT", () => teardown("SIGINT"));
  process.on("SIGTERM", () => teardown("SIGTERM"));

  if (Bun.which("caffeinate") !== null) {
    children.push({
      name: "caffeinate",
      proc: Bun.spawn(["caffeinate", "-dis"], { stdin: "ignore" }),
    });
    say("\n  caffeinate holding the machine awake");
  } else {
    say("\n  [dark]  no caffeinate aboard — keep the machine from sleeping by hand");
  }

  say("\nraising the bridge");
  const bridgeArgs = ["bun", BRIDGE_ENTRY];
  if (opts.plan !== undefined) {
    bridgeArgs.push("--plan", opts.plan);
  }
  spawnChild("bridge", bridgeArgs, PKG_ROOT);
  const planUp = await waitForHttp(BRIDGE_PLAN_URL, "the bridge /plan");
  if (!planUp && !opts.force) {
    return teardown("the bridge never opened /plan");
  }
  if (planUp) {
    const wsUp = await waitForSocket(BRIDGE_WS_URL);
    line(
      wsUp ? "clear" : "hold",
      "state socket",
      wsUp ? "the state stream is up" : "the state socket never opened",
    );
    if (!wsUp && !opts.force) {
      return teardown("the state socket never opened");
    }
  }

  say("\nraising the glass");
  spawnChild("glass", ["bun", GLASS_ENTRY], PKG_ROOT);
  const glassUp = await waitForHttp(GLASS_URL, "the glass");
  if (!glassUp && !opts.force) {
    return teardown("the glass never served the page");
  }
  if (glassUp) {
    line("clear", "glass", `serving at ${GLASS_URL}`);
  }

  if (opts.noBrowser) {
    say(`\n  --no-browser: open ${GLASS_URL} yourself, fullscreen, on the show display.`);
  } else {
    say("\nputting the glass on the show display");
    const chromium = findChromium();
    if (chromium === undefined) {
      say("  [hold]  no Chromium or Chrome found — install one, or open the URL by hand");
    } else {
      launchChromium(chromium.bin);
      await Bun.sleep(2_500);
      await placeGlass(chromium.procName, opts.displayIndex);
      say("");
      say(
        "  confirm the glass is on the show display — press Enter, or re-place with 'p' (or 'p N' for display N).",
      );
      say("  (display IDs reorder on reconnect; this is the re-place path.)");
      watchStdin(chromium.procName, opts.displayIndex);
    }
  }

  say(
    "\nthe glass is up. OBS is yours — capture the show display, arm the record (video meter-bounce, runbook §pre-flight).",
  );
  say("Ctrl-C stands the whole rig down.\n");

  await new Promise<void>(() => {});
}

if (import.meta.main) {
  void main();
}
