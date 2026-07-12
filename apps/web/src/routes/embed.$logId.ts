import { createFileRoute } from "@tanstack/react-router";
import { siteUrl } from "@/lib/fluncle-links";
import { formatDateLong } from "@/lib/format";
import { artistTitleLine } from "@/lib/log-prose";
import { albumCoverAtSize, trackMedia } from "@/lib/media";
import { mixtapeCoverUrl, mixtapeDisplayTitle } from "@/lib/mixtapes";
import { requireParam } from "@/lib/server/http-errors";
import { resolveLogPageTarget } from "@/lib/server/log-resolver";

// The self-contained finding card that the oEmbed `rich` payload frames. A pasted
// fluncle.com link unfurls (in Notion / WordPress / Ghost / …) as this <iframe>:
// a dark, cover-led plate with the coordinate, the Artist — Title, the found date,
// a Spotify open action, and a quiet link back to the /log page.
//
// It is a STANDALONE HTML document (inline CSS, no SPA shell, no external assets),
// so the iframe is tiny and fast, and — unlike every other page — it is served with
// a permissive `frame-ancestors *` CSP so third parties may frame it. That header
// is set on THIS route's Response only; the rest of the site emits no framing
// header and keeps its default posture. The canon palette (DESIGN.md's Nostalgic
// Cosmos) is inlined; the sanctioned font fallback (system sans) keeps it font-load
// free.

// Frame-ancestors is the modern, iframe-scoped successor to X-Frame-Options; `*`
// lets any site embed this route, and setting NO X-Frame-Options means an old
// browser doesn't fall back to a DENY. Scoped to this route only.
const EMBED_HEADERS = {
  "Cache-Control": "public, max-age=3600",
  "Content-Security-Policy": "frame-ancestors *",
  "Content-Type": "text/html; charset=utf-8",
} as const;

const COLOR = {
  bg: "#090a0b",
  cream: "#f4ead7",
  gold: "#f5b800",
  ink: "#151006",
  rule: "#3a342a",
  stardust: "#b7ab95",
  tape: "#171611",
} as const;

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

type CardModel = {
  actionHref: string | undefined;
  actionLabel: string | undefined;
  artist: string;
  coverUrl: string | undefined;
  dateLabel: string;
  dateValue: string | undefined;
  logId: string;
  nameplate: string;
  title: string;
};

function cardDocument(card: CardModel): string {
  const logPageUrl = `${siteUrl}/log/${encodeURIComponent(card.logId)}`;
  const cover = card.coverUrl
    ? `<img class="cover" src="${escapeHtml(card.coverUrl)}" alt="" width="132" height="132" />`
    : `<div class="cover cover-empty" aria-hidden="true"></div>`;
  const action =
    card.actionHref && card.actionLabel
      ? `<a class="action action-primary" href="${escapeHtml(card.actionHref)}" target="_blank" rel="noreferrer">${escapeHtml(card.actionLabel)}</a>`
      : "";
  const dateBlock = card.dateValue
    ? `<p class="meta"><span class="meta-label">${escapeHtml(card.dateLabel)}</span> ${escapeHtml(card.dateValue)}</p>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>${escapeHtml(card.title)} · Fluncle</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%}
body{background:${COLOR.bg};color:${COLOR.cream};font-family:ui-sans-serif,system-ui,sans-serif;line-height:1.3;-webkit-font-smoothing:antialiased}
a{color:inherit;text-decoration:none}
.card{display:flex;gap:16px;align-items:center;height:100%;min-height:0;padding:18px;background:${COLOR.tape};border:1px solid ${COLOR.rule};border-radius:14px;overflow:hidden}
.cover{flex:0 0 auto;width:132px;height:132px;object-fit:cover;border-radius:10px;background:${COLOR.bg}}
.cover-empty{border:1px solid ${COLOR.rule}}
.body{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:6px}
.nameplate{font-size:11px;font-weight:800;letter-spacing:3px;text-transform:uppercase;color:${COLOR.stardust}}
.coordinate{font-family:Oxanium,ui-sans-serif,system-ui,sans-serif;font-size:13px;font-weight:800;letter-spacing:.5px;color:${COLOR.gold}}
.title{font-size:19px;font-weight:800;letter-spacing:-.01em;color:${COLOR.cream};overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.artist{font-size:14px;color:${COLOR.stardust};overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.meta{font-size:12px;color:${COLOR.stardust};margin-top:2px}
.meta-label{color:${COLOR.cream};font-weight:700}
.actions{display:flex;flex-wrap:wrap;align-items:center;gap:14px;margin-top:8px}
.action-primary{display:inline-flex;align-items:center;padding:7px 14px;border-radius:999px;background:${COLOR.gold};color:${COLOR.ink};font-size:13px;font-weight:800}
.action-primary:hover{background:#ffd057}
.action-quiet{font-size:13px;font-weight:700;color:${COLOR.stardust};border-bottom:1px solid ${COLOR.rule};padding-bottom:1px}
.action-quiet:hover{color:${COLOR.cream}}
:focus-visible{outline:2px solid ${COLOR.gold};outline-offset:2px;border-radius:4px}
@media (max-width:360px){.card{flex-direction:column;text-align:center;align-items:center}.artist{white-space:normal}}
</style>
</head>
<body>
<article class="card">
${cover}
<div class="body">
<p class="nameplate">${escapeHtml(card.nameplate)}</p>
<a class="coordinate" href="${escapeHtml(logPageUrl)}" target="_blank" rel="noreferrer">fluncle://${escapeHtml(card.logId)}</a>
<h1 class="title">${escapeHtml(card.title)}</h1>
<p class="artist">${escapeHtml(card.artist)}</p>
${dateBlock}
<div class="actions">
${action}
<a class="action-quiet" href="${escapeHtml(logPageUrl)}" target="_blank" rel="noreferrer">Open the log</a>
</div>
</div>
</article>
</body>
</html>`;
}

export const Route = createFileRoute("/embed/$logId")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const logId = requireParam(params.logId, "logId");
        const resolved = await resolveLogPageTarget(logId);

        if (!resolved) {
          return new Response("Not found", { status: 404 });
        }

        let card: CardModel;

        if (resolved.kind === "mixtape") {
          const { mixtape } = resolved;
          const resolvedLogId = mixtape.logId ?? logId;
          const externalUrl =
            mixtape.externalUrls.mixcloud ??
            mixtape.externalUrls.youtube ??
            mixtape.externalUrls.soundcloud;
          const actionLabel = mixtape.externalUrls.mixcloud
            ? "Listen on Mixcloud"
            : mixtape.externalUrls.youtube
              ? "Watch on YouTube"
              : mixtape.externalUrls.soundcloud
                ? "Listen on SoundCloud"
                : undefined;

          card = {
            actionHref: externalUrl,
            actionLabel,
            artist: "Fluncle",
            coverUrl: mixtapeCoverUrl(resolvedLogId, "card"),
            dateLabel: mixtape.recordedAt ? "Recorded" : "Found",
            dateValue: mixtape.recordedAt
              ? formatDateLong(mixtape.recordedAt)
              : mixtape.addedAt
                ? formatDateLong(mixtape.addedAt)
                : undefined,
            logId: resolvedLogId,
            nameplate: `Mixtape No. ${mixtape.sequenceNumber ?? 1}`,
            title: mixtapeDisplayTitle(mixtape.title),
          };
        } else {
          const { track } = resolved;
          const resolvedLogId = track.logId ?? logId;

          card = {
            actionHref: track.spotifyUrl,
            actionLabel: "Listen on Spotify",
            artist: track.artists.join(", "),
            coverUrl:
              albumCoverAtSize(track.albumImageUrl, "large") ?? trackMedia(resolvedLogId).coverUrl,
            dateLabel: "Found",
            dateValue: formatDateLong(track.addedAt),
            logId: resolvedLogId,
            nameplate: "Fluncle's Findings",
            title: artistTitleLine(track),
          };
        }

        return new Response(cardDocument(card), { headers: EMBED_HEADERS });
      },
    },
  },
});
