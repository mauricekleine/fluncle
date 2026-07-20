import { Link } from "@tanstack/react-router";
import { type ChatCatalogueTrack, CatalogueList } from "@/components/chat/catalogue-card";
import { type ChatFinding } from "@/components/chat/finding-card";
import { FindingList } from "@/components/chat/finding-list";
import { TrackArtwork } from "@/components/track-artwork";
import { findingsCount } from "@/lib/format";
import { type KeyNotation } from "@/lib/key-notation";

// THE LABEL CARD — WHERE Fluncle has logged, rendered (ChatDnB Phase 2).
//
// When the chat's get_label tool resolves a label, the workbench shows a station instead of a raw
// JSON marker: the label's own logo (degrading to the eclipse-gradient TrackArtwork fallback), the
// name as the loud line, a quiet finding count and any confirmed alternate spellings, a link to the
// full page, and the label's findings beneath as the real Finding Cards (reusing Phase 1's
// FindingList). Quiet, dark, and restrained — an admin station, not a streaming clone (PRODUCT.md);
// it mirrors the /label page's visual language so ChatDnB reads like the rest of the archive.

/** The label shape get_label emits — every field optional (the tool output rides `dropEmpty`). */
export type ChatLabel = {
  aliases?: string[];
  /** The voiced entity bio — a short intro paragraph, present only once one is authored. */
  bio?: string;
  /** The records on this label Fluncle knows are out there but has never certified — present when
      the entity is catalogue-only (no findings). Rendered in the unlit register (the Unlit Rule):
      named and listed, never a coordinate, never gold, never presented as one of his Findings. */
  catalogue?: ChatCatalogueTrack[];
  findingCount?: number;
  findings?: ChatFinding[];
  logoUrl?: string;
  name?: string;
  slug?: string;
};

export function LabelCard({ label, notation }: { label: ChatLabel; notation: KeyNotation }) {
  const name = label.name ?? "";
  const slug = label.slug;
  const findings = label.findings ?? [];
  const catalogue = label.catalogue ?? [];
  const count = label.findingCount ?? findings.length;
  const aliases = label.aliases ?? [];
  const bio = label.bio;

  return (
    <div className="flex flex-col gap-3 rounded-md border border-border bg-card px-3 py-2.5">
      <div className="flex items-start gap-3">
        <span className="shrink-0">
          <TrackArtwork alt={`${name} logo`} src={label.logoUrl} />
        </span>
        <div className="min-w-0 flex-1">
          {/* The ratified loud register (.track-title, DESIGN.md §3), same as the sibling Finding
              Card — the entity is the loudest text on the card, never a quiet caption. */}
          <p className="track-title">{name}</p>
          {/* The count doubles as the quiet link to the full page (the graph-card idiom): one
              affordance, its label its purpose. Plain muted text when there is no slug to link. */}
          {slug && count > 0 ? (
            <Link
              aria-label={`Open the label page for ${name}`}
              className="mt-0.5 inline-block text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              params={{ slug }}
              to="/label/$slug"
            >
              {findingsCount(count)}
            </Link>
          ) : count > 0 ? (
            <p className="mt-0.5 text-xs text-muted-foreground">{findingsCount(count)}</p>
          ) : null}
          {aliases.length > 0 ? (
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              also {aliases.join(", ")}
            </p>
          ) : null}
        </div>
      </div>

      {/* The voiced bio introduces the entity before its findings back it up — a quiet paragraph,
          the same muted body register the archive uses for prose, never a hero block. */}
      {bio ? (
        <p className="whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">{bio}</p>
      ) : null}

      {findings.length > 0 ? <FindingList findings={findings} notation={notation} /> : null}

      {/* A catalogue-only label (no findings) lists the records on it in the unlit register — the
          Dust Veil, no coordinate, no gold (DESIGN.md's Unlit Rule). Bare, no heading: the block
          is the only content, so a heading would exist just to name the tier. */}
      {catalogue.length > 0 ? <CatalogueList catalogue={catalogue} /> : null}
    </div>
  );
}
