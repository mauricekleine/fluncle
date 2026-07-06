// The pulse-lite panel — the daemon's vitals plus the two proof actions. This is
// the reference panel for units 2-4: read /api/<id>/… with apiGet/apiPost, start
// a streamed action, hand its runId to useHelm().openRun, done.

import { BellRinging, Pulse } from "@phosphor-icons/react";
import { useEffect, useState } from "react";

import { Button } from "@fluncle/ui/components/button";

import { type HealthResponse, type RunStartedResponse } from "../../contract";
import { apiGet, apiPost } from "../../ui/api";
import { useHelm } from "../../ui/helm-context";

const HEALTH_POLL_MS = 5000;

function uptimeLabel(uptimeMs: number): string {
  const minutes = Math.floor(uptimeMs / 60_000);

  if (minutes < 1) {
    return "under a minute";
  }

  if (minutes < 60) {
    return `${minutes}m`;
  }

  if (minutes < 60 * 24) {
    return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  }

  return `${Math.floor(minutes / (60 * 24))}d ${Math.floor((minutes / 60) % 24)}h`;
}

export default function PulseLitePanel() {
  const { machine, machineBrand, openRun } = useHelm();
  const [health, setHealth] = useState<HealthResponse | undefined>(undefined);
  const [notifyState, setNotifyState] = useState<"idle" | "refused" | "sending" | "sent">("idle");
  const [pinging, setPinging] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const read = async (): Promise<void> => {
      try {
        const response = await apiGet<HealthResponse>("/api/health");

        if (!cancelled) {
          setHealth(response);
        }
      } catch {
        if (!cancelled) {
          setHealth(undefined);
        }
      }
    };

    void read();
    const timer = setInterval(() => void read(), HEALTH_POLL_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  async function testNotification(): Promise<void> {
    setNotifyState("sending");

    try {
      await apiPost("/api/pulse-lite/notify");
      setNotifyState("sent");
    } catch {
      setNotifyState("refused");
    }
  }

  async function lineCheck(): Promise<void> {
    setPinging(true);

    try {
      const { runId } = await apiPost<RunStartedResponse>("/api/pulse-lite/ping");
      openRun("pulse-lite", runId);
    } finally {
      setPinging(false);
    }
  }

  return (
    <div className="grid max-w-2xl gap-6">
      <header className="grid gap-1">
        <h2 className="text-base font-extrabold text-foreground">Pulse</h2>
        <p className="text-sm text-muted-foreground">The daemon reads its own vitals.</p>
      </header>

      <section aria-label="Vitals" className="rounded-lg border bg-card/40 p-4">
        <dl className="grid gap-2 font-mono text-[0.82rem] leading-relaxed">
          <VitalRow
            label="daemon"
            note={health ? `holding on :${health.port} · pid ${health.pid}` : "no answer yet"}
            token={health ? "clear" : "dark"}
          />
          <VitalRow
            label="machine"
            note={machineBrand ? `${machineBrand} (${machine})` : machine}
            token={machine === "unknown" ? "dark" : "clear"}
          />
          <VitalRow
            label="up"
            note={health ? uptimeLabel(health.uptimeMs) : "—"}
            token={health ? "clear" : "dark"}
          />
          <VitalRow
            label="admin token"
            note={
              health
                ? health.adminTokenAboard
                  ? "aboard — admin actions will answer"
                  : "not aboard — admin actions will refuse (~/.config/fluncle)"
                : "—"
            }
            token={health ? (health.adminTokenAboard ? "clear" : "hold") : "dark"}
          />
        </dl>
      </section>

      <section aria-label="Proof actions" className="grid gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <Button
            disabled={notifyState === "sending"}
            onClick={() => void testNotification()}
            variant="outline"
          >
            <BellRinging aria-hidden data-icon="inline-start" />
            Test notification
          </Button>
          <Button disabled={pinging} onClick={() => void lineCheck()} variant="outline">
            <Pulse aria-hidden data-icon="inline-start" />
            Line check
          </Button>
        </div>
        <p aria-live="polite" className="min-h-4 text-xs text-muted-foreground">
          {notifyState === "sent"
            ? "Sent. Check the corner of your screen."
            : notifyState === "refused"
              ? "osascript refused it. Notification permissions, probably."
              : notifyState === "sending"
                ? "Sending…"
                : ""}
        </p>
      </section>
    </div>
  );
}

const VITAL_TOKEN_STYLES = {
  clear: "font-bold text-foreground",
  dark: "text-muted-foreground",
  hold: "font-bold text-destructive",
} as const;

function VitalRow({
  label,
  note,
  token,
}: {
  label: string;
  note: string;
  token: keyof typeof VITAL_TOKEN_STYLES;
}) {
  return (
    <div className="flex gap-3">
      <span aria-hidden className={`w-14 ${VITAL_TOKEN_STYLES[token]}`}>
        [{token}]
      </span>
      <dt className="w-28 shrink-0 text-foreground">{label}</dt>
      <dd className="text-muted-foreground">{note}</dd>
    </div>
  );
}
