// The UniqueFarm reply voice in ScoreX: settings migration (old default Tone prompt and tier presets), the final
// touches on a reply, the bot-phrase / opener / greeting rules, the request body for chat vs reasoning models (images,
// temperature, verbosity), and the content script reading a post's images and quoted post.
import "./_chrome.mjs";
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { sanitizeSettings, DEFAULT_TONE_PROMPT, LEGACY_DEFAULT_TONE_PROMPT, TONE_MAX } from "../../extension/lib/store.js";
import { humanize, collapseRepeats, ruleCheck } from "../../extension/lib/quality.js";
import { buildBody } from "../../extension/lib/openai.js";
import { DEFAULT_VOICE, VOICE_PRESETS, BOT_PHRASES, NEVER_START, VOICE_SYSTEM } from "../../extension/lib/voices.js";
import { toneText } from "../../extension/lib/targets.js";

describe("UniqueFarm voice: settings", () => {
  test("the default Tone prompt is the UniqueFarm voice, and the voice presets are built-in tones", () => {
    const s = sanitizeSettings({});
    assert.equal(DEFAULT_TONE_PROMPT, DEFAULT_VOICE);
    assert.equal(s.prompt.tone, DEFAULT_VOICE);
    assert.ok(DEFAULT_VOICE.length > 2000 && DEFAULT_VOICE.length <= TONE_MAX, "fits the Tone prompt limit");
    for (const k of ["casual", "delta", "chill", "sharp", "question"]) assert.equal(s.tones[k], VOICE_PRESETS[k].text, k);
    assert.equal(toneText("delta", s), VOICE_PRESETS.delta.text);
    assert.equal(s.prompt.useImages, true);
    assert.equal(s.prompt.temperature, 1.0);
    assert.equal(s.genRev, 2);
    assert.ok(VOICE_SYSTEM.startsWith("You write replies on X like a real human"));
    assert.ok(BOT_PHRASES.includes("sounds like") && BOT_PHRASES.includes("game changer"));
    assert.ok(NEVER_START.includes("i think"));
  });

  test("migration: an install on the old defaults moves to the UniqueFarm voice and the Human preset once; hand-made choices stay", () => {
    const old = sanitizeSettings({ prompt: { tone: LEGACY_DEFAULT_TONE_PROMPT }, presetMatrix: { A1: "balanced", A2: "cheap", B1: "high", B2: "balanced" }, safetyRev: 2 });
    assert.equal(old.prompt.tone, DEFAULT_VOICE);
    assert.deepEqual([old.presetMatrix.B1, old.presetMatrix.B2], ["human", "human"]);
    assert.equal(old.genRev, 2);
    const mine = sanitizeSettings({ prompt: { tone: "lowercase. blunt. one detail." }, presetMatrix: { B1: "cheap", B2: "balanced" } });
    assert.equal(mine.prompt.tone, "lowercase. blunt. one detail.");
    assert.deepEqual([mine.presetMatrix.B1, mine.presetMatrix.B2], ["cheap", "balanced"]);
    // Already migrated: going back to the old presets by hand is kept.
    const back = sanitizeSettings({ genRev: 1, prompt: { tone: LEGACY_DEFAULT_TONE_PROMPT }, presetMatrix: { B1: "high", B2: "balanced" } });
    assert.equal(back.prompt.tone, LEGACY_DEFAULT_TONE_PROMPT);
    assert.deepEqual([back.presetMatrix.B1, back.presetMatrix.B2], ["high", "balanced"]);
  });

  test("temperature and image settings are clamped / kept", () => {
    assert.equal(sanitizeSettings({ prompt: { temperature: 9 } }).prompt.temperature, 1.5);
    assert.equal(sanitizeSettings({ prompt: { temperature: -1 } }).prompt.temperature, 0);
    assert.equal(sanitizeSettings({ prompt: { temperature: "x" } }).prompt.temperature, 1.0);
    assert.equal(sanitizeSettings({ prompt: { useImages: false } }).prompt.useImages, false);
    assert.equal(sanitizeSettings({ tones: { delta: "y".repeat(9000) } }).tones.delta.length, TONE_MAX);
  });
});

describe("UniqueFarm voice: final touches and rules", () => {
  test("humanize keeps '...', '?', '!' and numbers, drops bot emojis, a trailing comma and (most) final periods", () => {
    assert.equal(humanize("wait this is actually big."), "wait this is actually big");
    assert.equal(humanize("big if it holds.", { keepPeriod: true }), "big if it holds.");
    assert.equal(humanize("watching this one..."), "watching this one...");
    assert.equal(humanize("so who pays for the blobs?"), "so who pays for the blobs?");
    assert.equal(humanize("lets go!"), "lets go!");
    assert.equal(humanize("2.7M users in a week."), "2.7M users in a week");
    assert.equal(humanize("clean launch 🚀✨,"), "clean launch");
    assert.equal(humanize(", ok this changes things"), "ok this changes things");
    assert.equal(humanize("ngl 😂"), "ngl 😂", "allowed emojis stay");
  });

  test("collapseRepeats removes a doubled reply or sentence, nothing else", () => {
    assert.equal(collapseRepeats("ok this is big ok this is big"), "ok this is big");
    assert.equal(collapseRepeats("fees dropped. fees dropped. now what"), "fees dropped. now what");
    assert.equal(collapseRepeats("no no no this is wrong"), "no no no this is wrong");
    assert.equal(collapseRepeats("the u.s. market opens at 9.30"), "the u.s. market opens at 9.30");
  });

  const s = sanitizeSettings({});
  const codes = (t, ctx = {}) => ruleCheck(t, { settings: s, ...ctx }).reasons.map((r) => r.code);
  test("bot phrases anywhere and banned openers are rule failures (the reply is rewritten)", () => {
    assert.deepEqual(codes("ngl the timing on this is what makes it actually work"), []);
    assert.ok(codes("this sounds like a solid plan for fees").includes("bot_phrase"));
    assert.ok(codes("watching this closely, the fee drop is real").includes("bot_phrase"));
    assert.ok(codes("I think the fee drop is the real story here").includes("generic_opener"));
    assert.ok(codes("Wow the fee drop came out of nowhere").includes("generic_opener"));
    assert.ok(codes("Honestly the fee drop came out of nowhere").length === 0, "Honestly is a fine opener");
    assert.deepEqual(codes("lovely chart, the fee drop is the whole point"), [], "'love' only as a whole word");
    assert.ok(codes("it’s important to watch fees").includes("bot_phrase"), "curly apostrophes match too");
  });

  test("a pure greeting post allows a tiny reply; other posts keep the minimum length and generic checks", () => {
    assert.deepEqual(codes("gm fam", { greeting: "pure" }), []);
    assert.ok(codes("gm fam").includes("too_short"));
    assert.ok(codes("wagmi").includes("generic") || codes("wagmi").includes("too_short"));
    assert.ok(codes("sounds like a plan", { greeting: "pure" }).includes("bot_phrase"), "bot phrases still count");
  });
});

describe("UniqueFarm voice: request body", () => {
  const chat = { name: "gpt-4o-mini", reasoning: false, maxOutputTokens: 400 };
  const thinker = { name: "gpt-6.1-terra", reasoning: true, maxOutputTokens: 2500 };
  test("a chat model gets the temperature and no verbosity; a reasoning model gets effort and verbosity, never a temperature", () => {
    const a = buildBody({ model: chat, instructions: "i", input: "x", effort: "low", temperature: 1 });
    assert.equal(a.temperature, 1);
    assert.equal("reasoning" in a, false);
    assert.equal("text" in a, false);
    assert.equal(a.max_output_tokens, 400);
    const b = buildBody({ model: thinker, instructions: "i", input: "x", effort: "low", temperature: 1 });
    assert.equal("temperature" in b, false);
    assert.deepEqual(b.reasoning, { effort: "low" });
    assert.deepEqual(b.text, { verbosity: "low" });
    assert.equal("temperature" in buildBody({ model: chat, instructions: "i", input: "x", temperature: 1, compat: { noTemperature: true } }), false);
  });

  test("images become low-detail input_image parts (https only, at most 4); compat.noImages drops them", () => {
    const imgs = ["https://pbs.twimg.com/media/1.jpg", "http://insecure/x.jpg", "https://pbs.twimg.com/media/2.jpg", "https://pbs.twimg.com/media/3.jpg", "https://pbs.twimg.com/media/4.jpg", "https://pbs.twimg.com/media/5.jpg"];
    const b = buildBody({ model: chat, instructions: "i", input: { text: "data", images: imgs } });
    const parts = b.input[0].content;
    assert.deepEqual(parts[0], { type: "input_text", text: "data" });
    assert.deepEqual(parts.slice(1).map((p) => [p.type, p.image_url, p.detail]), [["input_image", "https://pbs.twimg.com/media/1.jpg", "low"], ["input_image", "https://pbs.twimg.com/media/2.jpg", "low"], ["input_image", "https://pbs.twimg.com/media/3.jpg", "low"]]);
    assert.equal(buildBody({ model: chat, instructions: "i", input: { text: "data", images: imgs }, compat: { noImages: true } }).input[0].content.length, 1);
    assert.equal(buildBody({ model: chat, instructions: "i", input: "plain" }).input[0].content[0].text, "plain");
  });
});

// ---- the content script reads a post's images and quoted post ----
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
`;
const ISO = new Date(Date.now() - 5 * 60000).toISOString();
const POST_WITH_MEDIA = `<main role="main"><div data-testid="primaryColumn">
<article data-testid="tweet" role="article" tabindex="0">
  <div data-testid="User-Name"><a href="/bigbob" role="link"><span>Big Bob</span></a><div><a href="/bigbob" role="link"><span>@bigbob</span></a><a href="/bigbob/status/1900000000000000001" role="link"><time datetime="${ISO}">5m</time></a></div></div>
  <div data-testid="tweetText" lang="en"><span>Fees after the upgrade, look at this</span></div>
  <div data-testid="tweetPhoto"><img alt="Line chart of L2 fees falling 90 percent" src="https://pbs.twimg.com/media/GaFees1.jpg?format=jpg&amp;name=medium"></div>
  <div data-testid="tweetPhoto"><img alt="Image" src="https://pbs.twimg.com/media/GaFees2.jpg?format=jpg&amp;name=900x900"></div>
  <div data-testid="tweetPhoto"><img alt="" src="https://abs.twimg.com/emoji/v2/svg/1f525.svg"></div>
  <div role="link" tabindex="0">
    <div data-testid="User-Name"><span>Alice</span><span>@alice</span></div>
    <div data-testid="tweetText" lang="en"><span>Blob fees are about to fall off a cliff</span></div>
  </div>
  <div role="group" aria-label="1 reply, 2 reposts, 30 likes, 400 views"><button data-testid="reply">1</button></div>
</article></div></main>`;

describe("UniqueFarm voice: the content script reads images and the quoted post", { skip: chromium ? false : "Playwright/Chromium not installed" }, () => {
  let browser;
  before(async () => { browser = await chromium.launch({ headless: true }); });
  after(async () => { if (browser) await browser.close(); });

  test("scrapeTweets returns up to 4 pbs.twimg.com images (small size, alt text, X's 'Image' placeholder dropped) and the quoted post", async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.route("https://x.com/**", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><html><head><meta charset=utf-8></head><body></body></html>" }));
    await page.goto("https://x.com/home");
    await page.evaluate((h) => { document.body.innerHTML = h; }, POST_WITH_MEDIA);
    await page.addScriptTag({ content: FAKE_CHROME });
    for (const src of SOURCES) await page.addScriptTag({ content: src });
    const r = await page.evaluate(() => window.__sxCall({ sx: "scrapeTweets", limit: 10 }));
    await ctx.close();
    assert.equal(r.ok, true, JSON.stringify(r));
    const t = r.tweets.find((x) => x.id === "1900000000000000001");
    assert.ok(t, "post parsed");
    assert.equal(t.text, "Fees after the upgrade, look at this");
    assert.deepEqual(t.images, [
      { url: "https://pbs.twimg.com/media/GaFees1.jpg?format=jpg&name=small", alt: "Line chart of L2 fees falling 90 percent" },
      { url: "https://pbs.twimg.com/media/GaFees2.jpg?format=jpg&name=small", alt: "" },
    ]);
    assert.deepEqual(t.quoted, { author: "alice", text: "Blob fees are about to fall off a cliff" });
  });
});
