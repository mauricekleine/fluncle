import { createFileRoute } from "@tanstack/react-router";
import { ensureAdmin } from "@/lib/admin-guard";
import { AdminShell } from "@/components/admin/admin-shell";
import { ChatConversation } from "@/components/chat/chat-conversation";

// ── ChatDnB — the workbench (the admin station) ─────────────────────────────────────────
//
// The operator's chat with Fluncle over his own archive. The conversation UI itself — the
// transcript, the inline tool-call markers (the grounding work made visible), the Finding
// Cards, the now-playing bar — is the SHARED ChatConversation (components/chat/), the same
// one the public /chat door renders; this route only wraps it in the AdminShell chrome and
// points the transport at the admin-gated POST. Admin auth is the grant cookie, so no CSRF
// token rides the transport here (the public door's session gate is the one that needs it).

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
