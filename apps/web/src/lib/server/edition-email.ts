import { type EditionDTO, type TrackListItem } from "@fluncle/contracts";
import { logPageUrl, siteUrl } from "../fluncle-links";
import { getTracksByLogIds } from "./tracks";

// The footer sign-off line (the slot CAN-SPAM reserves for a postal address).
// While the list is friends + family this stays a cosmic sign-off; swap it for a
// real physical mailing address here once the audience grows past F&F.
const POSTAL_ADDRESS = "With love, from somewhere deep in the galaxy, Fluncle";

// The per-listener Frontier shelf, on the site. The teaser links every recipient
// here (one HTML for all — no per-recipient personalization).
export const FRONTIER_TEASER_URL = `${siteUrl}/recommendations`;

// The Frontier teaser: EMAIL-ONLY chrome, the compliance footer's class of thing —
// always rendered in the email, never part of the stored `content`, never on the
// /newsletter archive page. One quiet block for every recipient, pointing the crew
// at their shelf on the site. The copy is honest across every reader state: signed
// out lands on a door that asks you to join the crew, unverified on the verify
// pointer, verified on the working shelf — so it INVITES you to point Fluncle at
// your taste (the door's own pitch), it never promises a shelf already dug.
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

/** `Artist — Title` for a hydrated finding (the em dash is the only one allowed). */
export function trackLabel(track: TrackListItem): string {
  const artist = track.artists.join(", ").trim();
  return artist ? `${artist} — ${track.title}` : track.title;
}

/** Collect every logId an edition references (each galaxy's findings + the mixtape). */
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

/**
 * Hydrate every logId across the given editions to its `Artist — Title` label in ONE
 * batched read (bare logId fallback for a find with no live track). Server-side — the
 * web newsletter renders call this in their loaders and pass the label strings to the
 * client, mirroring the email render's hydration.
 */
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

/**
 * Render the email HTML for a Resend broadcast from an edition's stored content —
 * the SAME `content` payload the web archive page renders (one source → two
 * renders). This is the Email-register
 * letter: the "Ahoy cosmonauts," greeting, the galaxy-grouped finds, the tidbits,
 * the "Happy raving, Fluncle" sign-off, and the compliance footer — the managed
 * `{{{RESEND_UNSUBSCRIBE_URL}}}` token Resend substitutes per-recipient (it adds the
 * RFC-8058 one-click `List-Unsubscribe` headers for bulk) plus the postal address.
 *
 * Each finding reference is the tiny `{ logId, why }` the schema keeps current; the
 * render HYDRATES every `logId` to its live finding (`Artist — Title` linked to the
 * `/log` page) in ONE batched read (no N+1) — so the email always
 * carries the live metadata, not a bare Log ID. A logId with no live finding falls
 * back to the bare Log ID linked to its (still valid) log page.
 *
 * Async because the hydration needs the live track rows; `send_edition` awaits it.
 *
 * Phase-1 note: this is a clean self-contained HTML render of the structured
 * payload, NOT a fill of `docs/agents/newsletter-template.lmx`. Adopting the LMX
 * template's exact styling is a deferred follow-up (the payload → both renders
 * contract is already satisfied; only the email's visual chrome is interim).
 */
export async function renderEditionEmailHtml(edition: EditionDTO): Promise<string> {
  const { content } = edition;
  const tracksByLogId = await getTracksByLogIds(editionLogIds(edition));
  const parts: string[] = [];

  parts.push("<p>Ahoy cosmonauts,</p>");

  if (content.intro?.trim()) {
    parts.push(`<p>${escapeHtml(content.intro)}</p>`);
  }

  for (const block of content.galaxies ?? []) {
    // The newsletter no longer groups by galaxy — a block with an empty label is a
    // single flat list, so skip the header. (A non-empty label still renders.)
    if (block.galaxy.trim()) {
      parts.push(`<h2>${escapeHtml(block.galaxy)}</h2>`);
    }
    parts.push("<ul>");

    for (const finding of block.findings) {
      const track = tracksByLogId[finding.logId];
      const href = logPageUrl(finding.logId);
      const label = track ? trackLabel(track) : finding.logId;
      // The web twin sets the "why" apart typographically instead of punctuating it (a
      // quiet span under the label, `.log-newsletter-why`); the email has no stylesheet,
      // so it does the same with a break and an inline colour. NOT a dash join: the label
      // above already spends the one em dash VOICE.md §6 sanctions (`Artist — Title`), and
      // the email is a crew surface, outside the operator tier's clause-join carve-out.
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

  // The Frontier teaser (email-only chrome, see FRONTIER_TEASER_HTML): a standing
  // pointer to the per-listener shelf, sitting after the letter and before the
  // compliance footer. Independent of the authored content — always rendered.
  parts.push(FRONTIER_TEASER_HTML);

  // The compliance footer: the managed unsubscribe token (Resend substitutes it
  // per-recipient and adds the one-click List-Unsubscribe headers) + the postal
  // address. The triple-mustache is intentional — Resend's variable syntax.
  parts.push(
    `<hr /><p style="font-size:12px;color:#888">` +
      `<a href="{{{RESEND_UNSUBSCRIBE_URL}}}">Unsubscribe</a> · ` +
      `<a href="${siteUrl}/newsletter">Back issues</a><br />${escapeHtml(POSTAL_ADDRESS)}</p>`,
  );

  return `<!doctype html><html><body>${parts.join("")}</body></html>`;
}
