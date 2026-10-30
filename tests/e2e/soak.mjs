// Soak / chaos test: many cycles of the real engine against mock X with random disruptions (service-worker
// kills, X warnings, error pages, closed tab, pause/resume, mode switches, follow-backs, removed and
// blacklisted targets). After every cycle it checks the account-safety invariants:
//   * never a reply to an account that followed you (from the moment ScoreX knows it),
//   * at most one reply per target and per post, never more than the daily limit,
//   * nothing posted while paused, after a target was removed or blacklisted,
//   * no internal errors, no stuck "posting" records, every reply is in the history.
// Run: node tests/e2e/soak.mjs   (SX_SEED / SX_CYCLES / SX_PORT to vary)
import { boot, setup, assert, log, sleep, passCount } from "./harness.mjs";

const SEED = Number(process.env.SX_SEED) || 1337;
const CYCLES = Number(process.env.SX_CYCLES) || 30;
const DAILY = 8;
const PER_TARGET = 2; // the default: 2 comments per account per 24 hours
const ACCOUNTS = 6; // different accounts per 24 hours (set low here so the cap is exercised)
const MIN = 60000;
let seed = SEED;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = (a) => a[Math.floor(rand() * a.length)];

const H = await boot();
const { M } = H;
let failed = false;
const violations = [];
const events = [];
const ev = (what) => { events.push({ at: Date.now(), what }); log("  ~", what); };

const TARGETS = Array.from({ length: 12 }, (_, i) => "t" + (i + 1));
const FOLLOWERS = ["f1", "f2", "f3"]; // follow me from the start: must never get a reply
const OTHERS = ["n1", "n2", "n3"]; // not targets at all
const TEXTS = [
  "Most teams overbuild before they have ten real users. Talk to people first, then build.",
  "Rollups win on distribution, not on tech. The best sequencer is the one users never notice.",
  "Retention is the only growth metric that compounds. Everything else is a sugar high.",
  "Onchain data says stablecoin velocity is up again this month, mostly on L2s.",
  "Shipping weekly beats shipping perfect. Your users will tell you what is broken.",
  "Pricing pages convert better when they show limits upfront instead of hiding them.",
  "Hot take: most dashboards are vanity. Weekly active teams is the number that matters.",
  "Founders underestimate how long distribution takes to compound. Start before launch.",
];
const followSince = {}; // handle -> time ScoreX first marked "follows you"
const removedAt = {}; // handle -> time it was removed / blacklisted
const pauses = []; // [from, to]
let stopsSeen = 0;

function checkInvariants(where) {
  const byTarget = {}, byPost = {};
  for (const r of M.replies) {
    const post = M.posts.find((p) => p.id === r.inReplyTo);
    const author = post ? post.author : "?";
    byTarget[author] = (byTarget[author] || 0) + 1;
    byPost[r.inReplyTo] = (byPost[r.inReplyTo] || 0) + 1;
    if (FOLLOWERS.includes(author)) violations.push(`${where}: reply to @${author}, who followed from the start`);
    if (OTHERS.includes(author)) violations.push(`${where}: reply to non-target @${author}`);
    if (followSince[author] && r.at > followSince[author] + 2000) violations.push(`${where}: reply to @${author} after ScoreX knew it follows you`);
    if (removedAt[author] && r.at > removedAt[author] + 60000) violations.push(`${where}: reply to @${author} after it was removed/blacklisted`);
    for (const [a, b] of pauses) if (r.at > a + 5000 && r.at < b) violations.push(`${where}: reply at ${new Date(r.at).toISOString()} while paused`);
  }
  for (const [h, n] of Object.entries(byTarget)) if (n > PER_TARGET) violations.push(`${where}: ${n} replies to @${h} within 24h (max ${PER_TARGET})`);
  if (Object.keys(byTarget).length > ACCOUNTS) violations.push(`${where}: replies to ${Object.keys(byTarget).length} different accounts (max ${ACCOUNTS})`);
  for (const id of M.likes) { const p = M.posts.find((x) => x.id === id); if (p && (FOLLOWERS.includes(p.author) || OTHERS.includes(p.author))) violations.push(`${where}: liked a post by @${p.author}`); }
  for (const [p, n] of Object.entries(byPost)) if (n > 1) violations.push(`${where}: ${n} replies to post ${p}`);
  if (M.replies.length > DAILY) violations.push(`${where}: ${M.replies.length} replies > daily limit ${DAILY}`);
}

async function settle(ms = 45000) {
  await H.waitFor(async () => { const s = await H.store("sx.state"); return !s.job || s.job.leaseUntil < Date.now(); }, "idle engine", ms, 500).catch(() => {});
}

try {
  for (const h of TARGETS) M.addUser(h, { followers: 20000 + Math.floor(rand() * 200000) });
  for (const h of FOLLOWERS) M.addUser(h, { followsMe: true, followers: 50000 });
  for (const h of OTHERS) M.addUser(h, { followers: 3000 });
  M.addUser("fan1", { followsMe: true });
  M.followers["0x_nation"] = ["fan1", "f1"]; // f2, f3 only show "Follows you" on their profiles

  await setup(H, {
    mode: "auto",
    safety: { ramp: [DAILY, DAILY, DAILY], accountsPerDay: ACCOUNTS, like: { enabled: true }, breaks: { enabled: true, afterMin: 3, afterMax: 4, minutesMin: 5, minutesMax: 6 } },
    learning: { abTesting: false },
    follow: { checksPerRun: 8 },
  });
  const r = await H.msg("targetsImport", { text: [...TARGETS, ...FOLLOWERS].join("\n"), defaults: { tier: 2 } });
  assert(r.ok && r.added === TARGETS.length + FOLLOWERS.length, "imported 15 targets");
  assert((await H.msg("start")).ok, "engine started");
  const t0 = await H.untilChecked([...TARGETS, ...FOLLOWERS], 300000);
  assert(FOLLOWERS.every((h) => t0[h].rel.followsYou === true) && TARGETS.every((h) => t0[h].rel.followsYou === false), "follow check: 3 follow me, 12 don't");

  for (let c = 1; c <= CYCLES; c++) {
    log(`cycle ${c}/${CYCLES}`);
    // New posts (targets, followers, non-targets).
    const n = 2 + Math.floor(rand() * 3);
    for (let i = 0; i < n; i++) M.addPost(pick([...TARGETS, ...TARGETS, ...FOLLOWERS, ...OTHERS]), pick(TEXTS) + " #" + c + i, 1 + Math.floor(rand() * 4));

    const roll = rand();
    let paused = null;
    if (roll < 0.10) { M.replyMode = "warning"; ev("X shows 'looks automated' on submit"); }
    else if (roll < 0.18) { M.pageMode = "error"; ev("X shows 'Something went wrong' pages"); }
    else if (roll < 0.26) {
      const live = TARGETS.filter((h) => !followSince[h] && !removedAt[h] && !M.users[h].followsMe);
      if (live.length) { const h = pick(live); M.users[h].followsMe = true; M.followers["0x_nation"].unshift(h); await H.patchState({ followersScanAt: 1 }); ev(`@${h} follows back`); }
    } else if (roll < 0.32) {
      const live = TARGETS.filter((h) => !removedAt[h]);
      if (live.length) {
        const h = pick(live);
        if (rand() < 0.5) await H.msg("targetsRemove", { handles: [h] }); else await H.msg("blacklistAdd", { handles: [h] });
        removedAt[h] = Date.now(); ev(`@${h} removed/blacklisted`);
      }
    } else if (roll < 0.42) { await H.msg("pause"); paused = Date.now(); ev("paused"); }
    else if (roll < 0.50) { const tab = (await H.xTabs())[0]; if (tab) { await tab.close().catch(() => {}); ev("X tab closed"); } }
    else if (roll < 0.58) { await H.settings({ mode: "review" }); ev("switched to Review mode"); }

    // Two checks per cycle (one posts a due reply, the next watches and generates). Clock-based waits (gaps /
    // breaks) are sped up; history-based limits (daily, per target) stay untouched.
    for (let k = 0; k < 2; k++) {
      await settle();
      await H.patchState({ nextCommentAt: 0, lastCommentAt: Date.now() - 3 * MIN, breakUntil: 0 });
      for (const x of (await H.history()).filter((x) => x.status === "queued" || x.status === "approved")) await H.patchHistory(x.id, { scheduledFor: 0 });
      await H.runNow();
      // Sometimes kill the service worker while it works.
      if (rand() < 0.15) { await sleep(2000 + Math.floor(rand() * 8000)); await H.stopWorker(); ev("service worker killed"); await sleep(1500); await H.msg("getStatus"); }
      await sleep(5000);
      await settle(90000);
    }

    // Undo the disruption and recover like a user would.
    if (M.replyMode !== "ok") M.replyMode = "ok";
    if (M.pageMode !== "ok") M.pageMode = "ok";
    if (paused) { await sleep(3000); pauses.push([paused, Date.now()]); await H.msg("resume"); ev("resumed"); }
    const s = (await H.msg("getStatus")).status;
    if (s.state.status === "stopped") {
      stopsSeen++;
      if (s.state.stopReason === "internal_error") violations.push(`cycle ${c}: internal error stop: ${s.state.stopDetail}`);
      ev(`engine stopped (${s.state.stopReason}) -> resume`);
      await H.msg("resume");
    }
    if ((await H.store("sx.settings")).mode === "review") {
      const pend = (await H.history()).filter((x) => x.status === "pending_review").map((x) => x.id);
      if (pend.length) await H.msg("reviewApproveAll", { ids: pend });
      await H.settings({ mode: "auto" });
      ev(`approved ${pend.length} pending, back to Full auto`);
    }
    const tg = await H.store("sx.targets");
    for (const h of TARGETS) if (tg[h] && tg[h].rel.followsYou === true && !followSince[h]) followSince[h] = Date.now();
    checkInvariants(`cycle ${c}`);
    if (violations.length) break;
  }

  // Final consistency checks.
  await settle(120000);
  const hist = await H.history();
  const posting = hist.filter((x) => x.status === "posting");
  assert(!posting.length, "no records stuck in 'posting' (" + posting.length + ")");
  const replyIds = new Set(M.replies.map((x) => x.id));
  const postedIds = new Set(hist.filter((x) => x.status === "posted").map((x) => x.replyId).filter(Boolean));
  const unknown = M.replies.filter((x) => !postedIds.has(x.id) && !hist.some((h) => h.postId === x.inReplyTo && (h.maybePosted || h.status === "posted")));
  assert(!unknown.length, "every reply on X is in the history (" + unknown.length + " unknown)");
  assert([...postedIds].every((id) => replyIds.has(id)), "every 'posted' record exists on X");
  const logs = (await H.store("sx.logs")) || [];
  const tickErrors = logs.filter((l) => /Tick failed/.test(l.msg));
  assert(!tickErrors.length, "no internal tick errors (" + tickErrors.map((l) => l.msg).join(" | ") + ")");
  checkInvariants("final");
  assert(!violations.length, "no safety invariant violated:\n    " + violations.join("\n    "));
  const eligible = TARGETS.filter((h) => !removedAt[h] && !followSince[h]).length;
  if (eligible >= DAILY && CYCLES >= 30) assert(M.replies.length >= DAILY - 1, `the daily limit was reached and held (${M.replies.length}/${DAILY})`);
  log(`\nSoak: ${CYCLES} cycles, ${M.replies.length} replies, ${M.likes.length} likes, ${stopsSeen} safety stops handled, ${events.length} disruptions.`);
  log(`Soak e2e: ${passCount()} checks passed`);
} catch (e) {
  failed = true;
  console.error(e);
  if (violations.length) console.error("VIOLATIONS:\n" + violations.join("\n"));
  console.error("--- events ---\n" + events.map((x) => new Date(x.at).toISOString().slice(11, 19) + " " + x.what).join("\n"));
  console.error("--- SW logs (last 40) ---\n" + H.swLogs.slice(-40).join("\n"));
  try { console.error("--- activity log ---\n" + JSON.stringify(((await H.store("sx.logs")) || []).slice(-40).map((x) => `${new Date(x.ts).toISOString().slice(11, 19)} ${x.level} ${x.msg} ${x.data || ""}`), null, 1)); } catch (_) {}
} finally {
  await H.close();
  process.exit(failed ? 1 : 0);
}
