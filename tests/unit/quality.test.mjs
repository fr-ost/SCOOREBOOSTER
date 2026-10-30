import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { sanitizeComment, ruleCheck, similarity, scriptOf, feedbackFor, GENERIC_PHRASES } from "../../extension/lib/quality.js";
import { DEFAULT_SETTINGS } from "../../extension/lib/store.js";

const settings = { quality: { ...DEFAULT_SETTINGS.quality } };
const codes = (text, ctx = {}) => ruleCheck(text, { settings, ...ctx }).reasons.map((r) => r.code);
const GOOD = "Fee drops only matter if wallets surface them; most users never see the gas line at all.";

describe("quality.js", () => {
  describe("sanitizeComment", () => {
    test("strips surrounding quotes (straight, curly, guillemets, backticks)", () => {
      assert.equal(sanitizeComment('"Fees only matter when they spike."'), "Fees only matter when they spike.");
      assert.equal(sanitizeComment("“Curly quotes work too”"), "Curly quotes work too");
      assert.equal(sanitizeComment("'Single quoted, don't break it'"), "Single quoted, don't break it");
      assert.equal(sanitizeComment("«Guillemets»"), "Guillemets");
      assert.equal(sanitizeComment("`code-ish`"), "code-ish");
      assert.equal(sanitizeComment('  "padded"  '), "padded");
    });
    test("keeps quotes that belong to the text", () => {
      assert.equal(sanitizeComment('He said "no" twice'), 'He said "no" twice');
      assert.equal(sanitizeComment('"Ship it" beats "perfect it" every time'), '"Ship it" beats "perfect it" every time');
      assert.equal(sanitizeComment('"Ship it" beats "perfect it"'), '"Ship it" beats "perfect it"');
    });
    test('removes "Reply:" style labels', () => {
      assert.equal(sanitizeComment("Reply: The real cost is latency, not fees."), "The real cost is latency, not fees.");
      assert.equal(sanitizeComment("comment - latency is the real cost"), "latency is the real cost");
      assert.equal(sanitizeComment("Response:latency"), "latency");
      assert.equal(sanitizeComment("Answer : yes, but only on L2"), "yes, but only on L2");
    });
    test("removes leading @mentions only", () => {
      assert.equal(sanitizeComment("@vitalik @balajis the bottleneck is UX"), "the bottleneck is UX");
      assert.equal(sanitizeComment("@vitalik, the bottleneck is UX"), "the bottleneck is UX");
      assert.equal(sanitizeComment("@vitalik: the bottleneck is UX"), "the bottleneck is UX");
      assert.equal(sanitizeComment("the bottleneck is @vitalik's UX"), "the bottleneck is @vitalik's UX");
    });
    test("em dash -> period before a capital, comma otherwise; spaced en dash -> comma", () => {
      assert.equal(sanitizeComment("Fees dropped — Users never noticed"), "Fees dropped. Users never noticed");
      assert.equal(sanitizeComment("Fees dropped — but nobody noticed"), "Fees dropped, but nobody noticed");
      assert.equal(sanitizeComment("Fees dropped—but nobody noticed"), "Fees dropped, but nobody noticed");
      assert.equal(sanitizeComment("Fees dropped ― but nobody noticed"), "Fees dropped, but nobody noticed");
      assert.equal(sanitizeComment("Fees dropped – but nobody noticed"), "Fees dropped, but nobody noticed");
      assert.equal(sanitizeComment("The 2020–2024 range"), "The 2020–2024 range");
      assert.ok(!/[—―]/.test(sanitizeComment("a — b — C — d")));
    });
    test("removes a trailing hashtag block, keeps inline ones", () => {
      // Only after a finished sentence: "the real test is #Base" must not become "the real test is" (GEN-1);
      // without a full stop the tag stays and the hashtag rule regenerates the reply.
      assert.equal(sanitizeComment("Solid angle on fees. #defi #eth"), "Solid angle on fees.");
      assert.equal(sanitizeComment("Solid angle on fees! #defi  "), "Solid angle on fees!");
      assert.equal(sanitizeComment("Solid angle on fees #defi  "), "Solid angle on fees #defi");
      assert.equal(sanitizeComment("#defi summer is back for real"), "#defi summer is back for real");
    });
    test("whitespace and nullish", () => {
      assert.equal(sanitizeComment("too   many\tspaces"), "too many spaces");
      assert.equal(sanitizeComment("a\r\n\n\n\nb"), "a\n\nb");
      assert.equal(sanitizeComment(null), "");
      assert.equal(sanitizeComment(undefined), "");
      assert.equal(sanitizeComment(""), "");
    });
  });

  describe("ruleCheck", () => {
    test("a good comment passes", () => {
      const r = ruleCheck(GOOD, { settings, postText: "Ethereum fees dropped 90% after the blob upgrade and nobody noticed.", previous: [] });
      assert.equal(r.pass, true, JSON.stringify(r.reasons));
      assert.deepEqual(r.reasons, []);
      assert.equal(r.similarity, null);
    });
    test("empty and model skip", () => {
      assert.deepEqual(codes(""), ["empty"]);
      assert.deepEqual(codes("   "), ["empty"]);
      assert.deepEqual(codes(null), ["empty"]);
      assert.deepEqual(codes("SKIP"), ["model_skip"]);
    });
    test("too_short / too_long use settings and the HARD cap", () => {
      assert.ok(codes("Nice angle").includes("too_short"));
      const long = "Fee markets reward patience more than speed in most cycles. ".repeat(4);
      assert.ok(long.trim().length > 220);
      assert.ok(codes(long).includes("too_long"));
      assert.ok(!ruleCheck(long, { settings: { quality: { maxChars: 280 } } }).reasons.some((r) => r.code === "too_long"));
      const huge = "x".repeat(300) + " fee markets";
      assert.ok(ruleCheck(huge, { settings: { quality: { maxChars: 1000 } } }).reasons.some((r) => r.code === "too_long"));
      assert.ok(ruleCheck("Fees are fine", { settings: { quality: { minChars: 20 } } }).reasons.some((r) => r.code === "too_short"));
    });
    test("links incl. bare domains", () => {
      assert.ok(codes("Read the breakdown at https://example.com/fees today").includes("link"));
      assert.ok(codes("Read the breakdown at www.example.org for details").includes("link"));
      assert.ok(codes("The docs on site.io explain the fee model well").includes("link"));
      assert.ok(codes("Check uniswap.org/v4 before you decide anything").includes("link"));
      assert.ok(!codes(GOOD).includes("link"));
      assert.ok(!codes("Fees fell. So what changes for wallets next quarter?").includes("link"));
    });
    test("hashtag / mention / emoji / em dash", () => {
      assert.ok(codes("Fees will keep falling as blobs scale #ethereum").includes("hashtag"));
      assert.ok(codes("Fees will keep falling, ask @vitalik about blobs").includes("mention"));
      assert.ok(!codes("Email me at hello@example").includes("mention"));
      assert.ok(codes("Fees will keep falling as blobs scale 🔥🔥").includes("emoji"));
      assert.ok(!codes("Fees will keep falling as blobs scale 🔥").includes("emoji"));
      assert.ok(!codes("Fees will keep falling as rollups scale 👍🏽").includes("emoji"));
      assert.ok(codes("Fees will keep falling — blobs scale").includes("em_dash"));
      assert.ok(codes("Fees will keep falling ― blobs scale").includes("em_dash"));
    });
    test("ai_mention flags self-references but not the topic of AI", () => {
      assert.ok(codes("As an AI, I think fees will fall further this year").includes("ai_mention"));
      assert.ok(codes("I am an AI but this fee chart looks wrong to me").includes("ai_mention"));
      assert.ok(codes("This reply was AI-generated, sorry about the tone").includes("ai_mention"));
      const topical = ruleCheck("AI agents will replace junior analysts faster than most firms expect", { settings, postText: "AI agents are coming for entry level finance jobs, and banks know it.", previous: ["Fees matter less than UX for most retail users"] });
      assert.equal(topical.pass, true, JSON.stringify(topical.reasons));
      assert.equal(ruleCheck("Training data quality matters more than parameter count for AI models", { settings }).pass, true);
    });
    test("generic replies", () => {
      for (const t of ["Great post!", "So true", "100%", "Couldn't agree more!", "Love this", "Well said.", "This is huge", "LFG", "gm", "Facts!!!", "this 👆"]) {
        assert.ok(codes(t).includes("generic"), t);
      }
      assert.ok(codes("Great post fam").includes("generic")); // <= 3 words starting with a generic phrase
      assert.ok(codes("Wow really").includes("generic"));
    });
    test("short replies that merely share letters with a generic phrase are not generic", () => {
      for (const t of ["Freight costs dominate", "Realtime settlement matters", "Factoring changes everything", "Gmx fees look cheaper", "Awesomeness is subjective, data is not"]) {
        assert.ok(!codes(t).includes("generic"), t);
      }
    });
    test("generic opener", () => {
      const c = codes("Great point, but fees on L2 still matter for small traders");
      assert.ok(c.includes("generic_opener"));
      assert.ok(!c.includes("generic"));
      assert.ok(codes("As someone who builds wallets, fee display is the hard part").includes("generic_opener"));
      assert.ok(codes("Totally agree, the hard part is fee display in wallets").includes("generic_opener"));
      assert.ok(!codes("Greatness is overrated when fee display in wallets is this bad").includes("generic_opener"));
    });
    test("echo of the post", () => {
      const postText = "Ethereum fees dropped ninety percent after the blob upgrade this week";
      assert.ok(codes("Ethereum fees dropped ninety percent after the blob upgrade", { postText }).includes("echo"));
      assert.ok(!codes(GOOD, { postText }).includes("echo"));
    });
    test("language / script mismatch", () => {
      const bn = "ইথেরিয়ামের ফি গত সপ্তাহে অনেক কমে গেছে, কিন্তু কেউ খেয়াল করেনি";
      const ar = "انخفضت رسوم الإيثريوم كثيرا هذا الأسبوع ولم يلاحظ أحد";
      const en = "Most users never notice fee drops until a wallet shows them";
      assert.ok(codes(en, { postText: bn }).includes("language"));
      assert.ok(codes(en, { postText: ar }).includes("language"));
      assert.ok(!codes(en, { postText: "Fees dropped a lot this week and nobody noticed" }).includes("language"));
      assert.ok(!codes("ফি কমলেও ওয়ালেটে না দেখালে কেউ বুঝবে না", { postText: bn }).includes("language"));
      // too little text in the post to know the script -> no language reason
      assert.ok(!codes(en, { postText: "gm 🌞" }).includes("language"));
    });
    test("repeat / repeat_phrase / repeat_opener against previous comments", () => {
      const repeat = codes("Most users never notice fee drops until a wallet shows them clearly", { previous: ["Most users never notice fee drops until a wallet shows them"] });
      assert.ok(repeat.includes("repeat"));
      const phrase = codes("Fees matter less, the real bottleneck is wallet UX here", { previous: ["I think the real bottleneck is wallet UX for most people"] });
      assert.deepEqual(phrase, ["repeat_phrase"]);
      const op = codes("Most people miss that blobs only help rollups that post data", { previous: ["Most people miss how much fees matter for retail"] });
      assert.deepEqual(op, ["repeat_opener"]);
      // opener only checked against the 15 most recent comments
      const old = Array.from({ length: 15 }, (_, i) => `Unrelated filler comment number ${i} about staking yields`);
      old.push("Most people miss how much fees matter for retail");
      assert.deepEqual(codes("Most people miss that blobs only help rollups that post data", { previous: old }), []);
      // threshold comes from settings
      const loose = ruleCheck("Most users never notice fee drops until a wallet shows them clearly", { settings: { quality: { similarityThreshold: 0.95 } }, previous: ["Most users never notice fee drops until a wallet shows them"] });
      assert.ok(!loose.reasons.some((r) => r.code === "repeat"));
      assert.ok(loose.reasons.some((r) => r.code === "repeat_phrase"));
    });
    test("reasons carry human text and multiple codes", () => {
      const r = ruleCheck("Great post! #eth https://x.co/a 🔥🔥", { settings });
      assert.equal(r.pass, false);
      const c = r.reasons.map((x) => x.code);
      for (const k of ["link", "hashtag", "emoji"]) assert.ok(c.includes(k), k);
      assert.ok(r.reasons.every((x) => typeof x.text === "string" && x.text.length > 0));
    });
  });

  describe("similarity / scriptOf / feedbackFor", () => {
    test("similarity returns max, text, shared 5-gram and same opener", () => {
      const prev = ["Totally different words about staking", "I think the real bottleneck is wallet UX for most people"];
      const s = similarity("Fees matter less, the real bottleneck is wallet UX here", prev);
      assert.ok(s.max > 0.2 && s.max < 0.45, String(s.max));
      assert.equal(s.maxText, prev[1]);
      assert.equal(s.sharedPhrase, "the real bottleneck is wallet");
      assert.equal(s.sameOpener, "");
      const same = similarity("abc def ghi jkl", ["abc def ghi jkl"]);
      assert.equal(same.max, 1);
      assert.equal(same.sameOpener, "abc def ghi");
      assert.deepEqual(similarity("anything here", []), { max: 0, maxText: "", sharedPhrase: "", sameOpener: "" });
      assert.deepEqual(similarity("anything here", undefined).max, 0);
    });
    test("scriptOf", () => {
      assert.equal(scriptOf("Hello world from Dhaka"), "latin");
      assert.equal(scriptOf("ইথেরিয়ামের ফি অনেক কমেছে"), "bengali");
      assert.equal(scriptOf("انخفضت رسوم الإيثريوم كثيرا"), "arabic");
      assert.equal(scriptOf("Привет как дела у тебя"), "cyrillic");
      assert.equal(scriptOf("今天天气很好我们去公园散步"), "han");
      assert.equal(scriptOf("東京都内経済政策会議開催です"), "hiragana");
      assert.equal(scriptOf("हिंदी में लिखा गया वाक्य"), "devanagari");
      assert.equal(scriptOf("hi"), "");
      assert.equal(scriptOf("@verylonghandle https://t.co/abcdefgh #hashtagword ok"), "");
      assert.equal(scriptOf(""), "");
      assert.equal(scriptOf(null), "");
    });
    test("feedbackFor", () => {
      const f = feedbackFor([{ code: "generic", text: "Generic reply" }], { sameOpener: "most people miss", sharedPhrase: "the real bottleneck is wallet" });
      assert.equal(f, '- Generic reply\n- Do not start with "most people miss".\n- Do not use the phrase "the real bottleneck is wallet".');
      assert.equal(feedbackFor([], null), "");
      assert.equal(feedbackFor(undefined, undefined), "");
    });
    test("generic phrase list is lowercase", () => {
      for (const g of GENERIC_PHRASES) assert.equal(g, g.toLowerCase());
    });
  });
});
