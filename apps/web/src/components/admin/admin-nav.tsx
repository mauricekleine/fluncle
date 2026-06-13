import { SignOutIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";

// Shared chrome for the authenticated admin surfaces (the posting board, the
// tagging tool): jump between them and sign out, consistent on every page. Kept
// as a component rather than a layout route because the admin pages have very
// different bodies (a scrollable table vs. a full-height three-pane tool), so a
// single imposed shell would fight them.
const LINKS = [
  { key: "posts", label: "Posts", to: "/admin/posts" },
  { key: "tag", label: "Tag", to: "/admin/tag" },
] as const;

export function AdminNav({ current }: { current: "posts" | "tag" }) {
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
