#!/usr/bin/env node
/**
 * Print durable recovery status for Impeccable live sessions.
 */

import { createLiveSessionStore } from "./live-session-store.mjs";
import { readLiveServerInfo } from "./impeccable-paths.mjs";
import { manualApplyResumeHint } from "./live-resume.mjs";

function readServerInfo() {
  return readLiveServerInfo(process.cwd())?.info || null;
}

async function fetchServerStatus(info) {
  if (!info) {
    return null;
  }
  try {
    const res = await fetch(`http://localhost:${info.port}/status?token=${info.token}`);
    if (!res.ok) {
      return null;
    }
    return await res.json();
  } catch {
    return null;
  }
}

export async function statusCli() {
  const info = readServerInfo();
  const server = await fetchServerStatus(info);
  const store = createLiveSessionStore({ cwd: process.cwd() });
  const activeSessions = store.listActiveSessions();
  const manualApply = findPendingManualApply(server, activeSessions);
  const payload = {
    activeSessions: server?.activeSessions || activeSessions,
    liveServer: server
      ? {
          agentPolling: server.agentPolling,
          connectedClients: server.connectedClients,
          pendingEvents: server.pendingEvents,
          port: server.port,
          status: server.status,
        }
      : null,
    recoveryHint: manualApply
      ? manualApplyResumeHint(manualApply)
      : server
        ? "Run live-poll.mjs to continue pending work, or live-complete.mjs --id <session> after manual cleanup."
        : "Start live-server.mjs to requeue pending durable events, then run live-poll.mjs.",
  };
  console.log(JSON.stringify(payload, null, 2));
}

function findPendingManualApply(server, activeSessions) {
  const fromServer = server?.pendingEvents?.find((event) => event?.type === "manual_edit_apply");
  if (fromServer) {
    return fromServer;
  }
  const fromSession = activeSessions
    ?.map((session) => session.pendingEvent)
    .find((event) => event?.type === "manual_edit_apply");
  return fromSession || null;
}

const _running = process.argv[1];
if (_running?.endsWith("live-status.mjs") || _running?.endsWith("live-status.mjs/")) {
  statusCli();
}
