import { type ReactNode } from "react";
import { SidebarTrigger } from "@fluncle/ui/components/sidebar";

type AdminShellProps = {
  children: ReactNode;

  headerActions?: ReactNode;

  subheader?: ReactNode;

  subtitle?: ReactNode;

  title: string;
};

export function AdminShell({
  children,
  headerActions,
  subheader,
  subtitle,
  title,
}: AdminShellProps) {
  return (
    <>
      <header className="flex min-h-14 shrink-0 items-center gap-2 border-b border-border px-3 py-3 sm:px-4">
        <SidebarTrigger className="shrink-0" />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-bold">{title}</h1>
          {subtitle ? (
            <p className="truncate text-xs text-muted-foreground">{subtitle}</p>
          ) : undefined}
        </div>
        {headerActions ? (
          <div className="flex shrink-0 items-center gap-2">{headerActions}</div>
        ) : undefined}
      </header>

      {subheader}

      {children}
    </>
  );
}
