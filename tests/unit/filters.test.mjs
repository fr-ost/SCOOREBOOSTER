import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { skipReason, tooFresh, postAgeMin, textWithoutLinks } from "../../extension/lib/filters.js";
import { sanitizeSettings } from "../../extension/lib/store.js";
import { MIN, _setClock } from "../../extension/lib/util.js";

const NOW = Date.UTC(2026, 9, 29, 8, 0);
const settings = sanitizeSettings({});
const s0 = sanitizeSettings({ safety: { skip: { minChars: 0 } } }); // to reach the gm rule with very short posts
const LONG = "Ethereum fees dropped 90% after the blob upgrade and almost nobody noticed it.";

const post = (over = {}) => ({
  id: "1849000000000000001", url: "https://x.com/foo/status/1849000000000000001", author: "foo", authorName: "Foo",
  text: LONG, lang: "en", createdAt: NOW - 5 * MIN,
  isReply: false, isRepost: false, isQuote: false, isPromoted: false, isPinned: false,
  hasMedia: false, hasCard: false, links: [], metrics: { replies: 3, reposts: 1, likes: 20, views: 900 },
  ...over,
});
const code = (over, s = settings, ts = NOW) => { const r = skipReason(post(over), s, { ts }); return r ? r.code : null; };

describe("filters.js", () => {
  afterEach(() => _setClock(null));

  test("a normal original post passes", () => {
    assert.equal(skipReason(post(), settings, { ts: NOW }), null);
    assert.equal(code({ hasMedia: true }), null);
  });

  test("invalid post", () => {
    assert.equal(skipReason(null, settings, { ts: NOW }).code, "invalid");
    assert.equal(code({ id: "" }), "invalid");
  });

  test("ads / reposts / replies / quotes", () => {
    assert.equal(code({ isPromoted: true }), "ad");
    assert.equal(code({ isPromoted: true }, sanitizeSettings({ safety: { skip: { ads: false } } })), null);
    assert.equal(code({ isRepost: true }), "repost");
    assert.equal(code({ isReply: true }), "reply");
    assert.equal(code({ isQuote: true }), null);
    assert.equal(code({ isQuote: true }, sanitizeSettings({ watch: { includeQuotes: false } })), "quote");
  });

  test("link-only posts", () => {
    assert.equal(code({ text: "Big news https://t.co/abc123" }), "link_only");
    assert.equal(code({ text: "Read this thread https://t.co/xyz789" }), "link_only"); // url + 3 words
    assert.equal(code({ text: "Check it out now", links: ["https://example.com/launch"] }), "link_only");
    assert.equal(code({ text: "New blog post is live", hasCard: true }), "link_only");
    assert.equal(code({ text: LONG + " https://t.co/abc" }), null);
    const noLinkRule = sanitizeSettings({ safety: { skip: { linkOnly: false } } });
    assert.equal(code({ text: "Read this thread https://t.co/xyz789" }, noLinkRule), "too_short");
  });

  test("too short", () => {
    assert.equal(code({ text: "nice weather" }), "too_short");
    assert.equal(code({ text: "nice weather today", hasMedia: true }), null); // media posts may be short
    assert.equal(code({ text: "ok", hasMedia: true }), "too_short");
    assert.equal(code({ text: "" , hasMedia: true }), "too_short");
    assert.equal(code({ text: "@someone @other" }), "too_short");
  });

  test("gm / greeting variants", () => {
    assert.notEqual(code({ text: "gm" }), null); // skipped either way
    assert.notEqual(code({ text: "gm" }, s0), null);
    for (const t of ["GM fam ☀️", "good morning CT", "gm gm", "gm frens 🌞🌞", "Good night everyone", "Happy Friday fam!", "gm ☕", "GM!!!"]) {
      assert.equal(code({ text: t }, s0), "gm", t);
    }
    assert.equal(code({ text: "Good morning everyone! ☕☕☕ ☀️" }), "gm");
  });

  test("gm lookalikes are NOT greetings", () => {
    assert.equal(code({ text: "gmx v2 launched today with isolated pools and lower fees for traders" }), null);
    assert.equal(code({ text: "GM's new EV lineup undercuts Tesla on price in every segment" }), null);
    assert.equal(code({ text: "gm. Here is my thesis on why restaking yields compress next year" }), null);
    assert.equal(code({ text: "Good morning! Rates are up again and mortgage demand is collapsing fast" }), null);
  });

  test("giveaways / engagement bait", () => {
    for (const t of [
      "Giveaway! RT & follow to win 500 USDT, ends Friday",
      "Drop your wallet below for the next round of rewards",
      "Airdrop for first 100 people who join the discord today",
      "Free mint is live for holders, whitelist closes tonight",
      "Like & RT this and tag 3 friends to enter the raffle",
      "$100 to 5 winners who quote this with their best take",
    ]) assert.equal(code({ text: t }), "giveaway", t);
    assert.equal(code({ text: "Giveaway! RT & follow to win 500 USDT, ends Friday" }, sanitizeSettings({ safety: { skip: { giveaways: false } } })), null);
  });

  test("political keywords match whole words only", () => {
    assert.equal(code({ text: "The election results will move markets more than any Fed decision this year" }), "political");
    assert.equal(code({ text: "Natural selection applies to protocols too, the weak ones fade quietly" }), null);
    assert.equal(code({ text: "#Trump pumps another memecoin today and volume is wild" }), "political");
    assert.equal(code({ text: "Everyone is aping into $TRUMP again, volume is wild today" }), "political");
    assert.equal(code({ text: "Who should I vote for in the community poll this week, thoughts?" }), "political");
    assert.equal(code({ text: "Trumpets and violins in one song, that arrangement is wild" }), null);
    assert.equal(code({ text: "The ELECTION, again, is all anyone talks about on here" }), "political");
    const off = sanitizeSettings({ safety: { skip: { political: false } } });
    assert.equal(code({ text: "The election results will move markets more than any Fed decision this year" }, off), null);
  });

  test("sensitive topics (checked with the political rule)", () => {
    assert.equal(code({ text: "RIP to a real builder, the ecosystem lost a legend today" }), "sensitive");
    assert.equal(code({ text: "Thoughts and prayers for everyone affected by the earthquake tonight" }), "sensitive");
    assert.equal(code({ text: "Ripple just announced a new stablecoin for cross-border payments" }), null);
    assert.equal(code({ text: "RIP to a real builder, the ecosystem lost a legend today" }, sanitizeSettings({ safety: { skip: { political: false } } })), null);
  });

  test("blocked words", () => {
    const s = sanitizeSettings({ safety: { skip: { blockedWords: ["Casino", "presale"] } } });
    assert.equal(code({ text: "New casino token launching with insane yields today" }, s), "blocked_word");
    assert.equal(skipReason(post({ text: "Join the PRESALE now before listing on every exchange" }), s, { ts: NOW }).text, 'Contains blocked word "presale"');
    assert.equal(code({ text: "Casinos are a terrible analogy for prediction markets honestly" }, s), null);
  });

  test("language allow-list (und / zxx / empty always pass)", () => {
    const s = sanitizeSettings({ safety: { skip: { languages: ["en"] } } });
    assert.equal(code({ lang: "bn" }, s), "language");
    assert.equal(code({ lang: "en" }, s), null);
    assert.equal(code({ lang: "EN" }, s), null);
    assert.equal(code({ lang: "und" }, s), null);
    assert.equal(code({ lang: "zxx" }, s), null);
    assert.equal(code({ lang: "qme" }, s), null);
    assert.equal(code({ lang: "" }, s), null);
    assert.equal(code({ lang: undefined }, s), null);
    assert.equal(code({ lang: "bn" }), null); // empty list = any language
  });

  test("stale by age (ctx.ts or injected clock)", () => {
    assert.equal(code({ createdAt: NOW - 30 * MIN }), "stale");
    assert.equal(code({ createdAt: NOW - 19 * MIN }), null);
    assert.equal(code({ createdAt: null }), null);
    assert.match(skipReason(post({ createdAt: NOW - 45 * MIN }), settings, { ts: NOW }).text, /45 min old \(max 20\)/);
    _setClock(() => NOW + 60 * MIN);
    assert.equal(skipReason(post(), settings).code, "stale");
  });

  test("tooFresh / postAgeMin", () => {
    assert.equal(tooFresh(post({ createdAt: NOW - 1 * MIN }), settings, NOW), true);
    assert.equal(tooFresh(post({ createdAt: NOW - 3 * MIN }), settings, NOW), false);
    assert.equal(tooFresh(post({ createdAt: null }), settings, NOW), false);
    assert.equal(tooFresh(post({ createdAt: NOW - 1 * MIN }), sanitizeSettings({ watch: { minPostAgeMin: 0 } }), NOW), false);
    assert.equal(postAgeMin(post({ createdAt: NOW - 7 * MIN }), NOW), 7);
    assert.equal(postAgeMin({ createdAt: null }, NOW), null);
    assert.equal(postAgeMin(null, NOW), null);
  });

  test("textWithoutLinks", () => {
    assert.equal(textWithoutLinks("check https://t.co/x and site.io/path @foo ok"), "check and ok");
    assert.equal(textWithoutLinks(null), "");
  });
});
