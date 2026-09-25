import { type BadgeMessage } from "./types";

const BADGE_BG = "#f5b800";
const BADGE_TEXT = "#151006";

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

  chrome.action.setBadgeTextColor?.({ color: BADGE_TEXT, tabId })?.catch(() => {});
});
