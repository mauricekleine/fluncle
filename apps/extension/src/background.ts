// The service worker keeps the toolbar badge in sync with what each tab's content
// script found. The badge is per-tab (set with the sender's tabId), capped at "9+",
// and gold on the deep field. It does no network and holds no page data — it just
// relays a count the content script computed locally.

import { type BadgeMessage } from "./types";

const BADGE_BG = "#f5b800"; // eclipseGold
const BADGE_TEXT = "#151006"; // inkOnGold

chrome.runtime.onMessage.addListener((message: BadgeMessage, sender) => {
  if (message.type !== "lens:badge") {
    return;
  }

  const tabId = sender.tab?.id;

  if (tabId === undefined) {
    return;
  }

  const text = message.count === 0 ? "" : message.count > 9 ? "9+" : String(message.count);

  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: BADGE_BG, tabId }).catch(() => {});

  // setBadgeTextColor lands on recent Chrome; ignore where unsupported.
  chrome.action.setBadgeTextColor?.({ color: BADGE_TEXT, tabId }).catch(() => {});
});
