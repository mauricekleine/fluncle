Fluncle Lens — Chrome Extension Brief

Build a Chrome extension called Fluncle Lens.

Goal

Detect fluncle:// coordinates anywhere on the web and make them usable.

Example coordinate:

fluncle://007.0.0Z

When detected, the extension should enhance the coordinate into a clickable object that links to the canonical Fluncle page:

https://www.fluncle.com/log/007.0.0Z

The product language is:

Fluncle Lens reveals hidden Fluncle signals across the web.

Scope

The extension should work on any webpage, not only specific platforms.

Coordinates may appear on:

YouTube
TikTok
X
Reddit
Instagram
SoundCloud
Mixcloud
Blogs
Forums
Docs
Any normal webpage

Use broad page access because the whole point is that fluncle:// coordinates can be hidden anywhere.

Privacy rule

The extension must scan pages locally only.

Do not send page content, URLs, DOM text, or browsing history to any server.

Allowed network call:

GET https://www.fluncle.com/api/tracks/<id>

Only call this after a valid fluncle:// coordinate has been detected.

Coordinate format

Detect coordinates like:

fluncle://007.0.0Z
fluncle://018.8.9J
fluncle://005.3.6C

Use a regex along these lines:

/\bfluncle:\/\/([0-9]{3}\.[0-9]\.[0-9A-Z]+)\b/gi

Preserve the displayed coordinate exactly as written.

Use lowercase only when generating DNS commands.

Example:

Display: fluncle://007.0.0Z
DNS: 007.0.0z.dig.fluncle.com

Core behavior

- Run a content script on all normal webpages.
- Scan visible text nodes for fluncle:// coordinates.
- Replace detected coordinate text with an <a> element.
- Link target: https://www.fluncle.com/log/<id>.
- Use target="\_blank" and rel="noopener noreferrer".
- Style subtly: underline, small highlight, no layout breakage.
- Add an internal marker so nodes are not processed twice.
- Use MutationObserver for dynamic/SPAs like YouTube and TikTok.
- Debounce mutation handling.
- Prefer scanning only added/changed nodes instead of rescanning the full DOM every time.

Skip these elements

Do not scan or modify text inside:

input
textarea
select
button
script
style
code
pre
kbd
samp
[contenteditable="true"]

Also skip:

already-processed nodes
hidden nodes where practical
extension UI nodes

Metadata enhancement

After linkifying a coordinate, fetch track metadata:

GET https://www.fluncle.com/api/tracks/<id>

Use the response to show a hover card or tooltip.

Minimum fields to display if available:

artist
title
album/release
label
year
bpm
key
found date
spotify url
canonical url

Hover card actions:

Open in Fluncle
Open Spotify
Copy coordinate
Copy web URL
Copy dig command
Copy SSH command

Extension popup

When the user clicks the extension icon, show:

<number> signals detected

List all detected coordinates on the current page.

For each signal, show:

coordinate
artist/title if metadata loaded
Open
Copy coordinate
Copy web URL
Copy dig command
Copy SSH command

Commands:

dig <lowercase-id>.dig.fluncle.com TXT +short
ssh rave.fluncle.com <id>

Example:

dig 007.0.0z.dig.fluncle.com TXT +short
ssh rave.fluncle.com 007.0.0Z

UX copy

Use “signals” language.

Examples:

1 signal detected
3 signals found on this page
Open signal
Copy coordinate
Signal resolved
No signals detected

Icon/badge behavior

- If no coordinates are found: no badge.
- If coordinates are found: badge shows count.
- Cap badge text at 9+.
- Popup should still show the full list.

Manifest

Use Chrome Manifest V3.

Because this should work anywhere, use:

{
"manifest_version": 3,
"name": "Fluncle Lens",
"version": "0.1.0",
"description": "Reveal hidden Fluncle signals across the web.",
"permissions": ["activeTab", "storage"],
"host_permissions": [
"<all_urls>",
"https://www.fluncle.com/*"
],
"content_scripts": [
{
"matches": ["<all_urls>"],
"js": ["content.js"],
"run_at": "document_idle"
}
],
"action": {
"default_title": "Fluncle Lens",
"default_popup": "popup.html"
}
}

If Chrome rejects or warns heavily during review, fallback strategy:

Use optional host permissions
Ask user to enable “Scan all websites”
Explain that broad access is required because signals can appear anywhere

Settings

Add a minimal options screen or popup toggle:

Scan all websites: on/off
Show hover cards: on/off
Link target: Fluncle website

Future link target options, not required for MVP:

web+fluncle handler
native fluncle:// handler

Non-goals for MVP

Do not build these yet:

native fluncle:// protocol handling
web+fluncle:// protocol handler
new tab page
track submission from current page
browser account/sync system
Firefox/Safari support
complex radar UI
game integration
collection syncing

Acceptance criteria

- On any webpage containing fluncle://007.0.0Z, the coordinate becomes clickable.
- Clicking opens https://www.fluncle.com/log/007.0.0Z in a new tab.
- YouTube Shorts descriptions work.
- TikTok captions/descriptions work.
- Dynamic page navigation still works.
- Coordinates are not processed twice.
- Text inputs and code blocks are not modified.
- Popup lists detected coordinates.
- Popup copy actions work.
- Badge count updates when signals are found.
- No page content is sent anywhere.
- No console errors during normal browsing.
