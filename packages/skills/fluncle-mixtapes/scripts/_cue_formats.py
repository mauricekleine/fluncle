"""Pure plan-export formatters — Python port of `@fluncle/contracts/util/tracklist-export.ts`.

All functions are stateless.  Input: an ordered list of cue dicts with at least
  {"artists": list[str], "title": str}
Output: a string (or list of strings) the operator can paste, click, or load.

The Rekordbox direct-DB-write leg lives in `rekordbox-plan-export.py`.
"""

from __future__ import annotations

from urllib.parse import quote


def format_artists(artists: list[str]) -> str:
    """Join multiple artists with `, ` (the Fluncle multi-artist separator)."""
    return ", ".join(artists)


def track_label(artists: list[str], title: str) -> str:
    """Canonical `Artist(s) — Title` label."""
    return f"{format_artists(artists)} — {title}"


def beatport_search_links(cues: list[dict]) -> list[str]:
    """One Beatport search URL per cue, URL-encoded.

    Format: ``https://www.beatport.com/search?q=<artist(s)%20title>``.
    No open add-to-cart API (partner-gated) — operator clicks through to buy.
    """
    urls: list[str] = []
    for cue in cues:
        artists: list[str] = cue.get("artists", [])
        title: str = cue.get("title", "")
        q = quote(f"{format_artists(artists)} {title}")
        urls.append(f"https://www.beatport.com/search?q={q}")
    return urls


def m3u8(cues: list[dict], title: str | None = None) -> str:
    """Extended-M3U playlist string for the ordered tracklist.

    Metadata only — no local file paths (the script doesn't know where the
    operator's audio files live).  A reference list / labelled cue sheet.
    The pyrekordbox direct-DB-write is the loadable-into-Rekordbox form.
    """
    lines: list[str] = ["#EXTM3U"]
    if title:
        lines.append(f"#PLAYLIST:{title}")
    for cue in cues:
        artists: list[str] = cue.get("artists", [])
        t: str = cue.get("title", "")
        lines.append(f"#EXTINF:-1,{track_label(artists, t)}")
    return "\n".join(lines)


def checklist(cues: list[dict]) -> str:
    """Plain numbered checklist: ``1. Artist(s) — Title``, one per line.
    Copy-paste-friendly; works in notes, emails, or a USB folder README.
    """
    return "\n".join(
        f"{i + 1}. {track_label(cue.get('artists', []), cue.get('title', ''))}"
        for i, cue in enumerate(cues)
    )
