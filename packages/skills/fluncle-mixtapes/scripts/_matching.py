"""Shared pure matching logic — normalized title + artist identity.

Lifted verbatim from fluncle-key-backfill/scripts/key_backfill.py so both the
Rekordbox derivation script and the plan-export script share one canonical copy.
No external dependencies; no I/O.

`match_key(artists, title)` → (frozenset[str], base_title, descriptor)

Two rows share the same identity iff their `match_key` tuples are equal.  A
REMIX / VIP / EDIT is a DIFFERENT recording (different descriptor) and will
never collapse onto the original.
"""

from __future__ import annotations

import re
import unicodedata

# Words that promote a parenthetical/dash suffix to a distinct VERSION of the
# recording — keeps a remix from matching the original.
_VERSION_WORDS = {
    "remix", "rmx", "vip", "edit", "bootleg", "rework", "refix", "flip",
    "dub", "version", "mix", "instrumental", "extended", "remaster",
}

# Neutral version descriptors that name a variant but are NOT distinguishing.
_NEUTRAL_DESCRIPTORS = {"original mix", "original", "extended mix"}

_ARTIST_SPLIT = re.compile(r"\s*(?:,|&|/|\band\b|\bx\b|\bvs\b|\bversus\b|\bwith\b)\s*")
_FEAT_INLINE = re.compile(r"\b(?:feat|ft|featuring)\b\.?.*$", re.IGNORECASE)
_PUNCT = re.compile(r"[^a-z0-9 ]+")
_WS = re.compile(r"\s+")


def _strip_accents(text: str) -> str:
    decomposed = unicodedata.normalize("NFKD", text)
    return "".join(ch for ch in decomposed if not unicodedata.combining(ch))


def _fold(text: str) -> str:
    """Lowercase, strip accents, fold `&`→`and`, drop punctuation, collapse spaces."""
    folded = _strip_accents(text).lower().replace("&", " and ")
    folded = _PUNCT.sub(" ", folded)
    return _WS.sub(" ", folded).strip()


def _normalize_artists(artists: object) -> frozenset[str]:
    """A set of individual, folded artist names — order- and separator-agnostic.

    Accepts a list (Fluncle DTO) or a single string (Rekordbox `ArtistName`).
    Drops `feat.` credits so a Rekordbox "A feat. B" matches a Fluncle ["A"].
    """
    if isinstance(artists, (list, tuple)):
        raw = ", ".join(str(a) for a in artists)
    else:
        raw = str(artists or "")

    raw = _FEAT_INLINE.sub("", raw)
    parts = _ARTIST_SPLIT.split(raw)
    names = {_fold(part) for part in parts}
    return frozenset(name for name in names if name)


def _split_title(title: str) -> tuple[str, str]:
    """(base_title, descriptor) — base with feat./mix suffixes removed + the version
    descriptor ("" for the original recording)."""
    working = str(title or "")
    descriptor = ""

    # Trailing parenthetical / bracket groups, right to left.
    for match in reversed(list(re.finditer(r"[\(\[]([^\)\]]*)[\)\]]", working))):
        inner = match.group(1)
        folded_inner = _fold(inner)

        if not folded_inner:
            working = working[: match.start()] + working[match.end():]
            continue

        # A feat. credit in the title is not a version — drop it from the base.
        if re.match(r"^(?:feat|ft|featuring)\b", folded_inner):
            working = working[: match.start()] + working[match.end():]
            continue

        tokens = set(folded_inner.split())

        if tokens & _VERSION_WORDS:
            if folded_inner not in _NEUTRAL_DESCRIPTORS:
                descriptor = folded_inner
            working = working[: match.start()] + working[match.end():]
        else:
            # A non-version parenthetical (a subtitle) — drop it from base but keep
            # it non-distinguishing so a stored/absent subtitle still matches.
            working = working[: match.start()] + working[match.end():]

    # A dash-suffixed version: "Song - Calibre Remix".
    dash = re.search(r"\s[-–—]\s(.+)$", working)

    if dash:
        folded_suffix = _fold(dash.group(1))
        suffix_tokens = set(folded_suffix.split())

        if suffix_tokens & _VERSION_WORDS:
            if folded_suffix not in _NEUTRAL_DESCRIPTORS and not descriptor:
                descriptor = folded_suffix
            working = working[: dash.start()]

    # Drop an inline feat. from the base title too.
    working = _FEAT_INLINE.sub("", working)
    return _fold(working), descriptor


def match_key(artists: object, title: str) -> tuple[frozenset[str], str, str]:
    """The identity tuple two rows must share to represent the same recording.

    Returns (artist_set, base_title, version_descriptor).  Pure + deterministic.
    """
    base, descriptor = _split_title(title)
    return (_normalize_artists(artists), base, descriptor)
