// Mock x.com + api.openai.com + api.sorsa.io + twitterscore.io for ScoreX end-to-end tests.
// Serves pages whose DOM mimics X's data-testid structure closely enough for the content scripts,
// records every reply/like/unfollow, and answers OpenAI Responses API calls with configurable behaviour.
import https from "https";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";

const DIR = path.dirname(new URL(import.meta.url).pathname);

function ensureCert() {
  if (fs.existsSync(path.join(DIR, "cert.pem"))) return;
  execSync(`openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 30 -subj "/CN=x.com" -addext "subjectAltName=DNS:x.com,DNS:api.openai.com,DNS:api.sorsa.io"`, { cwd: DIR, stdio: "ignore" });
}

const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const MIN = 60000;

export function createMock(opts = {}) {
  const M = {
    me: opts.me || "0x_nation",
    loggedIn: true,
    pageMode: "ok", // ok | captcha | locked | error | logged_out | wrong_account
    replyMode: "ok", // ok | warning | rate_limit | duplicate | silent | hang
    hideReplyBox: false,
    users: {},
    posts: [], // { id, author, text, createdAt, lang, promoted, reply, repost, likes, replies, liked }
    replies: [], // our posted replies { id, inReplyTo, text, at }
    likes: [],
    unfollows: [],
    followers: {}, // handle -> [handles]
    following: {},
    lists: { "1234567890": [] }, // list id -> member handles (empty = all authors)
    openai: { mode: "ok", calls: [], comments: null, checkPass: true, failFirst: 0 },
    sorsa: { calls: [], scores: {}, top: {} }, // top: handle -> [{ username, display_name, score, followers_count }]
    // twitterscore: scores handle -> 0..1000; smart: handle -> [{ handle, score }]; mode: ok | blocked (bot check) | js (panel filled by JS)
    twitterscore: { calls: [], scores: {}, smart: {}, mode: "ok", apiKey: "ts-test" },
    ethos: { calls: [], scores: {} }, // handle -> score (missing = no Ethos profile)
    moni: { calls: [], scores: {}, smarts: {} }, // smarts: handle -> [handles]
    log: [],
    nextId: 1900000000000000000n,
  };

  M.addUser = (h, u = {}) => { M.users[h] = { handle: h, name: u.name || h.toUpperCase(), bio: u.bio || `Building things. Thoughts on ${h}.`, followers: u.followers ?? 12000, following: u.following ?? 800, verified: !!u.verified, followsMe: !!u.followsMe, iFollow: !!u.iFollow, id: u.id || String(1000 + Object.keys(M.users).length), joined: u.joined || "March 2019" }; return M.users[h]; };
  M.addPost = (author, text, minutesAgo, extra = {}) => {
    const id = String(M.nextId++);
    const p = { id, author, text, createdAt: Date.now() - minutesAgo * MIN, lang: "en", likes: 10, replies: 3, reposts: 2, views: 900, liked: false, ...extra };
    M.posts.push(p);
    if (!M.users[author]) M.addUser(author);
    return p;
  };

  // ---------- HTML ----------
  const shell = (body, { title = "X" } = {}) => {
    const loggedIn = M.loggedIn && M.pageMode !== "logged_out";
    const meHandle = M.pageMode === "wrong_account" ? "someone_else" : M.me;
    const nav = loggedIn
      ? `<nav><a data-testid="AppTabBar_Profile_Link" href="/${meHandle}">Profile</a><div data-testid="SideNav_AccountSwitcher_Button"><img src="/pic.png"><div><span>Me</span></div><div><span>@${meHandle}</span></div></div></nav>`
      : `<div><a data-testid="loginButton" href="/login">Log in</a><a data-testid="signupButton" href="/signup">Sign up</a></div>`;
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>body{font-family:sans-serif;margin:0} article{border-bottom:1px solid #ddd;padding:12px;display:block} [data-testid=toast]{position:fixed;bottom:10px;left:10px;background:#1d9bf0;color:#fff;padding:8px} .cell{padding:8px;border-bottom:1px solid #eee;display:block} [contenteditable]{min-height:40px;border:1px solid #ccc;padding:6px}</style></head>
<body>${nav}<main role="main"><div data-testid="primaryColumn">${body}</div></main>
<div id="layers"></div>
<script src="/__mock/app.js"></script></body></html>`;
  };

  const ago = (ts) => { const m = Math.max(0, Math.round((Date.now() - ts) / MIN)); return m < 60 ? m + "m" : Math.round(m / 60) + "h"; };

  const tweetHtml = (p, { focal = false } = {}) => {
    const u = M.users[p.author] || { name: p.author };
    const ctx = p.repost ? `<div data-testid="socialContext"><span>${esc(p.repost)} reposted</span></div>` : p.pinned ? `<div data-testid="socialContext"><span>Pinned</span></div>` : "";
    const ad = p.promoted ? `<div><span>Ad</span></div>` : "";
    const replying = p.reply ? `<div><div>Replying to <a href="/${esc(p.reply)}">@${esc(p.reply)}</a></div></div>` : "";
    const likeBtn = p.liked ? `<button data-testid="unlike" aria-label="${p.likes + 1} Likes. Liked">${p.likes + 1}</button>` : `<button data-testid="like" aria-label="${p.likes} Likes. Like">${p.likes}</button>`;
    return `<article data-testid="tweet" role="article" tabindex="${focal ? -1 : 0}" data-mock-id="${p.id}">
${ctx}
<div data-testid="User-Name"><a href="/${p.author}" role="link"><span>${esc(u.name)}</span></a><div><a href="/${p.author}" role="link"><span>@${p.author}</span></a><span>·</span><a href="/${p.author}/status/${p.id}" role="link"><time datetime="${new Date(p.createdAt).toISOString()}">${ago(p.createdAt)}</time></a></div>${ad}</div>
${replying}
<div data-testid="tweetText" lang="${p.lang || "en"}"><span>${esc(p.text)}</span></div>
${p.media ? `<div data-testid="tweetPhoto"><img alt="Image" src="/m.png"></div>` : ""}
${p.card ? `<div data-testid="card.wrapper"><a href="https://t.co/xyz">example.com</a></div>` : ""}
<div role="group" aria-label="${p.replies} replies, ${p.reposts} reposts, ${p.likes} likes, ${p.views} views">
<button data-testid="reply" aria-label="${p.replies} Replies. Reply">${p.replies}</button>
<button data-testid="retweet" aria-label="${p.reposts} reposts. Repost">${p.reposts}</button>
${likeBtn}
<a href="/${p.author}/status/${p.id}/analytics" aria-label="${p.views} views. View post analytics">${p.views}</a>
</div></article>`;
  };

  const userCell = (u) => `<div data-testid="UserCell" class="cell"><a href="/${u.handle}" role="link"><img src="/p.png"><span>${esc(u.name)}</span></a>${u.verified ? `<svg data-testid="icon-verified"></svg>` : ""}
<div><a href="/${u.handle}"><span>@${u.handle}</span></a>${u.followsMe ? `<span data-testid="userFollowIndicator">Follows you</span>` : ""}</div>
<div>${esc(u.bio)}</div><button data-testid="${u.id}-${u.iFollow ? "unfollow" : "follow"}">${u.iFollow ? "Following" : "Follow"}</button></div>`;

  function timeline(posts) {
    const sorted = posts.slice().sort((a, b) => b.createdAt - a.createdAt);
    if (M.pageMode === "broken") return sorted.map((p) => `<article data-testid="tweet"><div class="new-markup">${esc(p.text)}</div></article>`).join("\n");
    return sorted.map((p) => tweetHtml(p)).join("\n");
  }

  function page(url) {
    const u = new URL(url, "https://x.com");
    const p = u.pathname;
    if (M.pageMode === "captcha" && !p.startsWith("/account/access")) return { redirect: "/account/access" };
    if (M.pageMode === "locked" && !p.startsWith("/account/access")) return { redirect: "/account/access" };
    if (p.startsWith("/account/access")) {
      if (M.pageMode === "captcha") return { html: `<!doctype html><html><body><h1>Verify you are human</h1><iframe src="about:blank#arkoselabs"></iframe><script src="/__mock/app.js"></script></body></html>` };
      return { html: `<!doctype html><html><body><h1>Your account has been locked.</h1><script src="/__mock/app.js"></script></body></html>` };
    }
    if (p === "/i/flow/login" || p === "/login") return { html: shell(`<h1>Sign in to X</h1>`) };
    if (M.pageMode === "error") return { html: shell(`<div data-testid="error-detail"><span>Something went wrong. Try reloading.</span><button>Retry</button></div>`) };
    if (p === "/home") return { html: shell(timeline(M.posts.slice(0, 10))) };
    let m = p.match(/^\/i\/lists\/(\d+)/);
    if (m) {
      const members = M.lists[m[1]] || [];
      const posts = M.posts.filter((x) => !members.length || members.includes(x.author));
      return { html: shell(`<h2>My list</h2>${timeline(posts)}`) };
    }
    if (p === "/search") {
      const q = u.searchParams.get("q") || "";
      if (u.searchParams.get("f") === "user") {
        const words = q.toLowerCase().split(/\s+/);
        const cells = Object.values(M.users).filter((x) => words.some((w) => (x.bio + " " + x.name + " " + x.handle).toLowerCase().includes(w))).map(userCell).join("");
        return { html: shell(cells || `<div data-testid="emptyState"><span data-testid="empty_state_header_text">No results</span></div>`) };
      }
      const froms = [...q.matchAll(/from:([A-Za-z0-9_]+)/g)].map((x) => x[1].toLowerCase());
      const noReplies = /-filter:replies/.test(q);
      const posts = M.posts.filter((x) => froms.includes(x.author) && (!noReplies || !x.reply));
      M.log.push({ kind: "search", q });
      return { html: shell(timeline(posts)) };
    }
    m = p.match(/^\/([A-Za-z0-9_]{1,15})\/status\/(\d+)/);
    if (m) {
      let post = M.posts.find((x) => x.id === m[2]);
      if (!post) {
        const mineR = M.replies.find((x) => x.id === m[2]);
        if (mineR) post = { id: mineR.id, author: M.me, text: mineR.text, createdAt: mineR.at, likes: mineR.likes || 0, replies: M.posts.filter((x) => x.replyTo === mineR.id).length, reposts: 0, views: 50, reply: (M.posts.find((x) => x.id === mineR.inReplyTo) || {}).author };
      }
      if (!post) return { html: shell(`<div data-testid="emptyState"><span data-testid="empty_state_header_text">Hmm...this page doesn't exist. Try searching for something else.</span></div>`) };
      const mine = M.replies.filter((r) => r.inReplyTo === post.id).map((r) => tweetHtml({ id: r.id, author: M.me, text: r.text, createdAt: r.at, likes: r.likes || 0, replies: r.replyCount || 0, reposts: 0, views: 10, reply: post.author }));
      const others = M.posts.filter((x) => x.replyTo === post.id).map((x) => tweetHtml(x));
      const composer = M.hideReplyBox ? `<div><span>Who can reply? People @${post.author} mentioned can reply</span></div>` :
        `<div id="composer"><div data-testid="tweetTextarea_0" role="textbox" contenteditable="true" aria-label="Post text"></div><button data-testid="tweetButtonInline" aria-disabled="true" disabled>Reply</button></div>`;
      const parent = post.parentId ? M.posts.find((x) => x.id === post.parentId) : null;
      return { html: shell(`${parent ? tweetHtml(parent) : ""}${tweetHtml(post, { focal: true })}${composer}<section id="replies">${[...mine, ...others].join("")}</section>`, { title: "Post" }) };
    }
    m = p.match(/^\/([A-Za-z0-9_]{1,15})\/(followers|verified_followers|following)$/);
    if (m) {
      const h = m[1].toLowerCase();
      const list = (m[2] === "following" ? M.following[h] : M.followers[h]) || [];
      const cells = list.map((x) => M.users[x] || M.addUser(x)).map(userCell);
      if (!cells.length) return { html: shell(`<div data-testid="emptyState"><span data-testid="empty_state_header_text">Nobody here yet</span></div>`) };
      return { html: shell(`<div id="cells" data-total="${cells.length}">${cells.slice(0, 20).join("")}</div><template id="more">${cells.slice(20).join("")}</template>`) };
    }
    m = p.match(/^\/([A-Za-z0-9_]{1,15})\/?$/);
    if (m) {
      const h = m[1].toLowerCase();
      const user = M.users[h];
      if (!user) return { html: shell(`<div data-testid="emptyState"><span data-testid="empty_state_header_text">This account doesn’t exist</span></div>`) };
      const btn = user.iFollow ? `<button data-testid="${user.id}-unfollow">Following</button>` : `<button data-testid="${user.id}-follow">Follow</button>`;
      return { html: shell(`<div data-testid="UserName"><div><span>${esc(user.name)}</span>${user.verified ? `<svg data-testid="icon-verified"></svg>` : ""}</div><div><span>@${h}</span>${user.followsMe ? `<span data-testid="userFollowIndicator">Follows you</span>` : ""}</div></div>
<div data-testid="UserDescription"><span>${esc(user.bio)}</span></div>
<div data-testid="UserProfileHeader_Items"><span data-testid="UserJoinDate">Joined ${esc(user.joined)}</span></div>
<a href="/${h}/following"><span>${user.following}</span> <span>Following</span></a> <a href="/${h}/verified_followers"><span>${user.followers}</span> <span>Followers</span></a>
${btn}
${timeline(M.posts.filter((x) => x.author === h))}`, { title: user.name }) };
    }
    return { html: shell(`<div data-testid="emptyState"><span data-testid="empty_state_header_text">Hmm...this page doesn't exist.</span></div>`) };
  }

  // The mock "X app": composer button state, submit, like, unfollow sheet, lazy user lists.
  const APP_JS = `
(function(){
  function toast(html){ var t=document.createElement('div'); t.setAttribute('data-testid','toast'); t.setAttribute('role','alert'); t.innerHTML=html; document.body.appendChild(t); setTimeout(function(){ t.remove(); }, 6000); }
  var box=document.querySelector('[data-testid="tweetTextarea_0"]'); var btn=document.querySelector('[data-testid="tweetButtonInline"]');
  function sync(){ if(!btn) return; var empty=!box.innerText.trim(); if(empty){btn.setAttribute('aria-disabled','true');btn.disabled=true;} else {btn.removeAttribute('aria-disabled');btn.disabled=false;} }
  if(box){ box.addEventListener('input', sync); }
  if(btn){ btn.addEventListener('click', function(){
    var focal=document.querySelector('article[tabindex="-1"]'); var id=focal.getAttribute('data-mock-id'); var text=box.innerText.trim();
    fetch('/__mock/reply',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({inReplyTo:id,text:text})}).then(function(r){return r.json();}).then(function(j){
      if(j.toast){ toast('<span>'+j.toast+'</span>'); return; }
      if(j.silent){ box.innerHTML=''; sync(); return; }
      box.innerHTML=''; sync();
      toast('<span>Your post was sent.</span> <a href="/'+j.author+'/status/'+j.id+'">View</a>');
    });
  }); }
  document.addEventListener('click', function(e){
    var like=e.target.closest('[data-testid="like"]');
    if(like){ var art=like.closest('article'); fetch('/__mock/like',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:art.getAttribute('data-mock-id')})}).then(function(r){return r.json();}).then(function(j){ if(j.toast){toast('<span>'+j.toast+'</span>');return;} like.setAttribute('data-testid','unlike'); }); }
    var un=e.target.closest('[data-testid$="-unfollow"]');
    if(un && !un.closest('[data-testid="UserCell"]')){
      var d=document.createElement('div'); d.setAttribute('role','dialog'); d.innerHTML='<div data-testid="confirmationSheetDialog"><button data-testid="confirmationSheetConfirm">Unfollow</button><button data-testid="confirmationSheetCancel">Cancel</button></div>';
      document.getElementById('layers').appendChild(d);
      d.querySelector('[data-testid="confirmationSheetConfirm"]').addEventListener('click', function(){
        fetch('/__mock/unfollow',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({handle:location.pathname.split('/')[1]})}).then(function(){ un.setAttribute('data-testid', un.getAttribute('data-testid').replace('-unfollow','-follow')); un.textContent='Follow'; d.remove(); });
      });
    }
  });
  var more=document.getElementById('more');
  if(more){ window.addEventListener('scroll', function(){ if(window.innerHeight+window.scrollY>=document.body.scrollHeight-200 && more.innerHTML){ document.getElementById('cells').insertAdjacentHTML('beforeend', more.innerHTML); more.innerHTML=''; } }); }
})();`;

  // ---------- OpenAI mock ----------
  const TEMPLATES = [
    (w) => `The part about ${w} is underrated. Distribution compounds faster than features once the first users stick.`,
    (w) => `How are you measuring ${w} right now? Retention curves usually tell the real story before revenue does.`,
    (w) => `Counterpoint on ${w}: small teams win when the feedback loop is daily, not quarterly.`,
    (w) => `Seen this play out with ${w} twice. The second time we shipped half the scope and doubled usage.`,
    (w) => `Curious edge case with ${w}: what breaks first when usage triples overnight?`,
    (w) => `Strong take. ${w} only works if onboarding is under a minute, otherwise churn eats it.`,
    (w) => `Underrated angle on ${w}: pricing pages convert better when they show the boring limits upfront.`,
    (w) => `Would love the numbers behind ${w}. Most teams overestimate how many users read past line one.`,
  ];
  let tpl = 0;
  function openaiAnswer(body) {
    const instr = String(body.instructions || "");
    const input = JSON.stringify(body.input || "");
    const isCheck = /strict editor/i.test(instr);
    const cfg = M.openai;
    cfg.calls.push({ model: body.model, isCheck, effort: body.reasoning && body.reasoning.effort, body });
    if (cfg.failFirst > 0) { cfg.failFirst--; return { status: 429, json: { error: { message: "Rate limit reached for requests", type: "requests", param: null, code: "rate_limit_exceeded" } } }; }
    if (cfg.mode === "401") return { status: 401, json: { error: { message: "Incorrect API key provided: sk-...", type: "invalid_request_error", param: null, code: "invalid_api_key" } } };
    if (cfg.mode === "quota") return { status: 429, json: { error: { message: "You exceeded your current quota", type: "insufficient_quota", param: null, code: "insufficient_quota" } } };
    if (cfg.mode === "noverbosity" && body.text && body.text.verbosity) return { status: 400, json: { error: { message: "Unsupported parameter: 'text.verbosity'", type: "invalid_request_error", param: "text.verbosity", code: "unsupported_parameter" } } };
    let text;
    if (isCheck) text = JSON.stringify({ pass: cfg.checkPass, generic: !cfg.checkPass, off_topic: false, adds_value: cfg.checkPass, same_language: true, issue: cfg.checkPass ? "" : "generic" });
    else if (cfg.mode === "skip") text = JSON.stringify({ skip: true, skip_reason: "political", comment: "" });
    else {
      let postText = "this";
      try {
        const raw = body.input[0].content[0].text;
        const data = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("DATA>>>")).trim());
        postText = data.post.text;
      } catch (_) {}
      const words = postText.split(/\s+/).filter((x) => x.length > 3);
      const w = (words[1] || words[0] || "this").toLowerCase().replace(/[^a-z]/g, "") || "this";
      const comment = cfg.comments && cfg.comments.length ? cfg.comments.shift() : TEMPLATES[tpl++ % TEMPLATES.length](w);
      text = JSON.stringify({ skip: false, skip_reason: "", comment });
    }
    const reasoning = body.reasoning ? (body.reasoning.effort === "high" ? 900 : body.reasoning.effort === "medium" ? 400 : 120) : 0;
    return { status: 200, json: {
      id: "resp_" + cfg.calls.length, object: "response", status: "completed", model: body.model,
      output: [{ type: "reasoning", summary: [] }, { type: "message", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] }],
      usage: { input_tokens: 1200, input_tokens_details: { cached_tokens: 256 }, output_tokens: 60 + reasoning, output_tokens_details: { reasoning_tokens: reasoning }, total_tokens: 1260 + reasoning },
    } };
  }

  // ---------- server ----------
  const handler = (req, res) => {
    const host = String(req.headers.host || "").split(":")[0];
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const send = (status, data, type = "application/json", headers = {}) => { res.writeHead(status, { "content-type": type, "cache-control": "no-store", ...headers }); res.end(typeof data === "string" ? data : JSON.stringify(data)); };
      try {
        if (host === "api.openai.com") {
          const auth = req.headers.authorization || "";
          if (!auth.startsWith("Bearer sk-")) return send(401, { error: { message: "missing key", code: "invalid_api_key" } });
          const a = openaiAnswer(JSON.parse(body || "{}"));
          return send(a.status, a.json);
        }
        if (host === "api.sorsa.io") {
          M.sorsa.calls.push(req.url);
          if (req.headers.apikey !== "sorsa-test") return send(401, { message: "bad key" });
          const u = new URL(req.url, "https://api.sorsa.io");
          if (u.pathname === "/v3/key-usage-info") return send(200, { key_requests: 100, remaining_requests: 95, total_requests: 5 });
          const h = (u.searchParams.get("username") || "").toLowerCase();
          if (u.pathname === "/v3/top-followers") return send(200, { users: M.sorsa.top[h] || [] });
          return send(200, { score: M.sorsa.scores[h] ?? null });
        }
        if (host === "api.ethos.network") {
          const u = new URL(req.url, "https://api.ethos.network");
          M.ethos.calls.push(u.pathname + " " + (req.headers["x-ethos-client"] || ""));
          const m3 = u.pathname.match(/^\/api\/v2\/user\/by\/x\/([A-Za-z0-9_]{1,15})$/);
          if (!m3) return send(404, { message: "not found" });
          const h = m3[1].toLowerCase();
          const sc = M.ethos.scores[h];
          return send(200, { id: 1, profileId: sc == null ? null : 77, username: h, displayName: h, score: sc == null ? 1200 : sc, status: "ACTIVE" });
        }
        if (host === "api.discover.getmoni.io") {
          const u = new URL(req.url, "https://api.discover.getmoni.io");
          M.moni.calls.push(u.pathname);
          if (req.headers["api-key"] !== "moni-test") return send(401, { detail: "Invalid API key" });
          const m4 = u.pathname.match(/^\/api\/v3\/accounts\/([A-Za-z0-9_]{1,15})\/(info\/smart_engagement|smarts\/meta)\/$/);
          if (!m4) return send(404, { detail: "Not found" });
          const h = m4[1].toLowerCase();
          if (m4[2] === "info/smart_engagement") return M.moni.scores[h] == null ? send(404, { detail: "Not found" }) : send(200, { smartEngagement: { smartsCount: (M.moni.smarts[h] || []).length, moniScore: M.moni.scores[h], mentionsCount: 3, smartMentionsCount: 1 } });
          const items = (M.moni.smarts[h] || []).map((x) => ({ meta: { userId: "1", userUrl: "https://x.com/" + x } }));
          return send(200, { items, totalCount: items.length });
        }
        if (host === "twitterscore.io") {
          const u = new URL(req.url, "https://twitterscore.io");
          M.twitterscore.calls.push(u.pathname + u.search);
          const TS = M.twitterscore;
          if (u.pathname.startsWith("/api/v1/")) {
            if ((u.searchParams.get("api_key") || req.headers["x-api-key"]) !== TS.apiKey) return send(401, { success: false, message: "bad key" });
            const h = (u.searchParams.get("username") || "").toLowerCase();
            if (u.pathname === "/api/v1/get_twitter_score") return TS.scores[h] == null ? send(404, { success: false }) : send(200, { success: true, username: h, twitter_id: "1", twitter_score: TS.scores[h] });
            if (u.pathname === "/api/v1/top_followers_paginate") return send(200, { success: true, top_followers: (TS.smart[h] || []).map((x) => ({ username: x.handle, name: x.handle.toUpperCase(), twitter_score: x.score, followers_count: 10000 })) });
            return send(404, { success: false });
          }
          const m2 = u.pathname.match(/^\/twitter\/([A-Za-z0-9_]{1,15})\/?$/);
          if (m2) {
            if (TS.mode === "blocked") return send(403, "<!doctype html><title>Just a moment...</title><div>challenge-platform</div>", "text/html");
            const h = m2[1].toLowerCase();
            if (TS.scores[h] == null) return send(404, "<!doctype html><title>Not found</title><h1>Account not found</h1>", "text/html");
            const rows = (TS.smart[h] || []).slice(0, 3).map((x) => `<a class="row" href="/twitter/${x.handle}/"><span>@${x.handle}</span> <b>${x.score}</b></a>`).join("");
            const panel = `<section><h3>Smart Followers</h3><div id="sf">${TS.mode === "js" ? "" : rows}</div><p>Smart followers list is a PRO feature. Free tier shows the first 3 followers only.</p></section>`;
            const js = TS.mode === "js" ? `<script>setTimeout(function(){document.getElementById('sf').innerHTML=${JSON.stringify(rows)};},400)</script>` : "";
            const nav = `<nav><a href="/twitter/trendingguy/">Trending: @trendingguy</a></nav>`;
            return send(200, `<!doctype html><html><head><title>${h.toUpperCase()} (@${h}) — Twitter Score ${TS.scores[h]}/1000</title></head><body>${nav}<h1>${h.toUpperCase()}</h1><p>${h.toUpperCase()} (@${h}) has a Twitter Score of ${TS.scores[h]}.</p>${panel}${js}</body></html>`, "text/html; charset=utf-8");
          }
          return send(404, "not found", "text/plain");
        }
        const url = new URL(req.url, "https://x.com");
        if (url.pathname === "/__mock/app.js") return send(200, APP_JS, "application/javascript");
        if (url.pathname.endsWith(".png")) return send(200, "", "image/png");
        if (url.pathname === "/__mock/reply" && req.method === "POST") {
          const j = JSON.parse(body);
          M.log.push({ kind: "reply", ...j });
          if (M.replyMode === "warning") return send(200, { toast: "This request looks like it might be automated. To protect our users from spam and other malicious activity, we can’t complete this action right now. Please try again later." });
          if (M.replyMode === "rate_limit") return send(200, { toast: "You are over the daily limit for sending posts." });
          if (M.replyMode === "duplicate") return send(200, { toast: "Whoops! You already said that." });
          if (M.replyMode === "drop") return send(200, { silent: true });
          const id = String(M.nextId++);
          M.replies.push({ id, inReplyTo: j.inReplyTo, text: j.text, at: Date.now() });
          if (M.replyMode === "silent") return send(200, { silent: true });
          return send(200, { id, author: M.me });
        }
        if (url.pathname === "/__mock/like" && req.method === "POST") {
          const j = JSON.parse(body);
          M.likes.push(j.id);
          const p = M.posts.find((x) => x.id === j.id);
          if (p) p.liked = true;
          return send(200, { ok: true });
        }
        if (url.pathname === "/__mock/unfollow" && req.method === "POST") {
          const j = JSON.parse(body);
          M.unfollows.push(String(j.handle).toLowerCase());
          if (M.users[String(j.handle).toLowerCase()]) M.users[String(j.handle).toLowerCase()].iFollow = false;
          return send(200, { ok: true });
        }
        const r = page(req.url);
        if (r.redirect) { res.writeHead(302, { location: r.redirect }); return res.end(); }
        return send(200, r.html, "text/html; charset=utf-8");
      } catch (e) {
        console.error("mock error", e);
        send(500, "mock error " + e.message, "text/plain");
      }
    });
  };

  let server = null;
  M.start = (port = 8443) => new Promise((resolve) => {
    ensureCert();
    server = https.createServer({ key: fs.readFileSync(path.join(DIR, "key.pem")), cert: fs.readFileSync(path.join(DIR, "cert.pem")) }, handler);
    server.listen(port, "127.0.0.1", resolve);
  });
  M.stop = () => new Promise((r) => (server ? server.close(() => r()) : r()));
  return M;
}
