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

// A fake TwitterScore API: `pages` per account, `size` rows each (last page shorter), and every URL it was asked.
function fakeApi({ perAccount = { big: 250 }, status = 200, body = null } = {}) {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    if (body) return res(status, body);
    const u = new URL(url);
    const who = u.searchParams.get("username"), page = Number(u.searchParams.get("page")), size = Number(u.searchParams.get("size"));
    const n = perAccount[who] || 0;
    const rows = [];
    for (let i = (page - 1) * size; i < Math.min(n, page * size); i++) rows.push({ username: `${who}_f${i}`, name: `F ${i}`, twitter_score: 1000 - i, followers_count: 100 + i, description: i === 0 ? "=cmd|calc" : "builder" });
    return res(status, { total: n, top_followers: rows });
  };
  return { urls, fetchImpl };
}

async function setup({ enabled = true, mode = "api", key = KEY, dailyCap = 5000 } = {}) {
  await S.saveSettings(S.sanitizeSettings({ providers: { twitterscore: { enabled, mode, dailyCap } } }));
  if (key) await S.setSecrets({ twitterscoreKey: key });
}

describe("smart follower database", () => {
  beforeEach(() => { resetStorage(); useMemoryDb(); globalThis.chrome.permissions = { contains: async () => true }; });
  afterEach(() => { delete globalThis.chrome.permissions; _setClock(null); });

  test("every page is read (size 100) until the short last page; rows land in the database once each", async () => {
    await setup();
    const api = fakeApi({ perAccount: { big: 250, small: 30 } });
    const r = await SB.buildSmartDb(["@big", "small"], { fetchImpl: api.fetchImpl, ...FAST });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.pages, 4, "big: 3 pages (100, 100, 50), small: 1");
    assert.equal(r.added, 280);
    assert.equal(r.total, 280);
    assert.ok(api.urls.every((u) => /top_followers_paginate\?username=\w+&page=\d+&size=100/.test(u)), api.urls[0]);
    const rows = await SDB.listRows();
    assert.equal(rows[0].score, 1000, "best first");
    assert.equal(rows.find((x) => x.handle === "big_f5").followers, 105);
  });

  test("a second build merges: an account listed by two big accounts counts both, first-seen stays", async () => {
    await setup();
    _setClock(() => 1_000_000);
    await SDB.upsertRows("alpha", [{ handle: "shared", score: 500 }, { handle: "alpha" }]);
    _setClock(() => 2_000_000);
    const u = await SDB.upsertRows("beta", [{ handle: "shared", score: 520, name: "Shared" }]);
    assert.deepEqual(u, { added: 0, updated: 1 });
    const row = (await SDB.listRows()).find((x) => x.handle === "shared");
    assert.deepEqual(row.sources, ["alpha", "beta"]);
    assert.equal(row.sourceCount, 2);
    assert.equal(row.score, 520);
    assert.equal(row.firstSeen, 1_000_000);
    assert.equal(row.lastSeen, 2_000_000);
    assert.equal((await SDB.listRows()).some((x) => x.handle === "alpha"), false, "an account is never its own smart follower");
    assert.equal(await SDB.removeRows(["@shared"]), 1);
    assert.equal(await SDB.countRows(), 0);
  });

  test("an API that ignores the page number stops after the repeated page (no endless loop)", async () => {
    await setup();
    const rows = Array.from({ length: 100 }, (_, i) => ({ username: "same" + i, twitter_score: 10 }));
    let calls = 0;
    const r = await SB.buildSmartDb(["big"], { fetchImpl: async () => { calls++; return res(200, { top_followers: rows }); }, ...FAST, maxPages: 50 });
    assert.equal(r.ok, true);
    assert.equal(calls, 2);
    assert.equal(r.added, 100);
  });

  test("a rejected key (401, 403 or an error body) says plainly: the key doesn't work, get a new one", async () => {
    for (const [status, body] of [[401, { detail: "Unauthorized" }], [403, { error: "Forbidden" }], [200, { success: false, error: "Invalid API key" }]]) {
      resetStorage(); useMemoryDb();
      await setup();
      const api = fakeApi({ status, body });
      const r = await SB.buildSmartDb(["big", "other"], { fetchImpl: api.fetchImpl, ...FAST });
      assert.equal(r.ok, false);
      assert.match(r.error, /TwitterScore API key doesn't work - get a new key \(https:\/\/twitterscore\.io\/api\/prices\)/, `${status}: ${r.error}`);
      assert.equal(api.urls.length, 1, "stops at once, the other account is not asked");
      assert.ok(!r.error.includes(KEY), "the key is never in the message");
    }
  });

  test("no key / TwitterScore off / a mode that is not the API: a clear message, nothing is fetched", async () => {
    let calls = 0;
    const fetchImpl = async () => { calls++; return res(200, { top_followers: [] }); };
    await setup({ key: "" });
    assert.match((await SB.buildSmartDb(["big"], { fetchImpl, ...FAST })).error, /Add your TwitterScore API key/);
    resetStorage(); useMemoryDb();
    await setup({ enabled: false });
    assert.match((await SB.buildSmartDb(["big"], { fetchImpl, ...FAST })).error, /Turn on TwitterScore/);
    assert.equal(calls, 0);
  });

  test("CSV: header row, BOM, quoting, and a cell that would run as a formula is neutralised", async () => {
    await SDB.upsertRows("big", [{ handle: "eve", name: 'Eve "E", Esq', score: 700, followers: 1234, bio: "=HYPERLINK(\"x\")", tags: ["vc", "defi"] }]);
    const csv = toCsv(SDB.toTable(await SDB.listRows()));
    assert.ok(csv.startsWith("﻿Handle,Name,TwitterScore,Followers,"));
    const line = csv.split("\r\n")[1];
    assert.ok(line.startsWith('eve,"Eve ""E"", Esq",700,1234,1,big,"vc, defi",'), line);
    assert.ok(line.includes(`"'=HYPERLINK(""x"")"`), "formula prefixed with '");
    assert.ok(line.includes("https://x.com/eve"));
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
