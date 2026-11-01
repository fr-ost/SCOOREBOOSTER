// Smart-follower database (TwitterScore paid API, every page) + CSV / XLSX export, the "key doesn't work" message,
// the posted-count badge, and removing targets that already follow you.
import { resetStorage, rawGet } from "./_chrome.mjs";
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as S from "../../extension/lib/store.js";
import * as SB from "../../extension/lib/scoreboard.js";
import * as SDB from "../../extension/lib/smartdb.js";
import { toXlsx, toCsv } from "../../extension/lib/xlsx.js";
import { useMemoryDb } from "../../extension/lib/db.js";
import { K, STATUS } from "../../extension/lib/constants.js";
import { pruneFollowers } from "../../extension/lib/follow.js";
import { newTarget, applyFollow } from "../../extension/lib/targets.js";
import { setBadge } from "../../extension/lib/notify.js";
import { _setClock, DAY } from "../../extension/lib/util.js";

const res = (status, body) => ({ status, ok: status >= 200 && status < 300, text: async () => JSON.stringify(body) });
const FAST = { gapMs: 0 };
const KEY = "ts-key-1234567890abcdef";

// A fake TwitterScore API as documented: page is 1-based, size defaults to 5 and is capped at 25, a page past the last is
// empty (with the same total). Options: no total in the answer, a deprecated first endpoint (404), a rate limit.
function fakeApi({ perAccount = { big: 130 }, status = 200, body = null, noTotal = false, oldGone = false, rateOnce = false } = {}) {
  const urls = [];
  let limited = false;
  const fetchImpl = async (url) => {
    urls.push(url);
    if (body) return res(status, body);
    const u = new URL(url);
    if (oldGone && u.pathname.endsWith("/top_followers_paginate")) return res(404, { success: false, message: "Not found" });
    if (rateOnce && !limited && Number(u.searchParams.get("page")) === 2) { limited = true; return res(429, { success: false, message: "Too many requests" }); }
    const who = u.searchParams.get("username"), page = Number(u.searchParams.get("page") || 1);
    const size = Math.min(25, Number(u.searchParams.get("size") || 5));
    const n = perAccount[who] || 0;
    const rows = [];
    for (let i = (page - 1) * size; i < Math.min(n, page * size); i++) rows.push({ username: `${who}_f${i}`, name: `F ${i}`, twitter_score: 1000 - i, followers_count: 100 + i });
    const key = u.pathname.endsWith("/get_followers") ? "followers" : "top_followers";
    return res(status, noTotal ? { success: true, [key]: rows } : { success: true, total: n, [key]: rows });
  };
  return { urls, fetchImpl };
}

async function setup({ enabled = true, mode = "auto", key = KEY, dailyCap = 100 } = {}) {
  await S.saveSettings(S.sanitizeSettings({ providers: { twitterscore: { enabled, mode, dailyCap } } }));
  if (key) await S.setSecrets({ twitterscoreKey: key });
}

describe("smart follower database", () => {
  beforeEach(() => { resetStorage(); useMemoryDb(); globalThis.chrome.permissions = { contains: async () => true }; });
  afterEach(() => { delete globalThis.chrome.permissions; _setClock(null); });

  test("every smart follower: 25 per request (the API's cap), all pages, the daily cap does not stop it", async () => {
    await setup({ dailyCap: 3 });
    const api = fakeApi({ perAccount: { big: 130, small: 30 } });
    const r = await SB.buildSmartDb(["@big", "https://x.com/small"], { fetchImpl: api.fetchImpl, ...FAST });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.found, 160);
    assert.equal(r.added, 160);
    assert.equal(r.total, 160);
    assert.equal(r.pages, 8, "big: 6 pages (5 x 25 + 5), small: 2 (25 + 5) - the total ends each account without an empty page");
    assert.equal(r.requests, 8);
    assert.ok(api.urls.every((u) => /top_followers_paginate\?username=\w+&page=\d+&size=25&/.test(u)), api.urls[0]);
    const rows = await SDB.listRows();
    assert.equal(rows.length, 160);
    assert.equal(rows[0].score, 1000, "best first");
    assert.ok(rows[0].scannedAt > 0 && rows[0].sources.length === 1);
  });

  test("an answer without a total: pages until the short (or empty) page", async () => {
    await setup();
    let api = fakeApi({ perAccount: { big: 60 }, noTotal: true });
    let r = await SB.buildSmartDb(["big"], { fetchImpl: api.fetchImpl, ...FAST });
    assert.deepEqual([r.found, r.requests], [60, 3], "25 + 25 + 10 (short page ends it)");
    resetStorage(); useMemoryDb(); await setup();
    api = fakeApi({ perAccount: { big: 50 }, noTotal: true });
    r = await SB.buildSmartDb(["big"], { fetchImpl: api.fetchImpl, ...FAST });
    assert.deepEqual([r.found, r.requests], [50, 3], "25 + 25 + an empty page");
  });

  test("scanning several accounts merges duplicates: one row per username, newest score and date, every account it was found under", async () => {
    await setup();
    _setClock(() => 1_000_000);
    await SDB.upsertRows("alpha", [{ handle: "shared", score: 500 }, { handle: "alpha" }]);
    _setClock(() => 2_000_000);
    const u = await SDB.upsertRows("beta", [{ handle: "Shared", score: 520 }], 2_000_000);
    assert.deepEqual(u, { added: 0, updated: 1 });
    const row = (await SDB.listRows()).find((x) => x.handle === "shared");
    assert.deepEqual(row.sources, ["alpha", "beta"]);
    assert.equal(row.score, 520);
    assert.equal(row.scannedAt, 2_000_000);
    assert.equal((await SDB.listRows()).some((x) => x.handle === "alpha"), false, "an account is never its own smart follower");
    await SDB.upsertRows("gamma", [{ handle: "shared", score: null }], 3_000_000);
    assert.equal((await SDB.listRows())[0].score, 520, "a row without a score keeps the last known one");
    assert.equal(await SDB.removeRows(["@shared"]), 1);
    assert.equal(await SDB.countRows(), 0);
  });

  test("a total that is really this page's count (25 on a full page) never ends the scan after page 1", async () => {
    await setup();
    const fetchImpl = async (url) => {
      const u = new URL(url), page = Number(u.searchParams.get("page"));
      const rows = []; for (let i = (page - 1) * 25; i < Math.min(70, page * 25); i++) rows.push({ username: "m_" + i, twitter_score: 1 });
      return res(200, { success: true, total: rows.length, count: rows.length, top_followers: rows });
    };
    const r = await SB.buildSmartDb(["big"], { fetchImpl, ...FAST });
    assert.equal(r.found, 70, "25 + 25 + 20");
    assert.equal(r.requests, 3);
  });

  test("an API that ignores the page number stops at the repeated page (no endless loop)", async () => {
    await setup();
    const rows = Array.from({ length: 25 }, (_, i) => ({ username: "same" + i, twitter_score: 10 }));
    let calls = 0;
    const r = await SB.buildSmartDb(["big"], { fetchImpl: async () => { calls++; return res(200, { top_followers: rows }); }, ...FAST });
    assert.equal(r.ok, true);
    assert.equal(calls, 2);
    assert.equal(r.added, 25);
  });

  test("top_followers_paginate gone (404): its replacement get_followers is used for the rest of the run", async () => {
    await setup();
    const api = fakeApi({ perAccount: { big: 40, other: 10 }, oldGone: true });
    const r = await SB.buildSmartDb(["big", "other"], { fetchImpl: api.fetchImpl, ...FAST });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.found, 50);
    assert.equal(api.urls.filter((u) => u.includes("top_followers_paginate")).length, 1, "the old endpoint is asked once");
    assert.ok(api.urls.slice(1).every((u) => u.includes("/get_followers?")), api.urls.join("\n"));
  });

  test("a rate limit (429) waits and asks the same page again; nothing is lost", async () => {
    await setup();
    let clock = 5_000_000;
    _setClock(() => clock);
    const api = fakeApi({ perAccount: { big: 60 }, rateOnce: true });
    const origSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (fn, ms) => { clock += ms; return origSetTimeout(fn, 0); }; // the minute's wait passes at once
    let r;
    try { r = await SB.buildSmartDb(["big"], { fetchImpl: api.fetchImpl, ...FAST }); } finally { globalThis.setTimeout = origSetTimeout; }
    assert.equal(r.ok, true, r.error);
    assert.equal(r.found, 60);
    assert.equal(api.urls.filter((u) => /page=2&/.test(u)).length, 2, "page 2 asked again after the wait");
  });

  test("Stop keeps the pages already read", async () => {
    await setup();
    const api = fakeApi({ perAccount: { big: 200 } });
    let pagesSeen = 0;
    const r = await SB.buildSmartDb(["big", "other"], { fetchImpl: async (u) => { pagesSeen++; return api.fetchImpl(u); }, shouldStop: async () => pagesSeen >= 2, ...FAST });
    assert.equal(r.ok, true);
    assert.equal(await SDB.countRows(), 50, "2 pages of 25 were saved");
    assert.equal(r.accounts, 1);
  });

  test("an account TwitterScore has nothing for is named; a rejected key stops the scan with a plain message", async () => {
    await setup();
    let r = await SB.buildSmartDb(["big", "nobody"], { fetchImpl: fakeApi({ perAccount: { big: 5 } }).fetchImpl, ...FAST });
    assert.equal(r.ok, true);
    assert.deepEqual(r.empty, ["nobody"]);
    for (const [status, body] of [[401, { detail: "Unauthorized" }], [403, { error: "Forbidden" }], [200, { success: false, error: "Invalid API key" }]]) {
      resetStorage(); useMemoryDb();
      await setup();
      const api = fakeApi({ status, body });
      r = await SB.buildSmartDb(["big", "other"], { fetchImpl: api.fetchImpl, ...FAST });
      assert.equal(r.ok, false);
      assert.match(r.error, /TwitterScore API key doesn't work - get a new key \(https:\/\/twitterscore\.io\/api\/prices\)/, `${status}: ${r.error}`);
      assert.equal(api.urls.length, 1, "stops at once, the other account is not asked");
      assert.ok(!r.error.includes(KEY), "the key is never in the message");
    }
  });

  test("no key / TwitterScore off: a clear message, nothing is fetched", async () => {
    let calls = 0;
    const fetchImpl = async () => { calls++; return res(200, { top_followers: [] }); };
    await setup({ key: "" });
    assert.match((await SB.buildSmartDb(["big"], { fetchImpl, ...FAST })).error, /Add your TwitterScore API key/);
    resetStorage(); useMemoryDb();
    await setup({ enabled: false });
    assert.match((await SB.buildSmartDb(["big"], { fetchImpl, ...FAST })).error, /Turn TwitterScore on/);
    assert.equal(calls, 0);
  });

  test("Find targets reads the best 100 of an account (4 pages), not 20", async () => {
    await setup();
    const api = fakeApi({ perAccount: { big: 300 } });
    const r = await SB.smartFollowersOf("big", { fetchImpl: api.fetchImpl, ...FAST });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.results.twitterscore.list.length, 100);
    assert.equal(r.results.twitterscore.total, 300);
    assert.equal(api.urls.length, SB.LOOKUP_PAGES);
  });

  test("download: Username, TwitterScore, Date of scan, Smart follower of - CSV quoting and the formula guard", async () => {
    await SDB.upsertRows("big", [{ handle: "eve", score: 700 }], Date.UTC(2026, 10, 1, 2, 15));
    await SDB.upsertRows("other", [{ handle: "eve", score: 710 }], Date.UTC(2026, 10, 1, 2, 15));
    const table = SDB.toTable(await SDB.listRows(), "Asia/Dhaka");
    assert.deepEqual(table[0], ["Username", "TwitterScore", "Date of scan", "Smart follower of"]);
    assert.deepEqual(table[1], ["eve", 710, "2026-11-01 08:15", "big, other"]);
    const csv = toCsv(table);
    assert.ok(csv.startsWith("\ufeffUsername,TwitterScore,Date of scan,Smart follower of\r\neve,710,2026-11-01 08:15,\"big, other\""), csv);
    assert.equal(toCsv([["=1+1", "+x", "-y", "@z", 5]]).slice(1), "'=1+1,'+x,'-y,'@z,5", "formula guard");
  });

  test("XLSX: a valid zip with the workbook parts, numbers as numbers, text escaped", () => {
    const bytes = toXlsx([["Handle", "Score", "Bio"], ["eve", 700, "a < b & \"c\"\u0001"]], "Smart followers");
    assert.equal(bytes[0], 0x50); assert.equal(bytes[1], 0x4b); // PK
    const tmp = path.join(os.tmpdir(), `sx-${process.pid}-${Date.now()}.xlsx`);
    fs.writeFileSync(tmp, bytes);
    try {
      let listing = "";
      try { listing = execFileSync("unzip", ["-l", tmp], { encoding: "utf8" }); } catch (_) { listing = ""; }
      if (listing) {
        for (const part of ["[Content_Types].xml", "xl/workbook.xml", "xl/worksheets/sheet1.xml", "xl/styles.xml"]) assert.ok(listing.includes(part), part);
        const sheet = execFileSync("unzip", ["-p", tmp, "xl/worksheets/sheet1.xml"], { encoding: "utf8" });
        assert.ok(sheet.includes('<c r="B2"><v>700</v></c>'), "a number cell");
        assert.ok(sheet.includes("a &lt; b &amp; &quot;c&quot;</t>"), "escaped, control character dropped");
      }
    } finally { fs.rmSync(tmp, { force: true }); }
  });
});

describe("score requests: your own score only, TwitterScore's API only for smart followers", () => {
  beforeEach(() => { resetStorage(); useMemoryDb(); globalThis.chrome.permissions = { contains: async () => true }; });
  afterEach(() => { delete globalThis.chrome.permissions; _setClock(null); });
  const page = (h) => `<html><body><h1>@${h}</h1><div>Twitter Score: 412</div></body></html>`;
  const html = (status, body) => ({ status, ok: status >= 200 && status < 300, text: async () => body });

  test("other accounts: Check any account and target scores are off by default and send nothing; your own handle still works", async () => {
    await S.saveSettings(S.sanitizeSettings({ account: { handle: "0x_nation" }, providers: { ethos: { enabled: true }, moni: { enabled: true } } }));
    await S.save({ [K.targets]: { amy: { handle: "amy", score: null } } });
    let calls = 0;
    const fetchImpl = async () => { calls++; return res(200, { score: 1500, profileId: 7 }); };
    assert.equal((await SB.checkScores("someone", { fetchImpl, ...FAST })).error, SB.OTHERS_OFF);
    assert.equal((await SB.refreshTargetScores(["amy"], "ethos", { fetchImpl, ...FAST })).error, SB.OTHERS_OFF);
    assert.equal(calls, 0);
    assert.equal((await SB.checkScores("@0x_nation", { fetchImpl, ...FAST })).ok, true, "your own account is fine");
    assert.equal(S.sanitizeSettings({}).scores.checkOthers, false);
  });

  test("TwitterScore, your own score: the public page, never the API, even with a key", async () => {
    await setup();
    await S.saveSettings(S.sanitizeSettings({ account: { handle: "0x_nation" }, providers: { twitterscore: { enabled: true, dailyCap: 100 } } }));
    const urls = [];
    const r = await SB.refreshOwn({ force: true, fetchImpl: async (u) => { urls.push(u); return html(200, page("0x_nation")); }, readPage: async () => assert.fail("no tab needed"), ...FAST });
    assert.equal(r.results.twitterscore.score, 412);
    assert.equal(r.results.twitterscore.mode, "public");
    assert.ok(urls.length === 1 && !/\/api\//.test(urls[0]) && !urls[0].includes(KEY), urls[0]);
  });

  test("TwitterScore, your own score: blocked by the bot check -> read in a browser tab instead (no API request)", async () => {
    await setup();
    await S.saveSettings(S.sanitizeSettings({ account: { handle: "0x_nation" }, providers: { twitterscore: { enabled: true, dailyCap: 100 } } }));
    const urls = [], tabs = [];
    const fetchImpl = async (u) => { urls.push(u); return html(403, "<!doctype html><title>Just a moment...</title><div>challenge-platform</div>"); };
    const readPage = async (url) => { tabs.push(url); return { ok: true, score: 412 }; };
    const r = await SB.refreshOwn({ force: true, fetchImpl, readPage, ...FAST });
    assert.equal(r.results.twitterscore.ok, true, JSON.stringify(r.results.twitterscore));
    assert.equal(r.results.twitterscore.mode, "page");
    assert.equal(rawGet(K.scoreboard).own.twitterscore.score, 412);
    assert.deepEqual(tabs, ["https://twitterscore.io/twitter/0x_nation/"]);
    assert.ok(!urls.some((u) => /\/api\//.test(u)), "the API was never asked");
  });

  test("tab access not granted yet: the message says how to allow it", async () => {
    await setup();
    await S.saveSettings(S.sanitizeSettings({ account: { handle: "0x_nation" }, providers: { twitterscore: { enabled: true, dailyCap: 100 } } }));
    globalThis.chrome.permissions = { contains: async (q) => !(q.permissions || []).includes("scripting") };
    const r = await SB.refreshOwn({ force: true, fetchImpl: async () => html(403, "<title>Just a moment...</title>"), readPage: async () => assert.fail("not without access"), ...FAST });
    assert.match(r.results.twitterscore.message, /bot check.*turn it off and on/);
  });
});

describe("badge and follower removal", () => {
  beforeEach(() => { resetStorage(); useMemoryDb(); });

  test("running: the badge shows replies posted in 24 h (capped at 999+); alerts and pause keep their marks", async () => {
    const texts = [], titles = [];
    const saved = globalThis.chrome.action;
    globalThis.chrome.action = {
      setBadgeText: async (o) => { texts.push(o.text); }, setBadgeBackgroundColor: async () => {}, setBadgeTextColor: async () => {},
      setTitle: async (o) => { titles.push(o.title); },
    };
    try {
      await setBadge({ status: STATUS.RUNNING }, 3, 20);
      await setBadge({ status: STATUS.RUNNING }, 0, 1500);
      await setBadge({ status: STATUS.RUNNING, alert: { reason: "captcha" } }, 0, 20);
      await setBadge({ status: STATUS.PAUSED }, 0, 20);
    } finally { globalThis.chrome.action = saved; }
    assert.deepEqual(texts, ["20", "999+", "!", "II"]);
    assert.ok(titles.length === 0 || /3/.test(titles[0]), "pending reviews move to the tooltip");
  });

  test("targets that already follow you (and never got a comment) are removed; followed-back and commented ones stay", async () => {
    const fan = applyFollow(newTarget("fan"), true, Date.now() - DAY);
    const talked = applyFollow(newTarget("talked"), true, Date.now() - DAY); talked.stats = { ...(talked.stats || {}), comments: 3 };
    const open = applyFollow(newTarget("open"), false, Date.now() - DAY);
    await S.save({ [K.targets]: { fan, talked, open } });
    const settings = S.sanitizeSettings({});
    assert.equal(settings.follow.removeFollowers, true, "on by default");
    assert.equal(await pruneFollowers(settings), 1);
    assert.deepEqual(Object.keys(rawGet(K.targets)).sort(), ["open", "talked"]);
    await S.save({ [K.targets]: { fan } });
    assert.equal(await pruneFollowers(S.sanitizeSettings({ follow: { removeFollowers: false } })), 0, "the setting off keeps them");
  });

  test("checks per run: old default 4 becomes 10 once; a value you chose later stays; max 25", () => {
    assert.equal(S.sanitizeSettings({ follow: { checksPerRun: 4 } }).follow.checksPerRun, 10);
    assert.equal(S.sanitizeSettings({ genRev: 2, follow: { checksPerRun: 4 } }).follow.checksPerRun, 4);
    assert.equal(S.sanitizeSettings({ follow: { checksPerRun: 99 } }).follow.checksPerRun, 25);
  });
});
