import { CopyButton } from "@/components/copy-button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { mcpUrl } from "@/lib/fluncle-links";

// The five tools mirror the public API and the WebMCP surface; keep them in
// step with lib/server/mcp.ts.
const mcpTools = [
  { description: "Latest findings", name: "get_recent_tracks" },
  { description: "One at random", name: "get_random_track" },
  { description: "Find a candidate", name: "search_tracks" },
  { description: "Send one for review", name: "submit_track" },
  { description: "Board the mothership", name: "subscribe_newsletter" },
];

// The trigger styles itself to sit inline with the tertiary footer links
// (About · MCP · Full log), so it reads as one of them and opens the
// connect instructions the way the CLI link opens its installer.
export function McpConnectDialog() {
  return (
    <Dialog>
      <DialogTrigger className="cursor-pointer font-semibold text-muted-foreground transition-colors hover:text-accent-foreground">
        MCP
      </DialogTrigger>
      <DialogContent className="sm:max-w-[32rem]">
        <DialogHeader>
          <DialogTitle>Connect over MCP</DialogTitle>
          <DialogDescription>Same bangers, in your agent.</DialogDescription>
        </DialogHeader>
        <div className="grid min-w-0 gap-2">
          <p className="text-sm font-bold">Endpoint</p>
          <div className="flex min-w-0 items-center gap-2">
            <code className="cli-command min-w-0 flex-1 px-3 py-2.5">{mcpUrl}</code>
            <CopyButton
              confirmation="MCP endpoint copied."
              label="Copy MCP endpoint"
              text={mcpUrl}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            Streamable HTTP, no auth. Point any MCP client at the endpoint.
          </p>
        </div>
        <div className="grid min-w-0 gap-2">
          <p className="text-sm font-bold">Tools</p>
          <ul className="m-0 grid list-none gap-2 p-0">
            {mcpTools.map((tool) => (
              <li className="flex items-baseline justify-between gap-3" key={tool.name}>
                <code className="cli-inline">{tool.name}</code>
                <span className="text-xs text-muted-foreground">{tool.description}</span>
              </li>
            ))}
          </ul>
        </div>
      </DialogContent>
    </Dialog>
  );
}
