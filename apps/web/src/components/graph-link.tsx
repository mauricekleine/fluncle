import { HoverCard, HoverCardContent, HoverCardTrigger } from "@fluncle/ui/components/hover-card";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type ComponentPropsWithoutRef, type ReactNode, useState } from "react";
import { findingsCount } from "@/lib/format";
import { type GraphEntityKind, type GraphPreview } from "@/lib/graph-prose";
import { cn } from "@/lib/utils";

const OPEN_DELAY_MS = 450;
const CLOSE_DELAY_MS = 200;

const COUNT_NOUN: Record<GraphEntityKind, string> = {
  album: "on this record",
  artist: "from this one",
  galaxy: "out here",
  label: "on this label",
};

async function fetchPreview(kind: GraphEntityKind, slug: string): Promise<GraphPreview> {
  const response = await fetch(`/api/v1/graph/${kind}/${encodeURIComponent(slug)}`);

  if (!response.ok) {
    throw new Error(`No ${kind} preview for "${slug}"`);
  }

  const body = (await response.json()) as { preview: GraphPreview };

  return body.preview;
}

function EntityAnchor({
  kind,
  slug,
  ...anchorProps
}: {
  kind: GraphEntityKind;
  slug: string;
} & ComponentPropsWithoutRef<"a">): ReactNode {
  if (kind === "artist") {
    return <Link {...anchorProps} params={{ slug }} to="/artist/$slug" />;
  }

  if (kind === "album") {
    return <Link {...anchorProps} params={{ slug }} to="/album/$slug" />;
  }

  if (kind === "label") {
    return <Link {...anchorProps} params={{ slug }} to="/label/$slug" />;
  }

  return <Link {...anchorProps} params={{ slug }} to="/galaxies/$slug" />;
}

function PreviewBody({
  kind,
  preview,
}: {
  kind: GraphEntityKind;
  preview: GraphPreview | undefined;
}): ReactNode {
  if (!preview) {
    return <p className="graph-card-loading">Digging that out…</p>;
  }

  const { bio, covers, findingCount, line, name } = preview;

  return (
    <>
      <p className="graph-card-name">{name}</p>
      {covers.length > 0 ? (
        <span aria-hidden="true" className="graph-card-covers">
          {covers.map((cover) => (
            <img alt="" className="graph-card-cover" key={cover} loading="lazy" src={cover} />
          ))}
        </span>
      ) : undefined}

      {line ? <p className="graph-card-line">{line}</p> : undefined}

      {bio ? <p className="graph-card-bio">{bio}</p> : undefined}
      {findingCount > 0 ? (
        <p className="graph-card-count">
          {findingsCount(findingCount)} {COUNT_NOUN[kind]}
        </p>
      ) : undefined}
    </>
  );
}

export function GraphLink({
  children,
  className,
  kind,
  slug,
  variant = "inline",
}: {
  children: ReactNode;

  className?: string;
  kind: GraphEntityKind;
  slug: string;

  variant?: "chip" | "inline";
}): ReactNode {
  const [open, setOpen] = useState(false);

  const { data } = useQuery({
    enabled: open,
    gcTime: 30 * 60_000,
    queryFn: () => fetchPreview(kind, slug),
    queryKey: ["graph-preview", kind, slug],

    refetchOnWindowFocus: false,
    retry: false,
    staleTime: 5 * 60_000,
  });

  return (
    <HoverCard onOpenChange={setOpen} open={open}>
      <HoverCardTrigger
        closeDelay={CLOSE_DELAY_MS}
        delay={OPEN_DELAY_MS}
        render={
          <EntityAnchor
            className={cn("graph-link", variant === "chip" && "graph-link--chip", className)}
            kind={kind}
            slug={slug}
          />
        }
      >
        {children}
      </HoverCardTrigger>
      <HoverCardContent className="graph-card" side="top">
        <PreviewBody kind={kind} preview={data} />
      </HoverCardContent>
    </HoverCard>
  );
}
