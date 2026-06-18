import * as React from "react";

import { cn } from "@/lib/utils";

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        // Canon input (DESIGN.md): Tape Black fill, 1px Dust Line border, gold focus
        // ring at 40%. The warm dust edge keeps the field legible at rest.
        "flex field-sizing-content min-h-20 w-full resize-y rounded-md border border-[color-mix(in_oklch,var(--stardust)_30%,transparent)] bg-input px-3 py-2 text-base transition-[color,box-shadow] outline-none placeholder:text-muted-foreground hover:border-[color-mix(in_oklch,var(--stardust)_45%,transparent)] focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm",
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
