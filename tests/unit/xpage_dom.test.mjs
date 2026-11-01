// The real content scripts (extension/content/*.js) in headless Chromium against X-like markup: follow badges
// (XP-1 / FOL-5, XP-2), page-state text heuristics (XP-7), the logged-in handle in other layouts (XP-6 / ENG-2),
// the account check before clicks, and the fail-closed handling of unknown X prompts while posting.
// Needs Playwright with Chromium (as the e2e tests do); skipped when it is not installed.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const CONTENT = path.resolve(HERE, "../../extension/content");
const FILES = ["selectors.js", "dom.js", "detect.js", "scrape.js", "actions.js", "content.js"];
const SOURCES = FILES.map((f) => fs.readFileSync(path.join(CONTENT, f), "utf8"));

let chromium = null;
try { chromium = createRequire(path.resolve(HERE, "../e2e/harness.mjs"))(process.env.PLAYWRIGHT || "playwright").chromium; } catch (_) { chromium = null; }

const FAKE_CHROME = `
window.chrome = window.chrome || {};
window.chrome.storage = { local: { get: () => Promise.resolve({}) }, onChanged: { addListener() {} } };
window.chrome.runtime = { id: "sx", onMessage: { addListener(fn) { window.__sxHandler = fn; } }, sendMessage: () => Promise.resolve() };
window.__sxCall = (msg) => new Promise((res) => { const r = window.__sxHandler(msg, { id: "sx" }, res); if (r === false) res({ notHandled: true }); });
window.__clicks = [];
document.addEventListener("click", (e) => { const el = e.target.closest("[data-testid]") || e.target; window.__clicks.push(el.getAttribute("data-testid") || el.tagName); }, true);
`;

const NAV = `<nav><a data-testid="AppTabBar_Profile_Link" href="/0x_nation">Profile</a><a data-testid="AppTabBar_Home_Link" href="/home">Home</a></nav>`;
// (a div, not X's button: nested buttons cannot be built with innerHTML)
const cell = (h, { badge = false, badgeText = false, bio = "", name } = {}) => `<div data-testid="UserCell" role="button" style="display:block">
  <div><a href="/${h}" role="link"><div dir="ltr"><span>${name || h.toUpperCase()}</span></div></a></div>
  <div style="display:flex"><a href="/${h}" role="link"><div dir="ltr"><span>@${h}</span></div></a>${badge ? `<div data-testid="userFollowIndicator"><span>Follows you</span></div>` : ""}${badgeText ? `<div><span>Follows you</span></div>` : ""}</div>
  <div><button data-testid="${1000 + h.length}-follow"><span>Follow</span></button></div>
  <div dir="auto">${bio}</div>
</div>`;
const TID = "1900000000000000001";
const tweet = (author, id, text, { focal = false } = {}) => `<article data-testid="tweet" role="article" tabindex="${focal ? -1 : 0}">
<div data-testid="User-Name"><a href="/${author}" role="link"><span>${author}</span></a><div><a href="/${author}" role="link"><span>@${author}</span></a><a href="/${author}/status/${id}" role="link"><time datetime="${new Date(Date.now() - 5 * 60000).toISOString()}">5m</time></a></div></div>
<div data-testid="tweetText" lang="en"><span>${text}</span></div>
<div role="group" aria-label="1 reply, 2 reposts, 30 likes, 400 views"><button data-testid="reply">1</button><button data-testid="retweet">2</button><button data-testid="like">30</button></div></article>`;
const INLINE = `<div id="composer"><div data-testid="tweetTextarea_0" role="textbox" contenteditable="true" style="min-height:40px"></div><button data-testid="tweetButtonInline">Reply</button></div>`;
const statusPage = (extra = "", { composer = INLINE, nav = NAV } = {}) => `${nav}<main role="main"><div data-testid="primaryColumn">${tweet("bigbob", TID, "Most teams ship features. The best teams ship distribution.", { focal: true })}${composer}</div></main><div id="layers">${extra}</div>`;

describe("content scripts on X-like pages", { skip: chromium ? false : "Playwright/Chromium not installed" }, () => {
  let browser;
  before(async () => { browser = await chromium.launch({ headless: true }); });
  after(async () => { if (browser) await browser.close(); });

  async function open(url, html, { width = 1280 } = {}) {
    const ctx = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await ctx.newPage();
    await page.route("https://x.com/**", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><html><head><meta charset=utf-8></head><body></body></html>" }));
    await page.goto(url);
    await page.evaluate((h) => { document.body.innerHTML = h; }, html);
    await page.addScriptTag({ content: FAKE_CHROME });
    for (const src of SOURCES) await page.addScriptTag({ content: src });
    const call = (msg) => page.evaluate((m) => window.__sxCall(m), msg);
    const clicks = () => page.evaluate(() => window.__clicks.slice());
    return { page, call, clicks, close: () => ctx.close() };
  }

  // ---------- follow badges ----------

  test("XP-1: a 'Who to follow' cell with the badge does not make the profile 'follows you'", async () => {
    const p = await open("https://x.com/bigtarget", `${NAV}<main role="main"><div data-testid="primaryColumn">
<div data-testid="UserName"><div><span>Big Target</span></div><div><div dir="ltr"><span>@bigtarget</span></div></div></div>
<div data-testid="UserDescription"><span>Founder.</span></div><button data-testid="777-follow"><span>Follow</span></button>
<section>${tweet("bigtarget", "1900000000000000101", "Distribution compounds.")}<div><h2 role="heading">Who to follow</h2>${cell("somefan", { badge: true, bio: "Builder" })}</div></section>
</div></main>`);
    try {
      const r = await p.call({ sx: "scrapeProfile" });
      assert.equal(r.profile.handle, "bigtarget");
      assert.equal(r.profile.followsYou, false);
      assert.equal((await p.call({ sx: "followState" })).followsYou, false, "cleanup's re-check uses the same reading");
    } finally { await p.close(); }
  });

  test("XP-1: the header badge (testid, or the exact text right after @handle) still counts", async () => {
    let p = await open("https://x.com/gina", `${NAV}<main role="main"><div data-testid="primaryColumn">
<div data-testid="UserName"><div><span>Gina</span></div><div><span>@gina</span><span data-testid="userFollowIndicator">Follows you</span></div></div>
<div><h2>Who to follow</h2>${cell("other", {})}</div></div></main>`);
    try { assert.equal((await p.call({ sx: "scrapeProfile" })).profile.followsYou, true); } finally { await p.close(); }
    p = await open("https://x.com/gina", `${NAV}<main role="main"><div data-testid="primaryColumn">
<div data-testid="UserName"><div><span>Gina</span></div><div style="display:flex"><div><span>@gina</span></div><div><span>Follows you</span></div></div></div></div></main>`);
    try { assert.equal((await p.call({ sx: "scrapeProfile" })).profile.followsYou, true, "text fallback if X renames the testid"); } finally { await p.close(); }
  });

  test("XP-1: a display name that contains 'follows you' is not the badge", async () => {
    const p = await open("https://x.com/bigtarget", `${NAV}<main role="main"><div data-testid="primaryColumn">
<div data-testid="UserName"><div><span>I follow back if he follows you</span></div><div><div dir="ltr"><span>@bigtarget</span></div></div></div></div></main>`);
    try { assert.equal((await p.call({ sx: "scrapeProfile" })).profile.followsYou, false); } finally { await p.close(); }
  });

  test("XP-2: bio text never counts as the badge on the followers list", async () => {
    const p = await open("https://x.com/0x_nation/followers", `${NAV}<main role="main"><div data-testid="primaryColumn">
${cell("alpha", { bio: "PM at a fintech." })}${cell("beta", { bio: "Crypto degen. This account follows you back, always." })}${cell("gamma", { bio: "Follows you" })}${cell("delta", { bio: "Writer" })}
</div></main>`);
    try {
      const r = await p.call({ sx: "scrapeUsers", limit: 400 });
      assert.deepEqual(r.users.map((u) => u.followsYou), [false, false, false, false]);
      assert.equal(r.badgeCells, 0);
      assert.match(r.users[1].bio, /follows you back/, "the bio itself is kept");
    } finally { await p.close(); }
  });

  test("XP-2: badge elements count (and are flagged); a renamed badge with its exact text still counts", async () => {
    const p = await open("https://x.com/0x_nation/followers", `${NAV}<main role="main"><div data-testid="primaryColumn">
${cell("fan1", { badge: true, bio: "a" })}${cell("fan2", { badge: true })}${cell("fan3", { badgeText: true, bio: "b" })}${cell("nofan", { bio: "c" })}
</div></main>`);
    try {
      const r = await p.call({ sx: "scrapeUsers", limit: 400 });
      const by = Object.fromEntries(r.users.map((u) => [u.handle, u]));
      assert.equal(by.fan1.followsYou && by.fan1.badge, true);
      assert.equal(by.fan3.followsYou, true);
      assert.equal(by.fan3.badge, false);
      assert.equal(by.nofan.followsYou, false);
      assert.equal(r.badgeCells, 2);
    } finally { await p.close(); }
  });

  test("followers page: the sidebar's 'Who to follow' cells never satisfy the wait or the self-test; the list does once it renders", async () => {
    const SIDEBAR = `<div data-testid="sidebarColumn"><aside><h2>Who to follow</h2>${cell("sugg1")}${cell("sugg2")}${cell("sugg3")}</aside></div>`;
    const p = await open("https://x.com/0x_nation/followers", `${NAV}<main role="main"><div data-testid="primaryColumn"><div id="list"></div></div></main>${SIDEBAR}`);
    try {
      // Only the 3 suggestions are on the page: the wait does not match them, and the self-test sees no follower rows.
      assert.equal((await p.call({ sx: "waitFor", keys: ["userCell"], timeoutMs: 1500 })).ok, false);
      let t = await p.call({ sx: "selfTest", keys: ["userCell", "followsYouBadge"] });
      assert.equal(t.cells, 0, "sidebar cells are not follower rows");
      // The followers list renders (one badge element, one renamed badge with the exact text).
      const waiting = p.call({ sx: "waitFor", keys: ["userCell", "emptyState"], timeoutMs: 5000 });
      await p.page.evaluate((html) => { setTimeout(() => { document.getElementById("list").innerHTML = html; }, 600); },
        cell("fan1", { badge: true }) + cell("fan2", { badgeText: true }) + cell("fan3", { badge: true }));
      const w = await waiting;
      assert.equal(w.ok && w.key, "userCell");
      t = await p.call({ sx: "selfTest", keys: ["userCell", "followsYouBadge"] });
      assert.equal(t.cells, 3);
      assert.equal(t.badgeCells, 3, "badge element or its exact text");
      assert.equal(t.badgeElements, 2);
      const u = await p.call({ sx: "scrapeUsers", limit: 400 });
      assert.deepEqual(u.users.map((x) => x.handle), ["fan1", "fan2", "fan3"], "the follow scan reads the main column only");
    } finally { await p.close(); }
  });

  // ---------- page state ----------

  test("XP-7: a follower's bio saying 'this page doesn't exist' does not make the page 'not found'", async () => {
    const p = await open("https://x.com/0x_nation/followers", `${NAV}<main role="main"><div data-testid="primaryColumn"><h2>0x_nation</h2>
${cell("newfan", { badge: true, bio: "404 vibes only. This page doesn’t exist, neither do I." })}${cell("fan2", { badge: true })}${cell("fan3", { badge: true })}
</div></main>`);
    try {
      const r = await p.call({ sx: "waitFor", keys: ["userCell", "emptyState"], timeoutMs: 3000 });
      assert.equal(r.ok, true);
      assert.equal(r.key, "userCell");
    } finally { await p.close(); }
  });

  test("XP-7: profile bio / name / location phrases are ignored, X's own notice still means not found", async () => {
    let p = await open("https://x.com/bigtarget", `${NAV}<main role="main"><div data-testid="primaryColumn">
<div data-testid="UserName"><div><span>Post unavailable guy</span></div><div><span>@bigtarget</span></div></div>
<div data-testid="UserDescription"><span>My best post unavailable anywhere else.</span></div>
<div data-testid="UserProfileHeader_Items"><span data-testid="UserLocation">This page doesn't exist</span></div></div></main>`);
    try { assert.equal((await p.call({ sx: "pageState" })).page.state, "ok"); } finally { await p.close(); }
    p = await open(`https://x.com/bigbob/status/${TID}`, `${NAV}<main role="main"><div data-testid="primaryColumn"><div><span>This post is unavailable.</span></div></div></main>`);
    try { assert.equal((await p.call({ sx: "pageState" })).page.state, "not_found"); } finally { await p.close(); }
  });

  // ---------- who is logged in ----------

  test("XP-6: the logged-in handle in the narrow (mobile) layout and the collapsed nav", async () => {
    const body = (nav) => `${nav}<main role="main"><div data-testid="primaryColumn">${tweet("someone", TID, "hello world post")}<div data-testid="UserAvatar-Container-someone"></div></div></main>`;
    const cases = [
      [`<header><a data-testid="DashButton_ProfileIcon_Link" href="#" aria-label="Profile"><div data-testid="UserAvatar-Container-other_acct"><img src="x.jpg"></div></a></header><nav><a data-testid="AppTabBar_Home_Link" href="/home">Home</a></nav>`, "other_acct", 480],
      [`<header><a data-testid="DashButton_ProfileIcon_Link" href="/0x_nation" aria-label="Profile"><img src="x.jpg"></a></header>`, "0x_nation", 480],
      [`<nav><div data-testid="SideNav_AccountSwitcher_Button"><div data-testid="UserAvatar-Container-0x_nation"><img src="x.jpg"></div></div><a data-testid="AppTabBar_Home_Link" href="/home">Home</a></nav>`, "0x_nation", 1000],
      [`<nav><div data-testid="SideNav_AccountSwitcher_Button"><img src="x.jpg"><div><span>Me</span></div><div><span>@Mixed_Case</span></div></div></nav>`, "mixed_case", 1280],
    ];
    for (const [nav, want, width] of cases) {
      const p = await open(`https://x.com/someone/status/${TID}`, body(nav), { width });
      try {
        const r = await p.call({ sx: "pageState" });
        assert.equal(r.page.me, want, nav.slice(0, 60));
        assert.equal(r.page.state, "ok");
      } finally { await p.close(); }
    }
  });

  test("XP-6: never the viewed profile, a post author or the URL; X's session data as a last resort", async () => {
    let p = await open("https://x.com/someone", `<nav><a data-testid="AppTabBar_Home_Link" href="/home">Home</a></nav><main role="main"><div data-testid="primaryColumn">
<div data-testid="UserName"><div><span>Someone</span></div><div><span>@someone</span></div></div><div data-testid="UserAvatar-Container-someone"></div>${tweet("someone", TID, "x")}</div></main>`);
    try { assert.equal((await p.call({ sx: "pageState" })).page.me, null); } finally { await p.close(); }
    const state = { entities: { users: { entities: { 42: { id_str: "42", screen_name: "someone", entities: { url: { urls: [] } } }, 7: { id_str: "7", screen_name: "Real_Me" } } } }, session: { user_id: "7", country: "BD" } };
    p = await open("https://x.com/someone", `<script>window.__INITIAL_STATE__=${JSON.stringify(state).replace(/</g, "\\u003c")};window.__META_DATA__={"x":"}{"};</script>
<nav><a data-testid="AppTabBar_Home_Link" href="/home">Home</a></nav><main role="main"><div data-testid="primaryColumn"><div data-testid="UserName"><div><span>@someone</span></div></div></div></main>`);
    try { assert.equal((await p.call({ sx: "pageState" })).page.me, "real_me"); } finally { await p.close(); }
  });

  test("account check right before clicking: mismatch / unknown refuse, the right account proceeds", async () => {
    let p = await open(`https://x.com/bigbob/status/${TID}`, statusPage("", { nav: `<nav><a data-testid="AppTabBar_Profile_Link" href="/other">P</a></nav>` }));
    try {
      const r = await p.call({ sx: "openComposer", tweetId: TID, expectMe: "0x_nation" });
      assert.equal(r.error, "wrong_account");
      assert.equal(r.me, "other");
      assert.deepEqual(await p.clicks(), []);
    } finally { await p.close(); }
    p = await open(`https://x.com/bigbob/status/${TID}`, statusPage("", { nav: `<nav><a data-testid="AppTabBar_Home_Link" href="/home">H</a></nav>` }));
    try {
      assert.equal((await p.call({ sx: "submitReply", expectText: "", expectMe: "0x_nation" })).error, "account_unknown");
      assert.deepEqual(await p.clicks(), []);
    } finally { await p.close(); }
    p = await open(`https://x.com/bigbob/status/${TID}`, statusPage());
    try {
      const r = await p.call({ sx: "openComposer", tweetId: TID, expectMe: "0x_Nation" });
      assert.equal(r.ok, true, JSON.stringify(r));
    } finally { await p.close(); }
  });

  // ---------- unknown prompts (fail closed) ----------

  const PROMPT = `<div role="dialog" aria-modal="true" style="position:fixed;top:0;left:0;width:300px;height:200px;background:#fff"><div><span>Before you reply</span><span>Review how replies work on X before you continue.</span><button data-testid="promptContinue">Continue</button></div></div>`;

  test("a dialog that is not the composer: openComposer refuses and clicks nothing", async () => {
    const p = await open(`https://x.com/bigbob/status/${TID}`, statusPage(PROMPT));
    try {
      const r = await p.call({ sx: "openComposer", tweetId: TID });
      assert.equal(r.state, "unknown_prompt");
      assert.match(r.detail, /Before you reply/);
      assert.ok(r.detail.length <= 200);
      assert.deepEqual(await p.clicks(), []);
    } finally { await p.close(); }
  });

  test("an interstitial instead of the reply box after the Reply click is reported, never clicked", async () => {
    const p = await open(`https://x.com/bigbob/status/${TID}`, statusPage("", { composer: "" }));
    try {
      await p.page.evaluate((html) => {
        document.querySelector('[data-testid="reply"]').addEventListener("click", () => { document.getElementById("layers").innerHTML = html; });
      }, PROMPT);
      const r = await p.call({ sx: "openComposer", tweetId: TID });
      assert.equal(r.state, "unknown_prompt");
      assert.deepEqual(await p.clicks(), ["reply"], "only the reply icon was clicked, not the prompt");
    } finally { await p.close(); }
  });

  test("AI-label wording around the composer stops; the same words in your reply or the quoted post do not", async () => {
    const modal = (notice) => `<div role="dialog" aria-modal="true" style="position:fixed;top:0;left:0;width:500px;height:400px;background:#fff">
${tweet("bigbob", TID, "This image was made with AI, thoughts?")}
<div data-testid="tweetTextarea_0" role="textbox" contenteditable="true" style="min-height:40px">Love the AI-generated look, which model?</div>
${notice}<button data-testid="tweetButton">Reply</button></div>`;
    let p = await open(`https://x.com/bigbob/status/${TID}`, statusPage(modal(""), { composer: "" }));
    try {
      const r = await p.call({ sx: "submitReply", expectText: "Love the AI-generated look, which model?" });
      assert.equal(r.ok, true, JSON.stringify(r));
      const cl = await p.clicks();
      assert.ok(cl.length >= 1 && cl.every((x) => x === "tweetButton"), "only Reply clicked (this fake page never reacts, so it is clicked again): " + cl);
    } finally { await p.close(); }
    p = await open(`https://x.com/bigbob/status/${TID}`, statusPage(modal(`<div><span>Add an AI label so people know this reply was generated with AI.</span><button data-testid="aiLabelToggle">Add label</button></div>`), { composer: "" }));
    try {
      const r = await p.call({ sx: "submitReply", expectText: "Love the AI-generated look, which model?" });
      assert.equal(r.state, "unknown_prompt");
      assert.match(r.detail, /Add an AI label/);
      assert.ok(!/which model/.test(r.detail), "the typed reply is not part of the sample");
      assert.deepEqual(await p.clicks(), [], "Reply was not clicked");
    } finally { await p.close(); }
  });

  test("replyResult: a prompt after the click; a 'may be hidden' sheet right after the sent toast", async () => {
    let p = await open(`https://x.com/bigbob/status/${TID}`, statusPage());
    try {
      await p.page.evaluate((html) => {
        document.querySelector('[data-testid="tweetTextarea_0"]').textContent = "My reply text";
        setTimeout(() => { document.getElementById("layers").innerHTML = html; }, 300);
      }, PROMPT);
      const r = await p.call({ sx: "replyResult", tweetId: TID, expectText: "My reply text", me: "0x_nation", timeoutMs: 5000 });
      assert.equal(r.state, "unknown_prompt");
      assert.equal(r.cleared, false, "text still in the box: not sent");
      assert.equal(r.sent, false);
    } finally { await p.close(); }
    p = await open(`https://x.com/bigbob/status/${TID}`, statusPage());
    try {
      await p.page.evaluate(() => {
        document.body.insertAdjacentHTML("beforeend", `<div data-testid="toast" role="alert"><span>Your post was sent.</span> <a href="/0x_nation/status/1900000000000000999">View</a></div>`);
        setTimeout(() => { document.getElementById("layers").innerHTML = `<div data-testid="sheetDialog" role="dialog"><span>Your reply may be hidden from some people.</span><button>Got it</button></div>`; }, 400);
      });
      const r = await p.call({ sx: "replyResult", tweetId: TID, expectText: "x", me: "0x_nation", timeoutMs: 5000 });
      assert.equal(r.state, "unknown_prompt");
      assert.equal(r.sent, true);
      assert.match(r.replyUrl, /1900000000000000999/);
      assert.deepEqual(await p.clicks(), []);
    } finally { await p.close(); }
  });

  test("toasts: success is success, an AI-label toast stops; hover cards and hidden dialogs are ignored", async () => {
    let p = await open(`https://x.com/bigbob/status/${TID}`, statusPage(`<div data-testid="HoverCard"><div role="dialog"><span>Big Bob</span><span>@bigbob</span></div></div><div role="dialog" style="display:none"><span>Hidden</span></div>`));
    try {
      await p.page.evaluate(() => document.body.insertAdjacentHTML("beforeend", `<div data-testid="toast" role="alert"><span>Your post was sent.</span></div>`));
      const r = await p.call({ sx: "replyResult", tweetId: TID, expectText: "x", me: "0x_nation", timeoutMs: 3000 });
      assert.equal(r.ok, true, JSON.stringify(r));
    } finally { await p.close(); }
    p = await open(`https://x.com/bigbob/status/${TID}`, statusPage());
    try {
      await p.page.evaluate(() => document.body.insertAdjacentHTML("beforeend", `<div data-testid="toast" role="alert"><span>Your post was sent. It may be hidden as probable spam.</span></div>`));
      const r = await p.call({ sx: "replyResult", tweetId: TID, expectText: "x", me: "0x_nation", timeoutMs: 3000 });
      assert.equal(r.state, "unknown_prompt");
    } finally { await p.close(); }
    p = await open(`https://x.com/bigbob/status/${TID}`, statusPage(`<div role="dialog"><span>Made with</span><span>AI</span><button>Label</button></div>`));
    try {
      const r = await p.call({ sx: "openComposer", tweetId: TID });
      assert.equal(r.state, "unknown_prompt");
      assert.equal(r.why, "ai_label", "words split over inline elements still match text.aiLabel");
      assert.match(r.detail, /Made with AI/);
    } finally { await p.close(); }
  });

  test("unfollow: refuses on another account or an unknown prompt, clicks nothing", async () => {
    const profile = (nav, layers = "") => `${nav}<main role="main"><div data-testid="primaryColumn">
<div data-testid="UserName"><div><span>Dave</span></div><div><span>@dave</span></div></div><button data-testid="55-unfollow">Following</button></div></main><div id="layers">${layers}</div>`;
    let p = await open("https://x.com/dave", profile(`<nav><a data-testid="AppTabBar_Profile_Link" href="/other">P</a></nav>`));
    try {
      assert.equal((await p.call({ sx: "unfollow", handle: "dave", expectMe: "0x_nation" })).error, "wrong_account");
      assert.deepEqual(await p.clicks(), []);
    } finally { await p.close(); }
    p = await open("https://x.com/dave", profile(NAV, PROMPT));
    try {
      assert.equal((await p.call({ sx: "unfollow", handle: "dave" })).state, "unknown_prompt");
      assert.deepEqual(await p.clicks(), []);
    } finally { await p.close(); }
  });

  test("a dialog with some other text field (a report form) is a prompt, never the composer", async () => {
    const form = `<div role="dialog" aria-modal="true" style="position:fixed;top:0;left:0;width:400px;height:300px;background:#fff"><span>Tell us more</span><div role="textbox" contenteditable="true" style="min-height:30px"></div><button>Send</button></div>`;
    const p = await open(`https://x.com/bigbob/status/${TID}`, statusPage(form));
    try {
      const r = await p.call({ sx: "type", text: "Hello" });
      assert.equal(r.state, "unknown_prompt");
      assert.equal(await p.page.evaluate(() => document.querySelector('[role="dialog"] [contenteditable]').textContent), "");
      assert.equal((await p.call({ sx: "composerText" })).where, "inline", "the composer is still the page's reply box");
    } finally { await p.close(); }
  });

  // X's editor (Draft.js) takes a paste into its own state and renders that; a plain contenteditable ignores a
  // synthetic paste. This fake does what Draft.js does with a paste over a full selection: the box shows the text.
  const DRAFT_LIKE = `(() => { const b = document.querySelector('[data-testid="tweetTextarea_0"]'); window.__pastes = 0;
    b.addEventListener("paste", (e) => { e.preventDefault(); window.__pastes++; b.textContent = e.clipboardData.getData("text/plain"); }); })();`;
  const REPLY = "ngl the timing on this is what makes it work, the rest is noise";

  test("opening the reply box clicks into it and focuses it (X's editor becomes active, UniqueFarm)", async () => {
    const p = await open(`https://x.com/bigbob/status/${TID}`, statusPage());
    try {
      const r = await p.call({ sx: "openComposer", tweetId: TID, expectMe: "0x_nation" });
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(r.where, "inline");
      assert.ok((await p.clicks()).includes("tweetTextarea_0"), "clicked into the reply box");
      assert.equal(await p.page.evaluate(() => document.activeElement && document.activeElement.getAttribute("data-testid")), "tweetTextarea_0");
    } finally { await p.close(); }
  });

  test("Reply click: once X reacts (the box empties) it is never clicked again; an ignored click gets the shortcut and one more click", async () => {
    let p = await open(`https://x.com/bigbob/status/${TID}`, statusPage());
    try {
      await p.page.addScriptTag({ content: DRAFT_LIKE });
      await p.page.addScriptTag({ content: `document.querySelector('[data-testid="tweetButtonInline"]').addEventListener("click", () => { setTimeout(() => { document.querySelector('[data-testid="tweetTextarea_0"]').textContent = ""; }, 300); });` });
      await p.call({ sx: "type", text: REPLY, whole: true });
      const r = await p.call({ sx: "submitReply", expectText: REPLY, expectMe: "0x_nation" });
      assert.equal(r.ok, true);
      assert.equal(r.started, true);
      assert.equal(r.tries, 1);
      assert.deepEqual((await p.clicks()).filter((x) => x === "tweetButtonInline"), ["tweetButtonInline"]);
    } finally { await p.close(); }
    p = await open(`https://x.com/bigbob/status/${TID}`, statusPage());
    try {
      await p.page.addScriptTag({ content: DRAFT_LIKE });
      await p.page.addScriptTag({ content: `window.__keys = 0; document.querySelector('[data-testid="tweetTextarea_0"]').addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) window.__keys++; });` });
      await p.call({ sx: "type", text: REPLY, whole: true });
      const r = await p.call({ sx: "submitReply", expectText: REPLY, expectMe: "0x_nation" });
      assert.equal(r.started, false, "nothing reacted");
      assert.equal(r.tries, 3);
      assert.equal(await p.page.evaluate(() => window.__keys), 1, "X's Ctrl/Cmd+Enter shortcut was tried once");
      assert.equal((await p.clicks()).filter((x) => x === "tweetButtonInline").length, 2);
    } finally { await p.close(); }
  });

  // ---------- follow first (on the profile page) ----------
  // A profile like X's: the header's own button (X wraps it in placementTracking), a post with its own Follow button
  // placed before the header, and a "Who to follow" cell. header: whose name block is rendered.
  const profilePage = (h, { button = "follow", header = h, extra = "" } = {}) => {
    const b = { follow: ["Follow", "777-follow"], following: ["Following", "777-unfollow"], pending: ["Pending", "777-cancel"] }[button];
    const btn = b ? `<div data-testid="placementTracking"><button aria-label="${b[0]} @${h}" data-testid="${b[1]}" id="headerFollow"><span>${b[0]}</span></button></div>` : "";
    return `${NAV}<main role="main"><div data-testid="primaryColumn">
<article data-testid="tweet" role="article"><button aria-label="Follow @${h}" data-testid="555-follow">Follow</button></article>
<div data-testid="UserName"><div><span>${header.toUpperCase()}</span></div><div><div dir="ltr"><span>@${header}</span></div></div></div>
${btn}<section><div><h2 role="heading">Who to follow</h2>${cell("somefan", {})}</div></section>${extra}</div></main><div id="layers"></div>`;
  };
  // X's button: "Following" the moment it is clicked; then (after) it keeps it, or turns back with a message.
  const xButton = ({ after = null, toast = "" } = {}) => `(() => {
    const b = document.getElementById("headerFollow"), h = b.getAttribute("aria-label").split("@")[1];
    const set = (l, id) => { b.setAttribute("aria-label", l + " @" + h); b.setAttribute("data-testid", id); b.querySelector("span").textContent = l; };
    b.addEventListener("click", () => {
      set("Following", "777-unfollow");
      ${after ? `setTimeout(() => { ${toast ? `const t = document.createElement("div"); t.setAttribute("data-testid", "toast"); t.setAttribute("role", "alert"); t.textContent = ${JSON.stringify(toast)}; document.getElementById("layers").appendChild(t);` : ""} ${after === "revert" ? `set("Follow", "777-follow");` : ""} }, 500);` : ""}
    });
  })();`;
  const followClicks = async (p) => (await p.clicks()).filter((x) => /follow|cancel/.test(x));

  test("follow: the profile header's own button only (never a post's or a suggestion's); counts once it still reads Following", async () => {
    const p = await open("https://x.com/alice", profilePage("alice"));
    try {
      await p.page.addScriptTag({ content: xButton() });
      const r = await p.call({ sx: "follow", handle: "alice", expectMe: "0x_nation", settleMs: 1200 });
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(r.clicked, true);
      assert.ok(!r.already);
      assert.deepEqual(await followClicks(p), ["777-follow"], "only the header's button");
    } finally { await p.close(); }
  });

  test("follow: X turns the button back to Follow (with a message) -> not followed, the message is kept", async () => {
    const p = await open("https://x.com/alice", profilePage("alice"));
    try {
      await p.page.addScriptTag({ content: xButton({ after: "revert", toast: "Something went wrong. Try reloading." }) });
      const r = await p.call({ sx: "follow", handle: "alice", expectMe: "0x_nation", settleMs: 3000 });
      assert.equal(r.ok, false, JSON.stringify(r));
      assert.equal(r.error, "follow_reverted");
      assert.equal(r.clicked, true);
      assert.match(r.detail, /Something went wrong/);
    } finally { await p.close(); }
  });

  test("follow: X's follow-limit message after the click is X refusing (rate_limit), even while the button reads Following", async () => {
    const p = await open("https://x.com/alice", profilePage("alice"));
    try {
      await p.page.addScriptTag({ content: xButton({ after: "keep", toast: "You are unable to follow more people at this time." }) });
      const r = await p.call({ sx: "follow", handle: "alice", expectMe: "0x_nation", settleMs: 3000 });
      assert.equal(r.ok, false, JSON.stringify(r));
      assert.equal(r.state, "rate_limit");
      assert.equal(r.clicked, true);
    } finally { await p.close(); }
  });

  test("follow: already following / a pending request -> nothing clicked; another page, another header or no button -> nothing clicked", async () => {
    for (const [button, want] of [["following", { ok: true, already: true }], ["pending", { ok: true, pending: true, already: true }]]) {
      const p = await open("https://x.com/alice", profilePage("alice", { button }));
      try {
        const r = await p.call({ sx: "follow", handle: "alice", expectMe: "0x_nation" });
        assert.deepEqual({ ok: r.ok, already: r.already, pending: r.pending }, { pending: undefined, ...want }, button);
        assert.deepEqual(await followClicks(p), [], button + ": nothing clicked");
      } finally { await p.close(); }
    }
    let p = await open(`https://x.com/alice/status/${TID}`, profilePage("alice"));
    try {
      assert.equal((await p.call({ sx: "follow", handle: "alice", expectMe: "0x_nation" })).error, "wrong_page");
      assert.deepEqual(await followClicks(p), []);
    } finally { await p.close(); }
    p = await open("https://x.com/alice", profilePage("alice", { header: "someoneelse" }));
    try {
      assert.equal((await p.call({ sx: "follow", handle: "alice", expectMe: "0x_nation", readyMs: 800 })).error, "profile_not_rendered");
      assert.deepEqual(await followClicks(p), [], "another account's header: nothing clicked");
    } finally { await p.close(); }
    p = await open("https://x.com/alice", profilePage("alice", { button: "none" }));
    try {
      assert.equal((await p.call({ sx: "follow", handle: "alice", expectMe: "0x_nation", readyMs: 800 })).error, "follow_button_missing");
      assert.deepEqual(await followClicks(p), [], "a post's Follow button is never used");
    } finally { await p.close(); }
  });

  test("followState after a reload waits for the header's button; the profile read uses that button, not a post's", async () => {
    const p = await open("https://x.com/alice", profilePage("alice", { button: "none" }));
    try {
      await p.page.addScriptTag({ content: `setTimeout(() => { document.querySelector('[data-testid="UserName"]').insertAdjacentHTML("afterend", '<div data-testid="placementTracking"><button aria-label="Following @alice" data-testid="777-unfollow"><span>Following</span></button></div>'); }, 600);` });
      const fs = await p.call({ sx: "followState", handle: "alice", waitMs: 5000 });
      assert.equal(fs.ok, true);
      assert.equal(fs.youFollow, true, "read once the button rendered");
    } finally { await p.close(); }
    const q = await open("https://x.com/alice", profilePage("alice"));
    try {
      const r = await q.call({ sx: "scrapeProfile" });
      assert.equal(r.profile.youFollow, false, "the header says Follow (the post's button is not the header's)");
      assert.equal((await q.call({ sx: "followState", handle: "bob", waitMs: 300 })).ok, false, "another account's profile");
    } finally { await q.close(); }
  });

  test("the reply goes in with one paste (X's editor commits it), not character by character", async () => {
    const p = await open(`https://x.com/bigbob/status/${TID}`, statusPage());
    try {
      await p.page.addScriptTag({ content: DRAFT_LIKE });
      const r = await p.call({ sx: "type", text: REPLY, whole: true });
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(await p.page.evaluate(() => document.querySelector('[data-testid="tweetTextarea_0"]').textContent), REPLY);
      assert.equal(await p.page.evaluate(() => window.__pastes), 1);
    } finally { await p.close(); }
  });

  test("submit: a box X re-rendered with other text is repaired by pasting the reply again, then sent", async () => {
    const p = await open(`https://x.com/bigbob/status/${TID}`, statusPage());
    try {
      await p.page.addScriptTag({ content: DRAFT_LIKE });
      await p.call({ sx: "type", text: REPLY, whole: true });
      await p.page.evaluate(() => { document.querySelector('[data-testid="tweetTextarea_0"]').textContent = "wyw wyw ngl the timing"; });
      const r = await p.call({ sx: "submitReply", expectText: REPLY, expectMe: "0x_nation" });
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(await p.page.evaluate(() => document.querySelector('[data-testid="tweetTextarea_0"]').textContent), REPLY);
      assert.ok((await p.clicks()).includes("tweetButtonInline"), "Reply clicked with the right text");
    } finally { await p.close(); }
  });

  test("submit: text that cannot be put right is never sent (composer_text_mismatch, nothing clicked)", async () => {
    const p = await open(`https://x.com/bigbob/status/${TID}`, statusPage());
    try {
      // An editor that rewrites itself to other text on every paste (stuck state).
      await p.page.addScriptTag({ content: `(() => { const b = document.querySelector('[data-testid="tweetTextarea_0"]'); b.addEventListener("paste", (e) => { e.preventDefault(); b.textContent = "something else entirely"; }); b.textContent = "something else entirely"; })();` });
      const r = await p.call({ sx: "submitReply", expectText: REPLY, expectMe: "0x_nation" });
      assert.equal(r.ok, false);
      assert.equal(r.error, "composer_text_mismatch");
      assert.ok(!(await p.clicks()).includes("tweetButtonInline"));
    } finally { await p.close(); }
  });

  test("typing stops when a prompt is up (nothing is inserted)", async () => {
    const p = await open(`https://x.com/bigbob/status/${TID}`, statusPage(PROMPT));
    try {
      const r = await p.call({ sx: "type", text: "Hello" });
      assert.equal(r.state, "unknown_prompt");
      assert.equal(await p.page.evaluate(() => document.querySelector('[data-testid="tweetTextarea_0"]').textContent), "");
    } finally { await p.close(); }
  });
});
