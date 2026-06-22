import { type EditionDTO } from "@fluncle/contracts";
import { logPageUrl, siteUrl } from "../fluncle-links";

// The postal address line CAN-SPAM requires in every bulk send's footer
// (docs/rfcs/newsletter-own-the-stack.md §4.3). A placeholder until the real
// address is wired as config — flagged in the PR as an operator step.
const POSTAL_ADDRESS = "Fluncle · the mothership · somewhere in the cosmos";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Render the email HTML for a Resend broadcast from an edition's stored content —
 * the SAME `content` payload the web archive page renders (one source → two
 * renders, docs/rfcs/newsletter-own-the-stack.md §2.6). This is the Email-register
 * letter: the "Ahoy cosmonauts," greeting, the galaxy-grouped finds (each linked to
 * its own `/log` page), the tidbits, the "Happy raving, Fluncle" sign-off, and the
 * compliance footer — the managed `{{{RESEND_UNSUBSCRIBE_URL}}}` token Resend
 * substitutes per-recipient (it adds the RFC-8058 one-click `List-Unsubscribe`
 * headers for bulk) plus the postal address.
 *
 * Phase-1 note: this is a clean self-contained HTML render of the structured
 * payload, NOT a fill of `docs/agents/newsletter-template.lmx`. Adopting the LMX
 * template's exact styling is a deferred follow-up (the payload → both renders
 * contract is already satisfied; only the email's visual chrome is interim).
 */
export function renderEditionEmailHtml(edition: EditionDTO): string {
  const { content } = edition;
  const parts: string[] = [];

  parts.push("<p>Ahoy cosmonauts,</p>");

  if (content.intro?.trim()) {
    parts.push(`<p>${escapeHtml(content.intro)}</p>`);
  }

  for (const block of content.galaxies ?? []) {
    parts.push(`<h2>${escapeHtml(block.galaxy)}</h2>`);
    parts.push("<ul>");

    for (const finding of block.findings) {
      const href = logPageUrl(finding.logId);
      const why = finding.why?.trim() ? ` — ${escapeHtml(finding.why)}` : "";
      parts.push(`<li><a href="${escapeHtml(href)}">${escapeHtml(finding.logId)}</a>${why}</li>`);
    }

    parts.push("</ul>");
  }

  if (content.mixtapeRef?.trim()) {
    const href = logPageUrl(content.mixtapeRef);
    parts.push(
      `<p>And a new mixtape: <a href="${escapeHtml(href)}">${escapeHtml(content.mixtapeRef)}</a></p>`,
    );
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
