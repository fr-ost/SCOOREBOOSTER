// ScoreX UI smoke test: loads the unpacked extension in headless Chromium, seeds fake data, opens every
// dashboard tab + the popup in light and dark mode, fails on any page error or console error, and
// exercises the top bar (tab strip, status, primary engine button), the setup checklist, the always-usable
// Review/Full auto switch, collapsed Advanced sections (remembered per tab), settings persistence/clamping,
// masked API keys, the cost estimator, the theme switch and the narrow layout.
//
// Run: node tests/e2e/ui_smoke.mjs     Screenshots: tests/e2e/out/
import { createRequire } from "module";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const EXT = "/home/user/SCOOREBOOSTER/extension";
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), "out");
const TABS = ["overview", "review", "targets", "models", "tones", "safety", "history", "settings"];
const TAB_TITLES = ["Dashboard", "Review Queue", "Targets", "Models & Costs", "Tone & Prompts", "Safety", "History", "Settings"];
const FAKE_KEY = "sk-test-UIsmoke1234567890abcdWXYZ";

fs.mkdirSync(OUT, { recursive: true });

const errors = [];
let passed = 0, failed = 0;
function check(cond, msg) {
  if (cond) { passed++; console.log("  ok   " + msg); }
  else { failed++; console.log("  FAIL " + msg); }
}
function watch(page, label) {
  page.on("pageerror", (e) => errors.push(`[${label}] pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`[${label}] console.error: ${m.text()}`); });
}

// ------------------------------------------------------------------ seed (runs inside an extension page)
async function seed() {
  const hist = await import(chrome.runtime.getURL("lib/history.js"));
  const util = await import(chrome.runtime.getURL("lib/util.js"));
  const now = Date.now(), MIN = 60e3, HR = 36e5, DAY = 864e5;
  const tz = "Asia/Dhaka";
  const T = (handle, o) => ({
    handle, name: o.name, group: o.group, tier: o.tier, enabled: o.enabled !== false, tone: o.tone || "", preset: o.preset || "", notes: "", source: "manual",
    addedAt: now - 20 * DAY,
    profile: { handle, name: o.name, bio: o.bio, followers: o.followers, following: o.following || 800, verified: !!o.verified, updatedAt: now - DAY },
    recentPosts: [], lastPostAt: now - 2 * HR, lastCheckedAt: now - HR,
    rel: { followsYou: o.followsYou, youFollow: true, checkedAt: now - DAY },
    score: { own: o.own, sorsa: o.sorsa == null ? null : o.sorsa, combined: o.own, flags: [], bot: false, updatedAt: now - DAY },
    priority: o.priority || 50, coldUntil: o.coldUntil || null,
    stats: { comments: o.comments || 0, lastCommentAt: o.comments ? now - o.lastAgo : null, engaged: 1, noResponseStreak: 0, likes: 3, replies: 1, authorReplies: 0, lastEngagedAt: null },
  });
  const targets = {};
  for (const t of [
    T("naval", { name: "Naval", group: "B", tier: 1, followers: 2900000, own: 91, sorsa: 2410, followsYou: false, verified: true, bio: "Angel investor. Wealth, happiness and the future of technology.", priority: 85, comments: 4, lastAgo: 2 * DAY }),
    T("balajis", { name: "Balaji", group: "B", tier: 1, followers: 1100000, own: 88, sorsa: 1980, followsYou: false, verified: true, bio: "Network state. Formerly CTO Coinbase, GP a16z.", priority: 80, comments: 2, lastAgo: 5 * DAY, tone: "expert" }),
    T("dwarkesh_sp", { name: "Dwarkesh Patel", group: "B", tier: 2, followers: 210000, own: 79, followsYou: null, bio: "Host of the Dwarkesh Podcast.", priority: 60 }),
    T("karpathy", { name: "Andrej Karpathy", group: "B", tier: 1, followers: 1300000, own: 93, sorsa: 2650, followsYou: false, verified: true, bio: "Building @EurekaLabsAI. Previously Director of AI @ Tesla.", priority: 90, comments: 1, lastAgo: 9 * HR, preset: "high" }),
    T("onchain_anna", { name: "Anna | onchain", group: "A", tier: 2, followers: 18400, own: 64, followsYou: true, bio: "Onchain analyst. Charts, flows, no shilling.", priority: 55, comments: 7, lastAgo: 26 * HR }),
    T("devrel_sam", { name: "Sam builds", group: "A", tier: 2, followers: 9200, own: 58, followsYou: true, bio: "DevRel. Shipping small tools every week.", priority: 45, comments: 3, lastAgo: 3 * DAY, coldUntil: now + 6 * DAY }),
    T("macro_mira", { name: "Mira Macro", group: "A", tier: 1, followers: 86000, own: 76, sorsa: 640, followsYou: true, bio: "Macro, rates and liquidity. Ex-sell side.", priority: 70, comments: 5, lastAgo: 40 * HR }),
    T("quiet_quant", { name: "Quiet Quant", group: "B", tier: 2, followers: 4300, own: 41, followsYou: false, bio: "Systematic trading notes.", enabled: false }),
  ]) targets[t.handle] = t;

  const call = (modelId, modelName, effort, input, output, reasoning, cost, kind = "gen") => ({ kind, modelId, modelName, effort, usage: { input, cached: Math.round(input * 0.3), cacheWrite: 0, output, reasoning }, cost, ms: 2300, ok: true });
  const base = (o) => ({
    created: o.created,
    target: o.target, targetName: targets[o.target].name, group: targets[o.target].group, tier: targets[o.target].tier,
    postId: String(1850000000000000000 + Math.floor(Math.random() * 1e9)), postUrl: `https://x.com/${o.target}/status/18500000000${Math.floor(Math.random() * 1e6)}`,
    postText: o.postText, postLang: "en", postCreatedAt: o.created - 4 * MIN, postMetrics: { likes: 420, replies: 37, reposts: 51, views: 61000 },
    tone: o.tone || "insightful", preset: o.preset || "balanced", modelId: o.modelId || "m_balanced", modelName: o.modelName || "gpt-6.1-terra", effort: o.effort || "medium",
    comment: o.comment, originalComment: o.comment, attempts: 1, quality: { pass: true, reasons: o.reasons || [], modelVerdict: o.verdict || null },
    calls: o.calls || [call("m_balanced", "gpt-6.1-terra", "medium", 1420, 380, 290, 0.00327), call("m_cheap", "gpt-6-luna", "low", 680, 140, 90, 0.00014, "check")],
    status: o.status, reason: o.reason || "", mode: "review", scheduledFor: o.scheduledFor || null,
    postedAt: o.status === "posted" ? o.created + 20 * MIN : null, liked: !!o.liked, results: o.results || {},
  });
  const recs = [
    base({ target: "naval", created: now - 3 * MIN, status: "pending_review", postText: "The best founders I know read history, not business books. Patterns repeat; tactics don't.", comment: "History gives you the base rates. Most business books are survivorship stories written after the fact, which is why the patterns transfer and the tactics never do." }),
    base({ target: "karpathy", created: now - 8 * MIN, status: "pending_review", tone: "expert", preset: "high", modelId: "m_best", modelName: "gpt-6.1-sol", effort: "high", calls: [call("m_best", "gpt-6.1-sol", "high", 1600, 2900, 2780, 0.0322)], postText: "Tokenization is still the source of a surprising number of LLM weirdness bugs. Spelling, arithmetic, trailing spaces...", comment: "The trailing-space one bit us in eval harnesses: same prompt, one extra space, 4 point accuracy swing. Byte-level fallbacks help, but the vocab still leaks into behaviour.", reasons: ["Opening is similar to a recent comment (0.38)"] }),
    base({ target: "onchain_anna", created: now - 15 * MIN, status: "pending_review", tone: "friendly", preset: "cheap", modelId: "m_cheap", modelName: "gpt-6-luna", effort: "low", postText: "Stablecoin supply on L2s just crossed $20B. Flows are rotating out of mainnet faster than I expected.", comment: "Wild that the rotation sped up right after fees dropped. Curious if you're seeing it in active addresses too or mostly whales moving size?", verdict: { pass: true, issue: "" } }),
    base({ target: "macro_mira", created: now - 40 * MIN, status: "approved", scheduledFor: now + 12 * MIN, postText: "Term premium is back near decade highs and nobody on the timeline is talking about it.", comment: "And it's happening with cuts priced in, which is the part that should worry people. The long end is pricing supply, not the Fed." }),
    base({ target: "balajis", created: now - 55 * MIN, status: "queued", scheduledFor: now + 31 * MIN, tone: "expert", postText: "Every country will eventually have a digital-first citizenship option.", comment: "Estonia's e-residency is the closest live test: 100k+ signups, but the real unlock was company formation, not identity." }),
    base({ target: "naval", created: now - 1 * DAY, status: "posted", liked: true, postText: "Earn with your mind, not your time.", comment: "The hard part is that the first years of mind-leverage look exactly like working for free.", results: { likes: 18, replies: 3, authorReplied: true, followedBack: false, checkedAt: now - 2 * HR } }),
    base({ target: "onchain_anna", created: now - 1 * DAY - 3 * HR, status: "posted", tone: "friendly", postText: "New dashboard for L2 bridge flows is live.", comment: "The per-bridge latency column is a great touch, first time I've seen it broken out like that.", results: { likes: 4, replies: 1, authorReplied: true, checkedAt: now - 5 * HR } }),
    base({ target: "karpathy", created: now - 2 * DAY, status: "posted", tone: "witty", preset: "high", modelId: "m_best", modelName: "gpt-6.1-sol", effort: "high", calls: [call("m_best", "gpt-6.1-sol", "high", 1580, 2600, 2500, 0.0291)], postText: "Vibe coding is great until the vibes run out.", comment: "Then you discover the codebase was the vibes all along.", results: { likes: 96, replies: 11, authorReplied: false, followedBack: true, checkedAt: now - DAY } }),
    base({ target: "macro_mira", created: now - 3 * DAY, status: "posted", postText: "Liquidity is the only chart that matters this year.", comment: "Except the one that shows where that liquidity is parked: RRP drained, so the next leg has to come from reserves.", results: { likes: 7, replies: 0, checkedAt: now - 2 * DAY } }),
    base({ target: "devrel_sam", created: now - 4 * DAY, status: "posted", tone: "friendly", preset: "cheap", modelId: "m_cheap", modelName: "gpt-6-luna", effort: "low", postText: "Shipped a tiny CLI for diffing JSON schemas.", comment: "Does it handle $ref across files? That's where every schema diff tool I've tried falls apart.", results: { likes: 2, replies: 1, authorReplied: true, followedBack: false, checkedAt: now - 3 * DAY } }),
    base({ target: "balajis", created: now - 9 * DAY, status: "posted", tone: "bold", postText: "Media is just code that runs on human brains.", comment: "Which makes the feed algorithm the compiler, and nobody reviews its diffs.", results: { likes: 31, replies: 4, followedBack: false, checkedAt: now - 8 * DAY } }),
    base({ target: "dwarkesh_sp", created: now - 5 * HR, status: "skipped", reason: "Post is political/controversial (keyword: election)", postText: "Interview about the election forecasting models.", comment: "" }),
    base({ target: "naval", created: now - 2 * DAY - 4 * HR, status: "skipped", reason: "Expired: not reviewed within 180 min", postText: "Desire is a contract you make with yourself to be unhappy until you get what you want.", comment: "The fix isn't fewer desires, it's picking one at a time." }),
    base({ target: "karpathy", created: now - 6 * HR, status: "failed", reason: "Reply box did not open (selector replyButton)", postText: "New lecture: building a tokenizer from scratch.", comment: "The section on merges finally made BPE click for me." }),
  ];
  for (const r of recs) {
    const rec = hist.newRecord(r);
    rec.createdAt = r.created || rec.createdAt;
    delete rec.created;
    await hist.put(rec);
  }
  const today = util.dayKey(now, tz), month = util.monthKey(now, tz);
  const days = {};
  for (let i = 0; i < 10; i++) days[util.dayKey(now - i * DAY, tz)] = Math.round((0.02 + 0.03 * Math.sin(i)) * 1e4) / 1e4 + 0.03;
  days[today] = 0.0412;
  const logs = [
    { ts: now - 40 * MIN, level: "info", msg: "Engine started (review mode)" },
    { ts: now - 35 * MIN, level: "info", msg: "Checked X List: 42 posts, 3 fresh from targets" },
    { ts: now - 34 * MIN, level: "debug", msg: "Gate: waiting between comments", data: "{\"until\":\"14:05\"}" },
    { ts: now - 28 * MIN, level: "warn", msg: "Quality check rejected a comment (generic opener) - regenerating" },
    { ts: now - 15 * MIN, level: "info", msg: "Generated comment for @onchain_anna ($0.0006)" },
    { ts: now - 8 * MIN, level: "info", msg: "Generated comment for @karpathy ($0.0322)" },
    { ts: now - 6 * MIN, level: "error", msg: "Reply box did not open on x.com/karpathy/status/1850... (retry later)" },
    { ts: now - 3 * MIN, level: "info", msg: "Generated comment for @naval ($0.0034)" },
  ];
  const cands = {
    vitalikbuterin: { handle: "vitalikbuterin", name: "vitalik.eth", followers: 5800000, score: { own: 95, flags: [] }, overlap: 3, sources: ["common:naval", "common:balajis", "common:karpathy"], suggestedTier: 1, suggestedGroup: "B", pass: false, why: ["followers above range"] },
    sarah_ml: { handle: "sarah_ml", name: "Sarah | ML eng", followers: 23100, score: { own: 72, flags: [] }, overlap: 2, sources: ["followers:karpathy"], suggestedTier: 2, suggestedGroup: "B", pass: true, why: [] },
    gm_bot_99: { handle: "gm_bot_99", name: "GM GM", followers: 310, score: { own: 9, flags: ["gm_spam", "default_avatar"], bot: true }, overlap: 1, sources: ["followers:naval"], suggestedTier: 2, suggestedGroup: "B", pass: false, why: ["followers below range", "looks like a bot/spam"] },
    rates_rick: { handle: "rates_rick", name: "Rick on Rates", followers: 64200, score: { own: 77, flags: [] }, overlap: 2, sources: ["following:macro_mira"], suggestedTier: 1, suggestedGroup: "A", followsYou: true, pass: true, why: [] },
  };
  await chrome.storage.local.set({
    "sx.targets": targets,
    "sx.logs": logs,
    "sx.candidates": cands,
    "sx.discovery": { status: "running", source: "followersOf", step: "Reading followers of @karpathy", progress: { done: 0, total: 1 }, found: 0, message: "followers of @karpathy: 64 accounts", startedAt: now - 4 * MIN, finishedAt: null, updatedAt: now },
    "sx.spend": { days, months: { [month]: 0.6342 }, byModelMonth: {} },
    "sx.state": {
      // "paused" keeps the real engine idle during the test (a running state would let its watchdog tick).
      status: "paused", stopReason: null, stopDetail: "", firstStartedAt: now - DAY - 2 * HR, startedAt: now - 40 * MIN,
      lastTickAt: now - 50 * 1000, nextTickAt: now + 3 * MIN, nextCommentAt: now + 6 * MIN, lastCommentAt: now - 20 * MIN, alert: null,
    },
  });
  return { records: recs.length, targets: Object.keys(targets).length };
}

// ------------------------------------------------------------------ helpers
async function openTab(page, base, tab) {
  await page.goto(`${base}dashboard.html#${tab}`);
  await page.waitForSelector(`#view[data-ready="${tab}"]`, { timeout: 15000 });
  await page.waitForTimeout(350);
}
async function shot(page, file, fullPage = true) {
  await page.evaluate(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); window.scrollTo(0, 0); });
  await page.waitForTimeout(80);
  await page.screenshot({ path: path.join(OUT, file), fullPage });
}
async function setTheme(page, t) {
  await page.evaluate((v) => window.sxTheme.set(v), t);
  await page.waitForTimeout(120);
}
async function savedSettings(page) {
  return page.evaluate(async () => (await chrome.storage.local.get("sx.settings"))["sx.settings"]);
}
async function waitSaved(page) {
  await page.waitForFunction(() => { const el = document.getElementById("saveInd"); return el && /Saved/.test(el.textContent); }, null, { timeout: 5000 });
}

// ------------------------------------------------------------------ main
const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "scorex-ui-"));
const ctx = await chromium.launchPersistentContext(userDir, {
  channel: "chromium",
  headless: true,
  viewport: { width: 1360, height: 900 },
  args: ["--disable-extensions-except=" + EXT, "--load-extension=" + EXT],
});

try {
  const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker", { timeout: 20000 }));
  const extId = new URL(sw.url()).host;
  const base = `chrome-extension://${extId}/ui/`;
  console.log("extension id:", extId);

  const page = await ctx.newPage();
  watch(page, "dashboard");
  await openTab(page, base, "overview");

  console.log("seed");
  const seeded = await page.evaluate(seed);
  check(seeded.records === 14 && seeded.targets === 8, `seeded ${seeded.records} history records and ${seeded.targets} targets`);
  await page.reload();
  await page.waitForSelector('#view[data-ready="overview"]');

  console.log("tabs (light + dark)");
  for (const theme of ["light", "dark"]) {
    await setTheme(page, theme);
    for (const tab of TABS) {
      await openTab(page, base, tab);
      const dt = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
      const failedRender = await page.locator("#view >> text=This tab failed to render").count();
      check(dt === theme && failedRender === 0, `${tab} renders in ${theme}`);
      await shot(page, `${theme}-${tab}.png`);
    }
  }
  await setTheme(page, "light");

  console.log("content");
  await openTab(page, base, "overview");
  const titles = await page.locator("#nav .tab .tab-label").allInnerTexts();
  check(JSON.stringify(titles) === JSON.stringify(TAB_TITLES), "top tab strip lists the 8 tabs in order: " + titles.join(", "));
  check((await page.locator(".sidebar, #sidebar").count()) === 0, "no sidebar");
  check((await page.locator('#nav .tab.active[aria-current="page"]').innerText()).trim() === "Dashboard", "active tab is marked with aria-current");
  await page.waitForFunction(() => document.querySelector('#nav [data-tab="review"] .tab-count')?.textContent === "3", null, { timeout: 8000 });
  check(true, "Review Queue tab shows a count of 3");
  check(/Paused/.test(await page.locator("#heroStatus").innerText()) && (await page.locator("#engineBox .status-paused").count()) === 1, "dashboard + top bar show Paused (amber)");
  check((await page.locator("#engineBox .btn-primary").count()) === 1 && (await page.locator("#btn-resume.btn-primary").count()) === 1, "one primary engine button: Resume while paused");
  check((await page.locator("#btn-stop").count()) === 1 && !(await page.locator("#btn-stop").isDisabled()), "small Stop button is enabled while paused");
  check(!/warm-?up|unlocks in|first 3 days/i.test(await page.locator("body").innerText()), "no warm-up text on the dashboard");
  check(!(await page.locator('#modeSwitch [data-value="auto"]').isDisabled()), "Full auto is selectable right away");
  await page.click('#modeSwitch [data-value="auto"]');
  await waitSaved(page);
  check((await savedSettings(page)).mode === "auto" && (await page.locator('#modeSwitch [data-value="auto"]').getAttribute("aria-checked")) === "true", "Full auto click saves settings.mode = auto");
  await page.click('#modeSwitch [data-value="review"]');
  await waitSaved(page);
  check((await savedSettings(page)).mode === "review", "switching back to Review saves settings.mode = review");
  check(await page.locator("#setupChecklist").isVisible(), "setup checklist is shown while setup is incomplete");
  const stepDone = async (k) => (await page.locator(`#setupChecklist [data-step="${k}"]`).getAttribute("class")).includes("is-done");
  check(!(await stepDone("key")) && !(await stepDone("handle")) && (await stepDone("targets")) && !(await stepDone("examples")) && (await stepDone("start")), "checklist: targets + start done; key, handle, examples open");
  check((await page.locator("#setupChecklist .checklist-count").innerText()).trim() === "2 / 5", "checklist counts 2 / 5");
  await page.click('#setupChecklist [data-step="handle"] button:has-text("Confirm")');
  await page.waitForFunction(() => document.querySelector('#setupChecklist [data-step="handle"]')?.classList.contains("is-done"), null, { timeout: 5000 });
  check(true, "confirming the X handle ticks checklist step 2");
  check((await page.locator("#pendingCount").innerText()).trim() === "3", "waiting-for-review count is 3");
  check((await page.locator("#reviewPreview .pv").count()) === 3, "review preview lists 3 pending comments");
  check((await page.locator("#activityLog .log").count()) === 8, "recent activity lists 8 log lines");
  check(await page.locator("#runNowBtn").isDisabled(), "Run a check now is disabled while the engine is not running");

  await openTab(page, base, "targets");
  check((await page.locator("#targetsTable tbody tr").count()) === 8, "targets table has 8 rows");
  check((await page.locator("#candidatesTable tbody tr").count()) === 4, "candidates table has 4 rows");
  check(/followers of @karpathy: 64 accounts/.test(await page.locator("#discProgress").textContent()), "discovery progress shown from sx.discovery");
  const disc = page.locator('details[data-adv="targets.discovery"]');
  check(!(await disc.evaluate((d) => d.open)) && /4 candidates waiting/.test(await disc.locator("summary").innerText()), "Discovery is collapsed and its summary shows 4 candidates waiting");
  check((await page.locator("#addHandles").boundingBox()).y < (await page.locator("#targetsTable").boundingBox()).y, "Add targets sits above the table");
  await page.fill("#targetSearch", "naval");
  await page.waitForTimeout(400);
  check((await page.locator("#targetsTable tbody tr").count()) === 1, "target search filters the table");
  await page.fill("#targetSearch", "");
  await page.click("#addTargetsBtn");
  await page.waitForSelector(".toast-warn", { timeout: 3000 });
  check(true, "empty Add shows a warning toast");
  await page.fill("#addHandles", "@new_target_x\nhttps://x.com/another_one");
  await page.click("#addTargetsBtn");
  await page.waitForFunction(() => document.querySelectorAll("#targetsTable tbody tr").length === 10, null, { timeout: 8000 });
  check(true, "targetsUpsert through the worker adds 2 targets and the table live-updates (10 rows)");

  await openTab(page, base, "review");
  check((await page.locator("#pendingList .review-card").count()) === 3, "review queue shows 3 pending cards");
  check((await page.locator("#waitingList .review-card").count()) === 2, "approved/queued section shows 2 cards");
  const ta = page.locator("#pendingList .review-card textarea").first();
  await ta.fill("Short edit.");
  check(/^11 \/ 280$/.test((await page.locator("#pendingList .review-card .char-count").first().innerText()).trim()), "live character count updates");
  await page.locator("#pendingList .review-card").first().locator("button:has-text('Approve')").click();
  await page.waitForFunction(() => document.querySelectorAll("#pendingList .review-card").length === 2 && document.querySelectorAll("#waitingList .review-card").length === 3, null, { timeout: 8000 });
  check(true, "Approve (reviewAction) moves the card to the waiting section");
  check((await page.locator("#waitingList .comment-input").evaluateAll((els) => els.map((e) => e.value))).includes("Short edit."), "approved card keeps the edited text");

  await openTab(page, base, "history");
  check((await page.locator("#historyCount").innerText()).trim() === "14", "history shows 14 records");
  await page.selectOption("#hStatus", "posted");
  await page.waitForFunction(() => document.getElementById("historyCount")?.textContent === "6", null, { timeout: 5000 });
  check(true, "history status filter (posted = 6)");

  console.log("settings persist + clamp");
  await openTab(page, base, "safety");
  await page.getByLabel("Gap between comments maximum").fill("45");
  await page.getByLabel("Gap between comments maximum").press("Tab");
  await waitSaved(page);
  await page.getByLabel("Week 1", { exact: true }).fill("99");
  await page.getByLabel("Week 1", { exact: true }).press("Tab");
  await waitSaved(page);
  check((await page.getByLabel("Week 1", { exact: true }).inputValue()) === "30", "ramp 99 is clamped to 30 right away");
  await page.reload();
  await page.waitForSelector('#view[data-ready="safety"]');
  check((await page.getByLabel("Gap between comments maximum").inputValue()) === "45", "gap max 45 persisted after reload");
  check((await page.getByLabel("Week 1", { exact: true }).inputValue()) === "30", "ramp week 1 persisted as 30 after reload");
  const st = await savedSettings(page);
  check(st && st.safety.ramp[0] === 30 && st.safety.gapMin.max === 45, "chrome.storage has ramp[0]=30 and gapMin.max=45");
  await page.getByLabel("Gap between comments minimum").fill("1");
  await page.getByLabel("Gap between comments minimum").press("Tab");
  await waitSaved(page);
  check((await page.getByLabel("Gap between comments minimum").inputValue()) === "2", "gap min 1 is clamped to the hard minimum 2");

  console.log("API key masking");
  await openTab(page, base, "models");
  await page.fill("#openaiKeyField input[type=password]", FAKE_KEY);
  await page.click("#openaiKeyField button:has-text('Save')");
  await page.waitForSelector("#openaiKeyField .masked-key", { timeout: 5000 });
  check((await page.locator("#openaiKeyField .masked-key").innerText()).trim() === "sk-…WXYZ", "key shown masked as sk-…WXYZ");
  check(!(await page.content()).includes(FAKE_KEY), "full key is not in the page DOM");
  check((await page.locator("#openaiKeyField button:has-text('Replace')").count()) === 1 && (await page.locator("#openaiKeyField button:has-text('Remove')").count()) === 1, "Replace and Remove buttons shown");
  const sec = await page.evaluate(async () => (await import("/lib/store.js")).getSecrets());
  check(sec && sec.openaiKey === FAKE_KEY, "key stored (extension IndexedDB)");
  const leaked = await page.evaluate(async () => JSON.stringify(await chrome.storage.local.get(null)));
  check(!leaked.includes(FAKE_KEY), "key is not in chrome.storage (content scripts on x.com cannot read it)");
  await page.reload();
  await page.waitForSelector('#view[data-ready="models"]');
  await page.waitForSelector("#openaiKeyField .masked-key", { timeout: 5000 });
  check(!(await page.content()).includes(FAKE_KEY), "still masked after reload");

  console.log("cost estimator");
  const before = await page.locator("#estimateText").innerText();
  await page.fill("#estPerDay", "25");
  await page.waitForFunction(() => /^25 comments per day/.test(document.getElementById("estimateText")?.textContent || ""), null, { timeout: 3000 });
  const after = await page.locator("#estimateText").innerText();
  check(after !== before && /25 comments per day on .+ \(.+\) will cost about \$[\d.]+ per day and \$[\d.]+ per month/.test(after), "estimator sentence updates: " + after);
  await page.getByLabel("Monthly budget (USD)").fill("5");
  await page.getByLabel("Monthly budget (USD)").press("Tab");
  await waitSaved(page);
  check(/of \$5\.00/.test(await page.locator("#budgetStatus").innerText()), "budget status shows spend of $5.00");
  await shot(page, "light-models-after.png");

  console.log("theme");
  await page.click('#themeSwitch [data-value="dark"]');
  check((await page.evaluate(() => document.documentElement.dataset.theme)) === "dark", "theme switch Dark sets data-theme=dark");
  await page.click('#themeSwitch [data-value="light"]');
  check((await page.evaluate(() => document.documentElement.dataset.theme)) === "light", "theme switch Light sets data-theme=light");
  await page.emulateMedia({ colorScheme: "dark" });
  await page.click('#themeSwitch [data-value="system"]');
  check((await page.evaluate(() => document.documentElement.dataset.theme)) === "dark", "System follows prefers-color-scheme (dark)");
  await page.emulateMedia({ colorScheme: "light" });
  await page.waitForTimeout(100);
  check((await page.evaluate(() => document.documentElement.dataset.theme)) === "light", "System follows prefers-color-scheme (light)");
  check((await page.evaluate(() => localStorage.getItem("sx.theme"))) === "system", "theme preference stored in localStorage sx.theme");

  console.log("safety alert");
  await page.evaluate(async () => {
    const st = (await chrome.storage.local.get("sx.state"))["sx.state"];
    await chrome.storage.local.set({ "sx.state": { ...st, status: "stopped", stopReason: "captcha", stopDetail: "Arkose challenge iframe detected on x.com/home", stoppedAt: Date.now(), alert: { reason: "captcha", detail: "Arkose challenge iframe detected on x.com/home", at: Date.now() - 120000 } } });
  });
  await openTab(page, base, "overview");
  await page.waitForSelector(".alert-banner", { timeout: 5000 });
  check(/Captcha/.test(await page.locator(".alert-banner").innerText()), "red alert banner with reason");
  check(/Stopped/.test(await page.locator("#heroStatus").innerText()) && (await page.locator("#engineBox .status-danger").count()) === 1, "status red: Stopped (safety reason)");
  check(/Stopped\s*\(Captcha/.test(await page.locator("#engineBox .status").innerText()) && (await page.locator("#btn-resume.btn-primary").count()) === 1, "top bar: Stopped (reason) + primary Resume");
  check((await page.locator(".alert-banner button:has-text('I checked my account - resume')").count()) === 1, "resume button in the alert");
  await page.screenshot({ path: path.join(OUT, "light-overview-alert.png"), fullPage: false });
  await setTheme(page, "dark");
  await page.screenshot({ path: path.join(OUT, "dark-overview-alert.png"), fullPage: false });
  await setTheme(page, "light");

  await page.evaluate(async () => {
    const st = (await chrome.storage.local.get("sx.state"))["sx.state"];
    await chrome.storage.local.set({ "sx.state": { ...st, status: "running", stopReason: null, stopDetail: "", alert: null, nextTickAt: Date.now() + 150000, nextCommentAt: Date.now() + 360000 } });
  });
  await page.waitForFunction(() => /Running/.test(document.getElementById("heroStatus")?.textContent || ""), null, { timeout: 5000 });
  check((await page.locator("#engineBox .status-running").count()) === 1 && (await page.locator(".alert-banner").count()) === 0, "Running shows the lime status and the alert clears");
  check((await page.locator("#btn-pause.btn-primary").count()) === 1 && !(await page.locator("#runNowBtn").isDisabled()), "while running the primary button is Pause and Run a check now is enabled");
  await page.screenshot({ path: path.join(OUT, "light-overview-running.png"), fullPage: false });
  await page.evaluate(async () => {
    const st = (await chrome.storage.local.get("sx.state"))["sx.state"];
    await chrome.storage.local.set({ "sx.state": { ...st, status: "stopped", stopReason: "captcha", alert: { reason: "captcha", detail: "Arkose challenge iframe detected on x.com/home", at: Date.now() - 120000 } } });
  });

  console.log("narrow layout");
  await page.setViewportSize({ width: 800, height: 1000 });
  await openTab(page, base, "overview");
  await page.screenshot({ path: path.join(OUT, "narrow-overview.png"), fullPage: false });
  const navInfo = () => page.evaluate(() => { const n = document.getElementById("nav"); const tabs = [...n.querySelectorAll(".tab")]; return { sw: n.scrollWidth, cw: n.clientWidth, ox: getComputedStyle(n).overflowX, rows: new Set(tabs.map((t) => Math.round(t.getBoundingClientRect().top))).size }; });
  let nav = await navInfo();
  check(nav.ox === "auto" && nav.rows === 1, "tab strip stays one row and is horizontally scrollable at 800px");
  const pageOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(pageOverflow <= 0, "no horizontal page scroll at 800px (overflow " + pageOverflow + "px)");
  await page.setViewportSize({ width: 560, height: 1000 });
  await page.waitForTimeout(150);
  nav = await navInfo();
  check(nav.sw > nav.cw && nav.rows === 1, `tab strip scrolls instead of wrapping when it does not fit (${nav.sw} > ${nav.cw})`);
  check((await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 0, "no horizontal page scroll at 560px");
  await page.screenshot({ path: path.join(OUT, "narrow-560-overview.png"), fullPage: false });
  await page.setViewportSize({ width: 800, height: 1000 });
  await openTab(page, base, "review");
  await page.screenshot({ path: path.join(OUT, "narrow-review.png"), fullPage: false });
  await openTab(page, base, "settings");
  await page.screenshot({ path: path.join(OUT, "narrow-settings.png"), fullPage: false });
  check((await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 0, "no horizontal page scroll on Settings at 800px");
  await page.setViewportSize({ width: 1360, height: 900 });

  console.log("advanced sections");
  await openTab(page, base, "models");
  const adv = page.locator('details[data-adv="models.advanced"]');
  check(!(await adv.evaluate((d) => d.open)), "Models: Advanced is collapsed by default");
  await adv.locator("summary").click();
  await page.waitForFunction(() => localStorage.getItem("sx.adv.models.advanced") === "1", null, { timeout: 3000 });
  await page.reload();
  await page.waitForSelector('#view[data-ready="models"]');
  check(await page.locator('details[data-adv="models.advanced"]').evaluate((d) => d.open), "Models: Advanced stays open after reload (localStorage)");
  check((await page.locator('details[data-adv="models.advanced"] #modelsTable tbody tr').count()) >= 3, "Models: the model/price table lives in Advanced");
  await page.locator('details[data-adv="models.advanced"] summary').click();
  for (const [tab, keys] of [["safety", ["safety.advanced"]], ["settings", ["settings.review", "settings.cleanup", "settings.data"]], ["tones", ["tones.advanced", "tones.ab"]], ["history", ["history.totals"]]]) {
    await openTab(page, base, tab);
    for (const k of keys) check((await page.locator(`details[data-adv="${k}"]`).count()) === 1 && !(await page.locator(`details[data-adv="${k}"]`).evaluate((d) => d.open)), `${tab}: "${k}" is a collapsed section`);
  }
  await openTab(page, base, "safety");
  check(!/warm-?up/i.test(await page.locator("#view").textContent()), "no warm-up on Safety");
  await openTab(page, base, "settings");
  check(!/warm-?up/i.test(await page.locator("#view").textContent()), "no warm-up on Settings");
  check((await page.locator("#cleanupEnabled").isChecked()) === false, "cleanup stays OFF by default");
  // Screenshots with every collapsed section open (to review the hidden parts), then close them again.
  for (const tab of ["models", "safety", "settings", "tones", "targets"]) {
    await openTab(page, base, tab);
    await page.evaluate(() => { for (const d of document.querySelectorAll("#view details.adv")) d.open = true; });
    await page.waitForTimeout(150);
    await shot(page, `light-${tab}-open.png`);
    await page.evaluate(() => { for (const d of document.querySelectorAll("#view details.adv")) d.open = false; });
  }
  await setTheme(page, "dark");
  await openTab(page, base, "settings");
  await page.evaluate(() => { for (const d of document.querySelectorAll("#view details.adv")) d.open = true; });
  await shot(page, "dark-settings-open.png");
  await page.evaluate(() => { for (const d of document.querySelectorAll("#view details.adv")) d.open = false; });
  await setTheme(page, "light");

  console.log("popup");
  const popup = await ctx.newPage();
  watch(popup, "popup");
  await popup.setViewportSize({ width: 340, height: 560 });
  for (const theme of ["light", "dark"]) {
    await popup.goto(base + "popup.html");
    await popup.evaluate((v) => window.sxTheme.set(v), theme);
    await popup.waitForSelector("#pPending .p-cell-value", { timeout: 10000 });
    await popup.waitForFunction(() => document.querySelector("#pPending .p-cell-value")?.textContent === "2", null, { timeout: 8000 });
    check(true, `popup renders in ${theme} with 2 pending`);
    await popup.waitForTimeout(300); // let colour transitions finish after the theme flip
    await popup.screenshot({ path: path.join(OUT, `${theme}-popup.png`), fullPage: true });
  }
  check((await popup.locator("#p-resume").count()) === 1, "popup offers Resume after a safety stop");
  check(/Captcha/.test(await popup.locator("#pAlert").innerText()), "popup shows the alert message");
  check((await popup.locator("#pControls .btn-primary").count()) === 1, "popup has one primary engine button");
  check(/\d+ \/ \d+/.test(await popup.locator("#pQuota").innerText()) && (await popup.locator("#pQuota .quota").count()) === 1, "popup shows the 24h quota bar");
  check(!/warm-?up/i.test(await popup.locator("body").innerText()), "no warm-up text in the popup");
} catch (e) {
  failed++;
  console.log("  FAIL exception: " + (e && e.stack ? e.stack : e));
} finally {
  await ctx.close();
  fs.rmSync(userDir, { recursive: true, force: true });
}

if (errors.length) {
  failed += errors.length;
  console.log("\npage errors / console errors:");
  for (const e of errors) console.log("  " + e);
}
console.log(`\n${passed} passed, ${failed} failed. Screenshots in ${OUT}`);
process.exit(failed ? 1 : 0);
