package main

import (
	"fmt"
	"strconv"
	"strings"
)

// txtVersion tags the TXT format so a parser can reject formats it does not
// understand. Bump it on any breaking change to the key set or grammar.
const txtVersion = "fluncle1"

// maxTXTString is the hard per-string ceiling in a TXT record (RFC 1035: one
// length octet). We keep a margin and split fields across strings instead of
// truncating a value.
const maxTXTString = 255

// buildTXT renders a finding as one logical TXT record: a slice of strings,
// each <= 255 bytes, that concatenate (no separator) into a single
// "v=fluncle1; id=...; ..." payload. dig prints each string quoted on its own;
// a parser joins them and splits on "; ".
//
// Grammar: key=value pairs joined by "; ". Keys are stable and lowercase.
// Values are single-line; any literal ';' inside a value is escaped as ',' to
// keep the separator unambiguous (titles rarely contain ';').
func buildTXT(t *track, c config) []string {
	pairs := []string{
		kv("v", txtVersion),
		kv("id", t.LogID),
		kv("artist", strings.Join(t.Artists, ", ")),
		kv("title", t.Title),
	}
	if t.Album != "" {
		pairs = append(pairs, kv("album", t.Album))
	}
	if t.BPM > 0 {
		pairs = append(pairs, kv("bpm", strconv.FormatFloat(t.BPM, 'f', -1, 64)))
	}
	if t.Key != "" {
		pairs = append(pairs, kv("key", t.Key))
	}
	if found := foundDate(t); found != "" {
		pairs = append(pairs, kv("found", found))
	}
	url := t.LogPageURL
	if url == "" && t.LogID != "" {
		url = fmt.Sprintf("%s/log/%s", c.APIBase, t.LogID)
	}
	if url != "" {
		pairs = append(pairs, kv("url", url))
	}
	if t.SpotifyURL != "" {
		pairs = append(pairs, kv("spotify", t.SpotifyURL))
	}

	return splitStrings(strings.Join(pairs, "; "))
}

// buildLiveTXT renders the live-set callout (the `live` label) as one TXT record:
// always `v=fluncle1; live=0|1`, and when on, the Twitch url + stream title. A
// machine-readable sibling of the web banner / SSH line — "is Fluncle on the decks".
func buildLiveTXT(info liveInfo) []string {
	on := "0"
	if info.On {
		on = "1"
	}
	pairs := []string{kv("v", txtVersion), kv("live", on)}
	if info.On {
		if info.URL != "" {
			pairs = append(pairs, kv("url", info.URL))
		}
		if info.Title != "" {
			pairs = append(pairs, kv("title", info.Title))
		}
	}
	return splitStrings(strings.Join(pairs, "; "))
}

// kv formats one pair, escaping the separator characters so the payload stays
// machine-splittable on "; ".
func kv(key, value string) string {
	value = strings.ReplaceAll(value, "\n", " ")
	value = strings.ReplaceAll(value, "\r", " ")
	// Protect the field separator: a literal ';' in a value would confuse a
	// naive split, so downgrade it to a comma.
	value = strings.ReplaceAll(value, ";", ",")
	return key + "=" + value
}

// foundDate returns the YYYY-MM-DD a finding was found (the day it entered the
// log), which is addedAt per the Found Rule, falling back to releaseDate.
func foundDate(t *track) string {
	if t.AddedAt != "" {
		if len(t.AddedAt) >= 10 {
			return t.AddedAt[:10]
		}
		return t.AddedAt
	}
	return t.ReleaseDate
}

// splitStrings chops a payload into <=255-byte chunks on a "; " boundary where
// possible so each emitted string is still a clean run of complete pairs; it
// falls back to a hard byte split only if a single pair exceeds the limit.
func splitStrings(payload string) []string {
	if len(payload) <= maxTXTString {
		return []string{payload}
	}
	var out []string
	rest := payload
	for len(rest) > maxTXTString {
		cut := strings.LastIndex(rest[:maxTXTString+1], "; ")
		if cut <= 0 {
			cut = maxTXTString
		}
		out = append(out, rest[:cut])
		rest = rest[cut:]
	}
	if rest != "" {
		out = append(out, rest)
	}
	return out
}
