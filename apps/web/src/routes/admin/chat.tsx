import { createFileRoute, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { AdminShell } from "@/components/admin/admin-shell";
import { ChatConversation } from "@/components/chat/chat-conversation";
import { isAdminRequest } from "@/lib/server/admin-auth";

// ── ChatDnB — the workbench (the admin station) ─────────────────────────────────────────
//
// The operator's chat with Fluncle over his own archive. The conversation UI itself — the
// transcript, the inline tool-call markers (the grounding work made visible), the Finding
// Cards, the now-playing bar — is the SHARED ChatConversation (components/chat/), the same
// one the public /chat door renders; this route only wraps it in the AdminShell chrome and
// points the transport at the admin-gated POST. Admin auth is the grant cookie, so no CSRF
// token rides the transport here (the public door's session gate is the one that needs it).

const ensureAdmin = createServerFn({ method: "GET" }).handler(async () => {
  if (!(await isAdminRequest())) {
    throw redirect({ to: "/admin/login" });
  }
});

export const Route = createFileRoute("/admin/chat")({
  beforeLoad: () => ensureAdmin(),
  component: ChatWorkbench,
});

function ChatWorkbench() {
  return (
    <AdminShell subtitle="Fluncle answers over his own archive" title="ChatDnB">
      <ChatConversation transportApi="/api/admin/chat" />
    </AdminShell>
  );
}
