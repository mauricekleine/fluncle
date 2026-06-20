import {
  CheckCircleIcon,
  InfoIcon,
  SpinnerIcon,
  WarningIcon,
  XCircleIcon,
} from "@phosphor-icons/react";
import { Toaster as Sonner, type ToasterProps } from "sonner";

// Dark-only, matching the app (no next-themes). Colors come from the design tokens
// (packages/tokens) via the CSS vars below.
const Toaster = ({ ...props }: ToasterProps) => {
  return (
    <Sonner
      className="toaster group"
      icons={{
        error: <XCircleIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        loading: <SpinnerIcon className="size-4 animate-spin" />,
        success: <CheckCircleIcon className="size-4" />,
        warning: <WarningIcon className="size-4" />,
      }}
      style={
        {
          "--border-radius": "var(--radius)",
          "--normal-bg": "var(--popover)",
          "--normal-border": "var(--border)",
          "--normal-text": "var(--popover-foreground)",
        } as React.CSSProperties
      }
      theme="dark"
      toastOptions={{
        classNames: {
          toast: "cn-toast",
        },
      }}
      {...props}
    />
  );
};

export { Toaster };
