import { SignOutIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";

// Shared chrome for the authenticated admin surface: the board is `/admin` (the
// operator's home, the pipeline view of every finding — it absorbed the old Posts
// and Tag pages, so it's the only surface now), plus sign out. Rendered inside
// AdminShell's header.
const LINKS = [{ key: "board", label: "Board", to: "/admin" }] as const;

export type AdminNavCurrent = (typeof LINKS)[number]["key"];

export function AdminNav({ current }: { current: AdminNavCurrent }) {
  return (
    <nav aria-label="Admin" className="flex shrink-0 items-center gap-1">
      {LINKS.map((link) => (
        <Button
          key={link.key}
          nativeButton={false}
          render={<a href={link.to} />}
          size="sm"
          variant={current === link.key ? "secondary" : "ghost"}
        >
          {link.label}
        </Button>
      ))}
      <Button
        aria-label="Sign out"
        nativeButton={false}
        render={<a href="/api/admin/logout" />}
        size="icon-sm"
        variant="ghost"
      >
        <SignOutIcon aria-hidden="true" />
      </Button>
    </nav>
  );
}
