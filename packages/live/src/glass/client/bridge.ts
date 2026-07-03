// The bridge client — the glass's HALF of the contract.ts boundary (Unit B owns
// the other). Connects to ws://localhost:4180/state WHEN AVAILABLE and:
//   • consumes ShowState — a plan.pointer advance (fingerprint match) drives an arrival;
//   • sends ShowCommand heartbeats {cmd:"heartbeat",renderFrame} at ~1Hz (the watchdog feed);
//   • forwards manual keys as commands (advance/rewind/goto/blackout/intensity);
//   • streams compact mel frames {cmd:"mel", t, frame:number[40]} at 10Hz for the matcher.
//
// FULLY optional: with no bridge the glass runs the v0.6 standalone behavior (the
// failure floor). Reconnect is a gentle backoff so a bridge that starts late — or
// restarts mid-show (it is stateless-restartable) — simply re-attaches.
import { BRIDGE_PORT, BRIDGE_WS_PATH } from "../../contract.ts";
import { type ShowCommand, type ShowState } from "../../contract.ts";

export type BridgeStatus = "off" | "connecting" | "live";

// The mel channel is an agreed extension to the command stream (not in the typed
// ShowCommand union): the exact shape Unit B's matcher consumes.
type MelCommand = { cmd: "mel"; t: number; frame: number[] };
type OutboundCommand = ShowCommand | MelCommand;

export class BridgeClient {
  private ws: WebSocket | null = null;
  private url: string;
  private reconnectMs = 1000;
  private closed = false;
  private lastMelMs = 0;
  private lastHeartbeatMs = 0;

  status: BridgeStatus = "off";
  onState: ((s: ShowState) => void) | null = null;
  onStatus: ((s: BridgeStatus) => void) | null = null;

  constructor(host = "localhost", port: number = BRIDGE_PORT) {
    this.url = `ws://${host}:${port}${BRIDGE_WS_PATH}`;
  }

  private setStatus(s: BridgeStatus): void {
    if (this.status !== s) {
      this.status = s;
      this.onStatus?.(s);
    }
  }

  connect(): void {
    if (this.closed) {
      return;
    }
    this.setStatus("connecting");
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.reconnectMs = 1000;
      this.setStatus("live");
    };
    ws.onmessage = (ev) => {
      try {
        const s = JSON.parse(String(ev.data)) as ShowState;
        this.onState?.(s);
      } catch {
        // ignore malformed frames — the failure floor is renderer-local
      }
    };
    ws.onclose = () => {
      this.ws = null;
      this.setStatus("off");
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      try {
        ws.close();
      } catch {
        // onclose handles the rest
      }
    };
  }

  private scheduleReconnect(): void {
    if (this.closed) {
      return;
    }
    setTimeout(() => this.connect(), this.reconnectMs);
    this.reconnectMs = Math.min(this.reconnectMs * 1.6, 8000);
  }

  private sendRaw(cmd: OutboundCommand): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(cmd));
    }
  }

  send(cmd: ShowCommand): void {
    this.sendRaw(cmd);
  }

  /** ~1Hz watchdog heartbeat carrying the render frame counter. */
  heartbeat(nowMs: number, renderFrame: number): void {
    if (nowMs - this.lastHeartbeatMs >= 1000) {
      this.lastHeartbeatMs = nowMs;
      this.sendRaw({ cmd: "heartbeat", renderFrame });
    }
  }

  /** 10Hz compact mel stream for the fingerprint matcher. */
  mel(nowMs: number, frame: number[]): void {
    if (nowMs - this.lastMelMs >= 100) {
      this.lastMelMs = nowMs;
      this.sendRaw({ cmd: "mel", frame, t: nowMs });
    }
  }

  close(): void {
    this.closed = true;
    try {
      this.ws?.close();
    } catch {
      // best effort
    }
  }
}
