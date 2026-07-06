import * as React from "react";
import { Input as InputPrimitive } from "@base-ui/react/input";

import { cn } from "#lib/utils";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      className={cn(
        // Canon input (DESIGN.md): Tape Black fill, 1px Dust Line border, 2.5rem
        // tall, gold focus ring at 40%. The border is a warm dust edge so the field
        // reads as a field at rest, not only once the focus ring fires.
        "h-10 w-full min-w-0 rounded-md border border-[color-mix(in_oklch,var(--stardust)_30%,transparent)] bg-input px-3 py-1 text-base transition-[color,box-shadow] outline-none file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground hover:border-[color-mix(in_oklch,var(--stardust)_45%,transparent)] focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
