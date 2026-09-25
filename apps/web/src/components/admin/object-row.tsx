import { type ComponentType, type ReactNode, type Ref } from "react";
import { cn } from "@/lib/utils";

export function ObjectList({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <ul
      className={cn(
        "m-0 list-none divide-y divide-border rounded-lg border border-border p-0",
        className,
      )}
    >
      {children}
    </ul>
  );
}

export function ObjectRow({
  children,
  className,
  ref,
  trailing,
}: {
  children: ReactNode;
  className?: string;

  ref?: Ref<HTMLLIElement>;

  trailing?: ReactNode;
}) {
  return (
    <li
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5 sm:flex-nowrap sm:px-4",
        className,
      )}
      ref={ref}
    >
      {children}
      {trailing ? (
        <div className="flex w-full shrink-0 items-center justify-end gap-2 sm:w-auto">
          {trailing}
        </div>
      ) : null}
    </li>
  );
}

export function ObjectLead({
  className,
  coordinate,
  coordinateHref,
  leading,
  subtitle,
  title,
  titleHref,
}: {
  className?: string;
  coordinate?: string;
  coordinateHref?: string;
  leading: ReactNode;
  subtitle?: ReactNode;
  title: ReactNode;
  titleHref?: string;
}) {
  return (
    <div className={cn("flex min-w-0 grow basis-full items-center gap-3 sm:basis-0", className)}>
      {leading}
      <div className="min-w-0 flex-1">
        {coordinate ? (
          coordinateHref ? (
            <a
              className="block truncate font-mono text-[10px] tracking-tight text-muted-foreground tabular-nums hover:text-primary focus-visible:outline-2 focus-visible:outline-ring"
              href={coordinateHref}
            >
              {coordinate}
            </a>
          ) : (
            <p className="truncate font-mono text-[10px] tracking-tight text-muted-foreground tabular-nums">
              {coordinate}
            </p>
          )
        ) : null}
        {titleHref ? (
          <a
            className="block truncate text-sm font-medium hover:text-primary focus-visible:outline-2 focus-visible:outline-ring"
            href={titleHref}
          >
            {title}
          </a>
        ) : (
          <p className="truncate text-sm font-medium">{title}</p>
        )}
        {subtitle ? (
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground tabular-nums">
            {subtitle}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function ObjectGlyph({ icon: Icon }: { icon: ComponentType<{ className?: string }> }) {
  return (
    <div
      aria-hidden="true"
      className="flex size-11 shrink-0 items-center justify-center rounded-md border border-border bg-gradient-to-br from-primary/10 via-muted/30 to-destructive/10"
    >
      <Icon className="size-5 text-muted-foreground" />
    </div>
  );
}
