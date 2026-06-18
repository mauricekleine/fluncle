import { TerminalIcon } from "@phosphor-icons/react";
import { CopyButton } from "@/components/copy-button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

const sshCommand = "ssh rave.fluncle.com";

// Defaults to the mono `cli-link` trigger ("ssh rave.fluncle.com" + icon); pass
// `label` + `className` to render a plain text link instead (the home link hub
// uses a short "SSH" label styled like the other footer links).
export function TerminalRaversDialog({
  className,
  label,
}: { className?: string; label?: string } = {}) {
  return (
    <Dialog>
      <DialogTrigger className={className ?? "cli-link"}>
        {label ? (
          label
        ) : (
          <>
            <TerminalIcon aria-hidden="true" size={14} weight="bold" />
            <span style={{ transform: "translateY(1px)" }}>ssh rave.fluncle.com</span>
          </>
        )}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Terminal ravers</DialogTitle>
          <DialogDescription>
            Browse tracks, submit bangers, and enter the Fluncle rave terminal.
          </DialogDescription>
        </DialogHeader>
        <div className="grid min-w-0 gap-2">
          <p className="text-sm font-bold">Connect</p>
          <div className="flex min-w-0 items-center gap-2">
            <code className="cli-command min-w-0 flex-1 px-3 py-2.5">{sshCommand}</code>
            <CopyButton
              confirmation="SSH command copied."
              label="Copy SSH command"
              text={sshCommand}
            />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
