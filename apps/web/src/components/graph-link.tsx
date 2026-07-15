// THE FLUNCLE GRAPH LINK — one component for every entity Fluncle names.
//
// The archive is a graph (log ↔ artist ↔ label ↔ album ↔ galaxy) and every node has a page. So
// wherever a page NAMES one of those nodes in reading text, the name is this link: same style,
// same behaviour, same card, everywhere. Not a bespoke link per surface. See DESIGN.md, "Graph
// Link", which is the canon for the rules below and the reasons behind them.
//
// ── THE REST STATE IS CREAM, NOT GOLD (The One Sun Rule) ──────────────────────────────
// Eclipse Gold is DESIGN.md's ONE SUN: the primary action, the focus ring, identity — capped
// at roughly 10% of any screen. A /log page already spends its gold on the Listen CTA, the
// coordinate, and the galaxy clause. Gold-at-rest graph links would turn the page into a field
// of suns and the actual CTA would stop leading. So a graph link rests in Starlight Cream under
// a dotted underline — legible as a link, quiet as text — and HEATS to Eclipse Glow with a
// solid underline on hover/focus. That is The Ignition Rule: gold is placed like light, and
// interaction heats it. The budget survives; the link still announces itself.
//
// ── THE CARD ─────────────────────────────────────────────────────────────────────────
// A Shadcn `HoverCard` (base-ui's PreviewCard underneath), opened on a deliberate ~450ms delay
// so a cursor crossing a paragraph never fires one. It carries the entity page's OWN opening
// line — the same sentence the page's masthead prints, from the same function (lib/graph-prose)
// — plus a few finding covers and the count. It invents nothing and it is the sole source of
// nothing: base-ui's own guidance is that a preview card is a visual enhancement for sighted
// mouse and keyboard users, so everything in it also lives one click away, on the page.
//
//   - KEYBOARD: focusing the link opens the card; Escape closes it; Enter follows the link.
//     The card is never focus-trapped and never in the tab order — it is a preview, not a
//     dialog, and a keyboard user tabbing through a paragraph is never detained by one.
//   - TOUCH: the card does not open at all. A tap is a navigation, full stop — a hover card on
//     a phone is a thing that has to be dismissed before you can do what you meant to do.
//     (PreviewCard's pointer handling is hover-intent based, so touch never triggers it.)
//   - REDUCED MOTION: the card appears without the fade/zoom (styles.css).

import { HoverCard, HoverCardContent, HoverCardTrigger } from "@fluncle/ui/components/hover-card";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type ComponentPropsWithoutRef, type ReactNode, useState } from "react";
import { findingsCount } from "@/lib/format";
import { type GraphEntityKind, type GraphPreview } from "@/lib/graph-prose";
import { cn } from "@/lib/utils";

/**
 * Wikipedia-grade hover intent. Short enough that a reader who PAUSES on a name gets the card
 * without feeling they waited; long enough that a cursor travelling across a sentence full of
 * links fires nothing at all. The close delay is generous so the pointer can travel from the
 * link into the card without it evaporating on the way.
 */
const OPEN_DELAY_MS = 450;
const CLOSE_DELAY_MS = 200;

/**
 * How the card's count line names each kind — "3 findings on this label".
 *
 * The label used to read "off this imprint", and "imprint" is out of the vocabulary: it is
 * trade-press English, not something the uncle says out loud (lib/graph-prose.ts). It is a
 * label, and he says so.
 */
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

/**
 * The anchor itself. TanStack's `to` is a literal union, so the kind switch is the mapping.
 *
 * `...anchorProps` is LOAD-BEARING, not tidiness: base-ui's `render` prop hands this element
 * every prop the trigger needs — the hover/focus handlers, the ref, `data-slot`, the ARIA. Drop
 * them and you get a perfectly good-looking link with no card behind it, which is exactly the
 * bug this spread exists to prevent.
 */
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

/** The card's body — the entity's own line, its covers, its count. */
function PreviewBody({
  kind,
  preview,
}: {
  kind: GraphEntityKind;
  preview: GraphPreview | undefined;
}): ReactNode {
  if (!preview) {
    // The pre-arrival state. Deliberately NOT a spinner or a shimmer of fake rows: the card is
    // a courtesy, and a loading skeleton for a courtesy is noise. One quiet line — Fluncle
    // doing the verb, and naming no object he cannot yet see — then the real thing.
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
      {/* No findings ⇒ the page prints no opening line, so neither does the card. It carries
          the page's sentence or it carries none; it never writes one of its own. */}
      {line ? <p className="graph-card-line">{line}</p> : undefined}
      {/* The factual bio, BELOW the signature line — the full page's order (Fluncle's relation
          first, then the objective paragraph). Clamped so a 3–4 sentence bio never makes the
          card tall. Absent (album/galaxy, or an entity still awaiting its backfilled bio) ⇒ no
          row, no gap. */}
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
  /** The visible name. The whole phrase links, e.g. `Hoofbeats Music` or `Kalyx galaxy`. */
  children: ReactNode;
  /** The host's own skin, when it has one (a chip's layout, a tile's frame). */
  className?: string;
  kind: GraphEntityKind;
  slug: string;
  /**
   * `inline` — a name inside reading text: cream under a dotted underline, heating to Eclipse
   * Glow with a solid one. The default, and the one the canon describes.
   *
   * `chip` — the same link and the same card, worn by a host that already draws the affordance
   * (an avatar chip on a graph page, an adjacent-galaxy tile). It carries no underline, because
   * a chip is not a word in a sentence; the host's own hover state does the heating. One
   * component, one behaviour, two skins — never a second component.
   */
  variant?: "chip" | "inline";
}): ReactNode {
  const [open, setOpen] = useState(false);

  // THE CARD IS LAZY, AND THAT IS THE WHOLE N+1 ANSWER. It fetches on OPEN — i.e. after the
  // hover-intent delay, so a passing cursor costs nothing — never on render and never in the
  // page loader. The key is the ENTITY, so thirty feed rows naming the same imprint share one
  // request between them, and a second hover of a link already seen makes none. The LINK, by
  // contrast, costs nothing at all: its slug rode in on the same SELECT that loaded the track.
  const { data } = useQuery({
    enabled: open,
    gcTime: 30 * 60_000,
    queryFn: () => fetchPreview(kind, slug),
    queryKey: ["graph-preview", kind, slug],
    // A public read of an archive that does not change while you look away from the tab.
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
