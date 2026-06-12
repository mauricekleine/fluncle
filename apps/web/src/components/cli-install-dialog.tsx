import { DownloadSimpleIcon } from "@phosphor-icons/react";
import { CopyButton } from "@/components/copy-button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

const cliInstallCommand = "curl -fsSL https://www.fluncle.com/cli/latest.sh | sh";

const cliExamples = [
  { command: "fluncle --help", description: "See every command" },
  { command: "fluncle recent", description: "Latest tracks in your terminal" },
  { command: "fluncle open", description: "Open the playlist" },
  { command: "fluncle submit", description: "Send a track for review" },
];

export function CliInstallDialog() {
  return (
    <Dialog>
      <DialogTrigger className="cli-link">
        <DownloadSimpleIcon aria-hidden="true" size={14} weight="bold" />
        <span
          style={{
            transform: "translateY(1px)",
          }}
        >
          install CLI
        </span>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[32rem]">
        <DialogHeader>
          <DialogTitle>Install the Fluncle CLI</DialogTitle>
          <DialogDescription>Same bangers, no browser.</DialogDescription>
        </DialogHeader>
        <div className="grid min-w-0 gap-2">
          <p className="text-sm font-bold">Install</p>
          <div className="flex min-w-0 items-center gap-2">
            <code className="cli-command min-w-0 flex-1 px-3 py-2.5">{cliInstallCommand}</code>
            <CopyButton
              confirmation="Install command copied."
              label="Copy install command"
              text={cliInstallCommand}
            />
          </div>
        </div>
        <div className="grid min-w-0 gap-2">
          <p className="text-sm font-bold">Then try</p>
          <ul className="m-0 grid list-none gap-2 p-0">
            {cliExamples.map((example) => (
              <li className="flex items-baseline justify-between gap-3" key={example.command}>
                <code className="cli-inline">{example.command}</code>
                <span className="text-xs text-muted-foreground">{example.description}</span>
              </li>
            ))}
          </ul>
        </div>
      </DialogContent>
    </Dialog>
  );
}
