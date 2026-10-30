// ScoreX - turn a content-script page report into an engine decision.
// Any sign of trouble on the account (captcha, warning, rate limit, lock, logout, wrong account)
// becomes a STOP. "Something went wrong" pages are soft errors that become a stop when repeated.

import { PAGE, PAGE_TO_STOP, STOP } from "./constants.js";

// page: { state, detail, me, hidden } as returned with every content response.
// Returns null only for a readable page of the right account. With account verification on (the default) a page
// whose logged-in handle cannot be read is never "OK": it gets the soft verdict "account_unknown" (the poster does
// not type or submit on it, and the engine stops after 3 such page loads in a row, see tabs.js), and a page state
// the content script could not determine is soft as well.
export function pageVerdict(page, settings) {
  if (!page) return { soft: "no_page_report" };
  const st = page.state;
  if (PAGE_TO_STOP[st]) return { stop: PAGE_TO_STOP[st], detail: page.detail || st };
  const acct = (settings && settings.account) || {};
  const want = String(acct.handle || "").trim().replace(/^@+/, "").toLowerCase();
  const me = page.me ? String(page.me).trim().replace(/^@+/, "").toLowerCase() : "";
  if (acct.verifyAccount && want && me && me !== want) {
    return { stop: STOP.WRONG_ACCOUNT, detail: `Logged in as @${me}, expected @${want}` };
  }
  if (st === PAGE.ERROR_PAGE) return { soft: "error_page", detail: page.detail };
  if (st === PAGE.NOT_FOUND) return { notFound: true, detail: page.detail };
  if (st === PAGE.LOADING) return { soft: "loading", detail: page.detail };
  if (st !== PAGE.OK) return { soft: "unknown_page", detail: page.detail || `Unknown page state: ${String(st || "none").slice(0, 40)}` };
  if (acct.verifyAccount && want && !me) return { soft: "account_unknown", detail: "Could not read which X account is logged in on this page" };
  return null;
}

// True when the page shows the configured account (or account verification is off / no handle is set).
export function accountVerified(page, settings) {
  const acct = (settings && settings.account) || {};
  const want = String(acct.handle || "").trim().replace(/^@+/, "").toLowerCase();
  if (!acct.verifyAccount || !want) return true;
  const me = page && page.me ? String(page.me).trim().replace(/^@+/, "").toLowerCase() : "";
  return me === want;
}

// Map a content action error code to a stop reason when it signals a broken page structure.
export function domStop(resp) {
  if (resp && resp.dom) return { stop: STOP.DOM_CHANGED, detail: `Element not found: ${resp.error}` };
  return null;
}
