import { createFileRoute } from "@tanstack/react-router";
import { ensureAdmin } from "@/lib/admin-guard";
import { AdminShell } from "@/components/admin/admin-shell";
import { ChatConversation } from "@/components/chat/chat-conversation";

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
