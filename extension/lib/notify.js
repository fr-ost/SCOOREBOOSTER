// ScoreX - Chrome desktop notifications and the toolbar badge. No remote channels.
//   red "!"   engine stopped by a safety trigger (until you resume or dismiss), or an open reach alert
//             (your replies are reaching far fewer people; until you dismiss it)
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

// While running the badge counts the replies posted in the last 24 h (posted24h); comments waiting for review are named
// in the tooltip. A safety stop or a reach alert shows a red "!" instead.
export async function setBadge(state, pendingReview = 0, posted24h = 0) {
  let text = "", color = COLORS.running, title = "ScoreX";
  const review = pendingReview > 0 ? ` · ${pendingReview} comment(s) to review` : "";
  if (state.alert) { text = "!"; color = COLORS.alert; title = "ScoreX stopped: " + (state.alert.label || state.alert.reason); }
  else if (state.reachAlert) { text = "!"; color = COLORS.alert; title = "ScoreX: " + String(state.reachAlert.message || "your replies are reaching far fewer people").slice(0, 120); }
  else if (state.status === STATUS.RUNNING) { text = posted24h > 999 ? "999+" : String(posted24h); color = COLORS.running; title = `ScoreX is running: ${posted24h} repl${posted24h === 1 ? "y" : "ies"} posted in the last 24 h${review}`; }
  else if (pendingReview > 0) { text = pendingReview > 99 ? "99+" : String(pendingReview); color = COLORS.review; title = `ScoreX: ${pendingReview} comment(s) to review`; }
  else if (state.status === STATUS.PAUSED) { text = "II"; color = COLORS.paused; title = "ScoreX is paused" + review; }
  try {
    await chrome.action.setBadgeText({ text });
    await chrome.action.setBadgeBackgroundColor({ color });
    if (chrome.action.setBadgeTextColor) await chrome.action.setBadgeTextColor({ color: "#FFFFFF" });
    await chrome.action.setTitle({ title });
  } catch (_) {}
}
