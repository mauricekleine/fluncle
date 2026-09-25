import { Link } from "@tanstack/react-router";
import { type ChatCatalogueTrack, CatalogueList } from "@/components/chat/catalogue-card";
import { type ChatFinding } from "@/components/chat/finding-card";
import { FindingList } from "@/components/chat/finding-list";
import { TrackArtwork } from "@/components/track-artwork";
import { findingsCount } from "@/lib/format";
import { type KeyNotation } from "@/lib/key-notation";

export type ChatLabel = {
  aliases?: string[];

  bio?: string;

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
          <p className="track-title">{name}</p>

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

      {bio ? (
        <p className="whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">{bio}</p>
      ) : null}

      {findings.length > 0 ? <FindingList findings={findings} notation={notation} /> : null}

      {catalogue.length > 0 ? <CatalogueList catalogue={catalogue} /> : null}
    </div>
  );
}
