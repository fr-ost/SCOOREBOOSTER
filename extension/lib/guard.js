// ScoreX - turn a content-script page report into an engine decision.
// Any sign of trouble on the account (captcha, warning, rate limit, lock, logout, wrong account)
// becomes a STOP. "Something went wrong" pages are soft errors that become a stop when repeated.

import { PAGE, PAGE_TO_STOP, STOP } from "./constants.js";

// page: { state, detail, me, hidden } as returned with every content response.
export function pageVerdict(page, settings) {
  if (!page) return { soft: "no_page_report" };
  const st = page.state;
  if (PAGE_TO_STOP[st]) return { stop: PAGE_TO_STOP[st], detail: page.detail || st };
  const want = String((settings.account && settings.account.handle) || "").toLowerCase();
  if (settings.account && settings.account.verifyAccount && want && page.me && page.me !== want) {
    return { stop: STOP.WRONG_ACCOUNT, detail: `Logged in as @${page.me}, expected @${want}` };
  }
  if (st === PAGE.ERROR_PAGE) return { soft: "error_page", detail: page.detail };
  if (st === PAGE.NOT_FOUND) return { notFound: true, detail: page.detail };
  if (st === PAGE.LOADING) return { soft: "loading", detail: page.detail };
  return null;
}

// Map a content action error code to a stop reason when it signals a broken page structure.
export function domStop(resp) {
  if (resp && resp.dom) return { stop: STOP.DOM_CHANGED, detail: `Element not found: ${resp.error}` };
  return null;
}
