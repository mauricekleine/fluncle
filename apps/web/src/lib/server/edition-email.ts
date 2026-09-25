import { type EditionDTO, type TrackListItem } from "@fluncle/contracts";
import { logPageUrl, siteUrl } from "../fluncle-links";
import { getTracksByLogIds } from "./tracks";

const POSTAL_ADDRESS = "With love, from somewhere deep in the Galaxy, Fluncle";

const FRONTIER_TEASER_URL = `${siteUrl}/recommendations`;

const FRONTIER_TEASER_HTML =
  `<p style="border-top:1px solid #ddd;margin-top:24px;padding-top:16px;font-size:14px;color:#555">` +
  `<strong>The frontier</strong><br />` +
  `Point me at the tracks you love and I'll dig through the archive for more.<br />` +
  `<a href="${FRONTIER_TEASER_URL}">Open the frontier</a></p>`;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function trackLabel(track: TrackListItem): string {
  const artist = track.artists.join(", ").trim();
  return artist ? `${artist} — ${track.title}` : track.title;
}

export function editionLogIds(edition: EditionDTO): string[] {
  const ids: string[] = [];

  for (const block of edition.content.galaxies ?? []) {
    for (const finding of block.findings) {
      ids.push(finding.logId);
    }
  }

  if (edition.content.mixtapeRef?.trim()) {
    ids.push(edition.content.mixtapeRef.trim());
  }

  return ids;
}

export async function editionsLabels(editions: EditionDTO[]): Promise<Record<string, string>> {
  const ids = [...new Set(editions.flatMap(editionLogIds))];
  const tracks = await getTracksByLogIds(ids);
  const labels: Record<string, string> = {};

  for (const id of ids) {
    const track = tracks[id];
    labels[id] = track ? trackLabel(track) : id;
  }

  return labels;
}

export async function renderEditionEmailHtml(edition: EditionDTO): Promise<string> {
  const { content } = edition;
  const tracksByLogId = await getTracksByLogIds(editionLogIds(edition));
  const parts: string[] = [];

  parts.push("<p>Ahoy cosmonauts,</p>");

  if (content.intro?.trim()) {
    parts.push(`<p>${escapeHtml(content.intro)}</p>`);
  }

  for (const block of content.galaxies ?? []) {
    if (block.galaxy.trim()) {
      parts.push(`<h2>${escapeHtml(block.galaxy)}</h2>`);
    }
    parts.push("<ul>");

    for (const finding of block.findings) {
      const track = tracksByLogId[finding.logId];
      const href = logPageUrl(finding.logId);
      const label = track ? trackLabel(track) : finding.logId;

      const why = finding.why?.trim()
        ? `<br /><span style="color:#555">${escapeHtml(finding.why)}</span>`
        : "";
      parts.push(`<li><a href="${escapeHtml(href)}">${escapeHtml(label)}</a>${why}</li>`);
    }

    parts.push("</ul>");
  }

  if (content.mixtapeRef?.trim()) {
    const ref = content.mixtapeRef.trim();
    const track = tracksByLogId[ref];
    const href = logPageUrl(ref);
    const label = track ? trackLabel(track) : ref;
    parts.push(`<p>And a new mixtape: <a href="${escapeHtml(href)}">${escapeHtml(label)}</a></p>`);
  }

  if (content.tidbits?.length) {
    parts.push("<h2>From the wider cosmos</h2>");
    parts.push("<ul>");

    for (const tidbit of content.tidbits) {
      const link = tidbit.source?.trim()
        ? ` (<a href="${escapeHtml(tidbit.source)}">source</a>)`
        : "";
      parts.push(`<li>${escapeHtml(tidbit.text)}${link}</li>`);
    }

    parts.push("</ul>");
  }

  parts.push("<p>Happy raving,<br />Fluncle</p>");

  parts.push(FRONTIER_TEASER_HTML);

  parts.push(
    `<hr /><p style="font-size:12px;color:#888">` +
      `<a href="{{{RESEND_UNSUBSCRIBE_URL}}}">Unsubscribe</a> · ` +
      `<a href="${siteUrl}/newsletter">Back issues</a><br />${escapeHtml(POSTAL_ADDRESS)}</p>`,
  );

  return `<!doctype html><html><body>${parts.join("")}</body></html>`;
}
