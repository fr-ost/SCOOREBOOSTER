// Round-2 review fixes for the X page area: the rotation watch moves past profiles that do not render or no longer
// exist and turns the missing ones off (XP2-1), it reports profile pages it cannot read instead of "ok, nothing new"
// (XP2-2), a prompt that shows up while X is still sending a reply does not hide a sent reply (XP2-3), and only our
// own comment counts as "already in the thread" (XP2-4). Worker side against a scripted fake X tab; the content
// script parts in headless Chromium when Playwright is installed (as xpage_dom.test.mjs).
import "./_chrome.mjs";
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { resetStorage } from "./_chrome.mjs";
import { fakeTab, fast, okPage } from "./_xtab.mjs";
import { watchOnce } from "../../extension/lib/watcher.js";
import { postReply } from "../../extension/lib/poster.js";
import { sanitizeSettings, updateTargets, getTargets } from "../../extension/lib/store.js";
import { newTarget } from "../../extension/lib/targets.js";
import { STOP } from "../../extension/lib/constants.js";

const H = 3600e3;
const active = (h, lastCheckedAt) => { const t = newTarget(h); t.rel.followsYou = false; t.rel.checkedAt = Date.now(); t.group = "B"; t.lastCheckedAt = lastCheckedAt; return t; };
const profile = (h) => ({ handle: h, userId: "1", name: h.toUpperCase(), bio: "", followers: 1000, following: 10, verified: false, protected: false, followsYou: false, youFollow: false, followPending: false, defaultAvatar: false, avatar: "", joinedAt: null, location: "" });
const go = { shouldStop: async () => false };
const rotation = (n) => sanitizeSettings({ watch: { strategy: "rotation", rotationPerTick: n, scrolls: 0 } });
const visited = (env) => env.calls.filter((c) => c.cmd === "navigate").map((c) => c.url.replace("https://x.com/", ""));
const handleOf = (tab) => tab.url.split("/").pop();
const seed = (map) => updateTargets(() => map);
const notFound = (detail) => ({ ok: false, settled: "not_found", page: okPage("0x_nation", { state: "not_found", detail }) });
const rendered = (m, tab) => ({ ok: true, profile: profile(handleOf(tab)), tweets: [], articleCount: 0, unparsed: 0 });

describe("XP2-1: rotation moves past profiles that do not render or no longer exist", () => {
  beforeEach(() => resetStorage());

  test("a profile X says does not exist is not picked first again and is turned off", async (t) => {
    fast(t);
    const ts = Date.now();
    await seed({ renamed: active("renamed", ts - 3 * H), alice: active("alice", ts - 2 * H), bob: active("bob", ts - H) });
    const env = fakeTab({
      waitFor: (m, tab) => (handleOf(tab) === "renamed" ? notFound("This account doesn’t exist") : { ok: true, key: "profileUserName" }),
      scrapeProfile: rendered,
    });
    for (let i = 0; i < 4; i++) await watchOnce(env.tab.id, rotation(1), await getTargets(), Date.now(), go);
    assert.deepEqual(visited(env), ["renamed", "alice", "bob", "alice"]);
    const all = await getTargets();
    assert.equal(all.renamed.enabled, false, "turned off, as the follow check does");
    assert.equal(all.renamed.rel.gone, true, "shown as 'not found'");
    assert.equal(all.alice.enabled, true);
  });

  test("as many missing profiles as profiles per check no longer crowd out the live targets", async (t) => {
    fast(t);
    const ts = Date.now();
    await seed({
      gone1: active("gone1", ts - 5 * H), gone2: active("gone2", ts - 5 * H), gone3: active("gone3", ts - 5 * H),
      alice: active("alice", ts - H), bob: active("bob", ts - H),
    });
    const env = fakeTab({
      waitFor: (m, tab) => (/^gone\d$/.test(handleOf(tab)) ? notFound("Account suspended") : { ok: true, key: "profileUserName" }),
      scrapeProfile: rendered,
    });
    for (let i = 0; i < 3; i++) await watchOnce(env.tab.id, rotation(3), await getTargets(), Date.now(), go);
    const v = visited(env);
    assert.equal(v.filter((h) => h.startsWith("gone")).length, 3, "each missing profile is loaded once: " + v.join(","));
    assert.ok(v.includes("alice") && v.includes("bob"), v.join(","));
  });

  test("a profile that does not render goes to the back of the rotation (and stays on)", async (t) => {
    fast(t);
    const ts = Date.now();
    await seed({ broken: active("broken", ts - 3 * H), alice: active("alice", ts - 2 * H), bob: active("bob", ts - H) });
    const env = fakeTab({
      waitFor: (m, tab) => (handleOf(tab) === "broken" ? { ok: false, timeout: true } : { ok: true, key: "profileUserName" }),
      scrapeProfile: (m, tab) => (handleOf(tab) === "broken" ? { ok: true, profile: null, tweets: [] } : rendered(m, tab)),
    });
    for (let i = 0; i < 3; i++) await watchOnce(env.tab.id, rotation(1), await getTargets(), Date.now(), go);
    assert.deepEqual(visited(env), ["broken", "alice", "bob"]);
    assert.equal((await getTargets()).broken.enabled, true, "not rendering is not 'not found'");
  });
});

describe("XP2-2: rotation reports profile pages it cannot read", () => {
  beforeEach(() => resetStorage());
  const three = () => { const ts = Date.now(); return seed({ alice: active("alice", ts - 3 * H), bob: active("bob", ts - 2 * H), carol: active("carol", ts - H) }); };

  test("no profile header renders: like a watch page without posts (visibleEmpty, or hiddenEmpty in a hidden tab)", async (t) => {
    fast(t);
    await three();
    let hidden = false;
    const env = fakeTab({
      waitFor: () => ({ ok: false, timeout: true, page: okPage("0x_nation", { hidden }) }),
      scrapeProfile: () => ({ ok: true, profile: null, tweets: [], page: okPage("0x_nation", { hidden }) }),
    });
    const w = await watchOnce(env.tab.id, rotation(3), await getTargets(), Date.now(), go);
    assert.equal(w.visibleEmpty, true, "the engine stops with 'X page changed' after 4 such checks: " + JSON.stringify(w));
    assert.equal(w.hiddenEmpty, false);
    hidden = true;
    const w2 = await watchOnce(env.tab.id, rotation(3), await getTargets(), Date.now(), go);
    assert.equal(w2.hiddenEmpty, true);
    assert.equal(w2.visibleEmpty, false);
    assert.equal(visited(env).length, 6);
  });

  test("one readable profile in the check: no signal", async (t) => {
    fast(t);
    await three();
    const env = fakeTab({ scrapeProfile: (m, tab) => (handleOf(tab) === "bob" ? rendered(m, tab) : { ok: true, profile: null, tweets: [] }) });
    const w = await watchOnce(env.tab.id, rotation(3), await getTargets(), Date.now(), go);
    assert.equal(w.ok, true);
    assert.ok(!w.visibleEmpty && !w.hiddenEmpty && !w.stop && !w.soft, JSON.stringify(w));
  });

  test("X's error page on every profile: a failed check that feeds the 'Something went wrong' streak", async (t) => {
    fast(t);
    await three();
    const err = okPage("0x_nation", { state: "error_page", detail: "Something went wrong. Try reloading." });
    const env = fakeTab({
      waitFor: () => ({ ok: false, settled: "error_page", page: err }),
      scrapeProfile: () => ({ ok: true, profile: null, tweets: [], page: err }),
    });
    const w = await watchOnce(env.tab.id, rotation(3), await getTargets(), Date.now(), go);
    assert.equal(w.ok, false);
    assert.equal(w.soft, "error_page", JSON.stringify(w));
    const all = await getTargets();
    assert.ok(["alice", "bob", "carol"].every((h) => all[h].lastCheckedAt > Date.now() - 60000), "still moved to the back of the rotation");
  });

  test("posts on the profile pages that cannot be read: DOM_CHANGED stop (over all profiles of the check)", async (t) => {
    fast(t);
    await three();
    const env = fakeTab({ scrapeProfile: (m, tab) => ({ ...rendered(m, tab), articleCount: 2, unparsed: 2 }) });
    const w = await watchOnce(env.tab.id, rotation(3), await getTargets(), Date.now(), go);
    assert.equal(w.stop, STOP.DOM_CHANGED, JSON.stringify(w));
    await three();
    const env2 = fakeTab({ scrapeProfile: (m, tab) => ({ ...rendered(m, tab), articleCount: 2, unparsed: handleOf(tab) === "bob" ? 1 : 2 }) });
    const w2 = await watchOnce(env2.tab.id, rotation(3), await getTargets(), Date.now(), go);
    assert.equal(w2.ok, true, "one readable post: no stop");
  });
});

// ---- poster: only our own comment counts as already posted (XP2-4) ----
const TID = "1900000000000000001";
const TEXT = "Distribution compounds only after activation works. What did your first 100 users share?";
const rec = { id: "r1", postId: TID, postUrl: `https://x.com/bigbob/status/${TID}`, comment: TEXT, target: "bigbob" };
const SENT = { ok: true, replyId: "1900000000000000999", replyUrl: "https://x.com/0x_nation/status/1900000000000000999", via: "toast" };
const MINE_TO_ALICE = { id: "1900000000000000060", url: "https://x.com/0x_nation/status/1900000000000000060", author: "0x_nation", text: "@alice it is a commodity until you need a second channel" };

function xPage(myReplies) {
  const box = { text: "" };
  return {
    waitFor: () => ({ ok: true, key: "tweet" }),
    scrapeStatus: () => ({ ok: true, focal: { id: TID, text: "Most teams ship features.", liked: false }, focalIndex: 0, replies: myReplies, canReply: true, myReplies }),
    type: (m) => { box.text += m.text; return { ok: true, text: box.text }; },
    composerText: () => ({ ok: true, text: box.text }),
    clearComposer: () => { box.text = ""; return { ok: true, text: "" }; },
    openComposer: () => ({ ok: true, where: "inline", text: "" }),
    submitReply: () => ({ ok: true, where: "inline" }),
    replyResult: () => SENT,
  };
}

describe("XP2-4: 'already in the thread' means our comment, not any reply of yours", () => {
  beforeEach(() => resetStorage());
  const run = (env) => postReply(rec, { tabId: env.tab.id, settings: sanitizeSettings({ safety: { readDelaySec: { min: 1, max: 1 } } }), me: "0x_nation", allowLike: true, shouldStop: async () => false });

  test("your own reply to another commenter under the post: the comment is still posted", async (t) => {
    fast(t);
    const env = fakeTab(xPage([MINE_TO_ALICE]));
    const r = await run(env);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.ok(!r.already, "not recorded as posted without posting: " + JSON.stringify(r));
    assert.equal(r.replyId, SENT.replyId);
    assert.equal(env.count("submitReply"), 1);
  });

  test("our comment is already in the thread (an earlier attempt went out): nothing is typed again", async (t) => {
    fast(t);
    const ours = { id: "1900000000000000070", url: "https://x.com/0x_nation/status/1900000000000000070", author: "0x_nation", text: TEXT };
    const env = fakeTab(xPage([MINE_TO_ALICE, ours]));
    const r = await run(env);
    assert.equal(r.already, true);
    assert.equal(r.replyId, ours.id, "the matching reply, not the first reply of yours");
    for (const c of ["like", "openComposer", "type", "submitReply"]) assert.equal(env.count(c), 0, c);
  });
});

// ---- content scripts in Chromium: profile post counts (XP2-2) and the reply result after a prompt (XP2-3) ----
const HERE = path.dirname(new URL(import.meta.url).pathname);
const CONTENT = path.resolve(HERE, "../../extension/content");
const SOURCES = ["selectors.js", "dom.js", "detect.js", "scrape.js", "actions.js", "content.js"].map((f) => fs.readFileSync(path.join(CONTENT, f), "utf8"));
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
const time = () => `<time datetime="${new Date(Date.now() - 5 * 60000).toISOString()}">5m</time>`;
const post = (h, id, text) => `<article data-testid="tweet" role="article"><div data-testid="User-Name"><a href="/${h}" role="link"><span>${h}</span></a><a href="/${h}/status/${id}" role="link">${time()}</a></div><div data-testid="tweetText" lang="en"><span>${text}</span></div><div role="group" aria-label="1 reply"><button data-testid="reply">1</button><button data-testid="like">3</button></div></article>`;
// X changed the permalink markup: the time is no longer wrapped in a status link and no status link is left.
const brokenPost = (h, id, text) => `<article data-testid="tweet" role="article"><div data-testid="User-Name"><a href="/${h}"><span>${h}</span></a><div role="link" data-href="/${h}/status/${id}">${time()}</div></div><div data-testid="tweetText" lang="en"><span>${text}</span></div><div role="group" aria-label="1 reply"><button data-testid="reply">1</button><button data-testid="like">3</button></div></article>`;
const profilePage = (h, posts) => `${NAV}<main role="main"><div data-testid="primaryColumn"><div data-testid="UserName"><div><span>${h.toUpperCase()}</span></div><div><span>@${h}</span></div></div><button data-testid="77-follow">Follow</button>${posts}</div></main>`;
const INLINE = `<div id="composer"><div data-testid="tweetTextarea_0" role="textbox" contenteditable="true" style="min-height:40px"></div><button data-testid="tweetButtonInline">Reply</button></div>`;
const statusPage = () => `${NAV}<main role="main"><div data-testid="primaryColumn">${post("bigbob", TID, "Most teams ship features. The best teams ship distribution.")}${INLINE}</div></main><div id="layers"></div>`;
const SHEET = `<div data-testid="sheetDialog" role="dialog" aria-modal="true" style="position:fixed;bottom:0;left:0;width:400px;height:150px;background:#fff"><span>Turn on notifications</span><span>Get notified when people reply.</span><button>Allow</button><button>Not now</button></div>`;

describe("XP2-2 / XP2-3: content scripts on X-like pages", { skip: chromium ? false : "Playwright/Chromium not installed" }, () => {
  let browser;
  before(async () => { browser = await chromium.launch({ headless: true }); });
  after(async () => { if (browser) await browser.close(); });

  async function open(url, html) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    await page.route("https://x.com/**", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><html><head><meta charset=utf-8></head><body></body></html>" }));
    await page.goto(url);
    await page.evaluate((h) => { document.body.innerHTML = h; }, html);
    await page.addScriptTag({ content: FAKE_CHROME });
    for (const src of SOURCES) await page.addScriptTag({ content: src });
    return { page, call: (msg) => page.evaluate((m) => window.__sxCall(m), msg), clicks: () => page.evaluate(() => window.__clicks.slice()), close: () => ctx.close() };
  }

  test("scrapeProfile counts the posts on the page and the ones it could not read (XP2-2)", async () => {
    let p = await open("https://x.com/alice", profilePage("alice", [1, 2, 3, 4].map((i) => brokenPost("alice", "19000000000000002" + i, "post " + i)).join("")));
    try {
      const r = await p.call({ sx: "scrapeProfile" });
      assert.equal(r.profile.handle, "alice");
      assert.equal(r.articleCount, 4);
      assert.equal(r.unparsed, 4, JSON.stringify({ articleCount: r.articleCount, unparsed: r.unparsed }));
    } finally { await p.close(); }
    p = await open("https://x.com/alice", profilePage("alice", [1, 2].map((i) => post("alice", "19000000000000003" + i, "post " + i)).join("")));
    try {
      const r = await p.call({ sx: "scrapeProfile" });
      assert.deepEqual([r.articleCount, r.unparsed, r.tweets.length], [2, 0, 2]);
    } finally { await p.close(); }
  });

  test("a sheet while X is still sending: the box clears and X says sent -> reported as sent (XP2-3)", async () => {
    const p = await open(`https://x.com/bigbob/status/${TID}`, statusPage());
    try {
      await p.page.evaluate((sheet) => {
        const box = document.querySelector('[data-testid="tweetTextarea_0"]');
        box.textContent = "My reply text";
        setTimeout(() => { document.getElementById("layers").innerHTML = sheet; }, 300);
        setTimeout(() => {
          box.textContent = "";
          document.body.insertAdjacentHTML("beforeend", `<div data-testid="toast" role="alert"><span>Your post was sent.</span> <a href="/0x_nation/status/1900000000000000999">View</a></div>`);
        }, 1500);
      }, SHEET);
      const r = await p.call({ sx: "replyResult", tweetId: TID, expectText: "My reply text", me: "0x_nation", timeoutMs: 20000 });
      assert.equal(r.state, "unknown_prompt");
      assert.equal(r.cleared, true, "measured after X finished sending: " + JSON.stringify(r));
      assert.equal(r.sent, true);
      assert.match(r.replyUrl, /1900000000000000999/);
      assert.deepEqual(await p.clicks(), [], "the sheet is never clicked");
    } finally { await p.close(); }
  });

  test("a sheet and the text stays in the box: not sent; an X warning toast after the sheet: X refused it (XP2-3)", async () => {
    let p = await open(`https://x.com/bigbob/status/${TID}`, statusPage());
    try {
      await p.page.evaluate((sheet) => {
        document.querySelector('[data-testid="tweetTextarea_0"]').textContent = "My reply text";
        setTimeout(() => { document.getElementById("layers").innerHTML = sheet; }, 200);
      }, SHEET);
      const r = await p.call({ sx: "replyResult", tweetId: TID, expectText: "My reply text", me: "0x_nation", timeoutMs: 2000 });
      assert.equal(r.state, "unknown_prompt");
      assert.equal(r.cleared, false);
      assert.equal(r.sent, false);
      assert.deepEqual(await p.clicks(), []);
    } finally { await p.close(); }
    p = await open(`https://x.com/bigbob/status/${TID}`, statusPage());
    try {
      await p.page.evaluate((sheet) => {
        document.querySelector('[data-testid="tweetTextarea_0"]').textContent = "My reply text";
        setTimeout(() => { document.getElementById("layers").innerHTML = sheet; }, 200);
        setTimeout(() => document.body.insertAdjacentHTML("beforeend", `<div data-testid="toast" role="alert"><span>This request looks like it might be automated.</span></div>`), 700);
      }, SHEET);
      const r = await p.call({ sx: "replyResult", tweetId: TID, expectText: "My reply text", me: "0x_nation", timeoutMs: 20000 });
      assert.equal(r.state, "warning", JSON.stringify(r));
    } finally { await p.close(); }
  });
});
