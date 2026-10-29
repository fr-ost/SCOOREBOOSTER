// ScoreX - Chrome desktop notifications and the toolbar badge. No remote channels.
//   red "!"   engine stopped by a safety trigger (until you resume or dismiss)
//   blue N    comments waiting for your review
//   green ON  running, nothing waiting
//   (empty)   paused / stopped by you

import { STATUS } from "./constants.js";
import { now } from "./util.js";

const COLORS = { alert: "#DC2626", review: "#2563EB", running: "#16A34A", paused: "#D97706" };
const ICON = "icons/icon128.png";

export async function notify(id, title, message, { requireInteraction = false } = {}) {
  try {
    await chrome.notifications.create(id || "sx-" + now(), {
      type: "basic",
      iconUrl: chrome.runtime.getURL(ICON),
      title: String(title).slice(0, 80),
      message: String(message).slice(0, 300),
      priority: requireInteraction ? 2 : 0,
      requireInteraction,
    });
  } catch (_) { /* notifications disabled at OS level */ }
}

export async function setBadge(state, pendingReview = 0) {
  let text = "", color = COLORS.running, title = "ScoreX";
  if (state.alert) { text = "!"; color = COLORS.alert; title = "ScoreX stopped: " + (state.alert.label || state.alert.reason); }
  else if (pendingReview > 0) { text = pendingReview > 99 ? "99+" : String(pendingReview); color = COLORS.review; title = `ScoreX: ${pendingReview} comment(s) to review`; }
  else if (state.status === STATUS.RUNNING) { text = "ON"; color = COLORS.running; title = "ScoreX is running"; }
  else if (state.status === STATUS.PAUSED) { text = "II"; color = COLORS.paused; title = "ScoreX is paused"; }
  try {
    await chrome.action.setBadgeText({ text });
    await chrome.action.setBadgeBackgroundColor({ color });
    if (chrome.action.setBadgeTextColor) await chrome.action.setBadgeTextColor({ color: "#FFFFFF" });
    await chrome.action.setTitle({ title });
  } catch (_) {}
}
