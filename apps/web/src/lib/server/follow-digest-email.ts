import { followDigestCopy } from "./follow-digest-copy";

export type FollowDigestRelease = {
  artists: string;
  coverUrl?: string;
  followName: string;
  href: string;
  title: string;
};

export function escapeFollowDigestHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      '"': "&quot;",
      "&": "&amp;",
      "'": "&#39;",
      "<": "&lt;",
      ">": "&gt;",
    };
    return entities[character] ?? character;
  });
}

function safeHttpsUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:") {
    throw new Error("Digest links must use HTTPS");
  }
  return escapeFollowDigestHtml(url.toString());
}

function plainText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function renderFollowDigestEmail(input: {
  items: FollowDigestRelease[];
  manageUrl: string;
  more: boolean;
  unsubscribeUrl: string;
}): { html: string; subject: string; text: string } {
  const manageUrl = safeHttpsUrl(input.manageUrl);
  const unsubscribeUrl = safeHttpsUrl(input.unsubscribeUrl);
  const items = input.items.map((item) => {
    const href = safeHttpsUrl(item.href);
    const title = escapeFollowDigestHtml(item.title);
    const artists = escapeFollowDigestHtml(item.artists);
    const because = escapeFollowDigestHtml(followDigestCopy.because(item.followName));
    const cover = item.coverUrl
      ? `<a href="${href}" style="color:#b7ab95;font-size:11px;text-decoration:none"><img src="${safeHttpsUrl(item.coverUrl)}" alt="Cover for ${title}" width="64" height="64" style="width:64px;height:64px;object-fit:cover;border-radius:4px;display:block;color:#b7ab95;font-size:11px"></a>`
      : "";
    return `<tr><td width="64" style="width:64px;padding:10px 12px 10px 0;vertical-align:top">${cover}</td><td style="padding:10px 0;vertical-align:top"><a href="${href}" style="color:#f4ead7;font-weight:700;text-decoration:none">${artists} — ${title}</a><div style="color:#b7ab95;font-size:13px">${because}</div></td></tr>`;
  });
  const moreHtml = input.more
    ? `<p><a href="https://www.fluncle.com/fresh" style="color:#f5b800">${escapeFollowDigestHtml(followDigestCopy.more)}</a></p>`
    : "";
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="dark"><meta name="supported-color-schemes" content="dark"><title>${escapeFollowDigestHtml(followDigestCopy.subject)}</title></head><body style="margin:0;background:#090a0b;color:#f4ead7;font-family:Arial,sans-serif"><div style="display:none;max-height:0;overflow:hidden">${escapeFollowDigestHtml(followDigestCopy.preheader)}</div><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#090a0b"><tr><td align="center" style="padding:24px 12px"><table role="presentation" width="560" cellpadding="0" cellspacing="0" style="width:100%;max-width:560px;background:#10100d"><tr><td style="padding:28px 20px"><p style="margin:0 0 20px;font-size:13px;font-weight:700;letter-spacing:0.12em;color:#f5b800">FLUNCLE</p><p>${escapeFollowDigestHtml(followDigestCopy.greeting)}</p><p>${escapeFollowDigestHtml(followDigestCopy.intro)}</p><table role="presentation" style="width:100%;border-collapse:collapse">${items.join("")}</table>${moreHtml}<p style="color:#f4ead7;font-size:13px;white-space:pre-line">${escapeFollowDigestHtml(followDigestCopy.footer)}</p><p style="font-size:13px;line-height:2"><a href="${manageUrl}" style="color:#f5b800;padding:6px 0">${escapeFollowDigestHtml(followDigestCopy.manage)}</a><br><a href="${unsubscribeUrl}" style="color:#f5b800;padding:6px 0">${escapeFollowDigestHtml(followDigestCopy.unsubscribe)}</a></p></td></tr></table></td></tr></table></body></html>`;
  const text = [
    followDigestCopy.greeting,
    "",
    followDigestCopy.intro,
    "",
    ...input.items.flatMap((item) => [
      `${plainText(item.artists)} — ${plainText(item.title)}`,
      followDigestCopy.because(plainText(item.followName)),
      item.href,
      "",
    ]),
    ...(input.more ? [followDigestCopy.more, "https://www.fluncle.com/fresh", ""] : []),
    followDigestCopy.footer,
    `${followDigestCopy.manage}: ${input.manageUrl}`,
    `${followDigestCopy.unsubscribe}: ${input.unsubscribeUrl}`,
  ].join("\n");
  return { html, subject: followDigestCopy.subject, text };
}
