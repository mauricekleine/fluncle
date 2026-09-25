import { BRIDGE_PORT, BRIDGE_WS_PATH } from "../../contract.ts";
import { type ShowCommand, type ShowState } from "../../contract.ts";

export type BridgeStatus = "off" | "connecting" | "live";

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
      } catch {}
    };
    ws.onclose = () => {
      this.ws = null;
      this.setStatus("off");
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      try {
        ws.close();
      } catch {}
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

  heartbeat(nowMs: number, renderFrame: number): void {
    if (nowMs - this.lastHeartbeatMs >= 1000) {
      this.lastHeartbeatMs = nowMs;
      this.sendRaw({ cmd: "heartbeat", renderFrame });
    }
  }

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
    } catch {}
  }
}
