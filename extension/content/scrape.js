// ScoreX content script - read posts, profiles and user lists from the rendered page.
// Output shapes are documented in lib/filters.js (Post) and lib/targets.js (profile).

(function () {
  "use strict";
  if (globalThis.SXScrape) return;
  const D = globalThis.SXDom;

  const HANDLE_RE = /^\/([A-Za-z0-9_]{1,15})\/?$/;
  const STATUS_RE = /^\/([A-Za-z0-9_]{1,15})\/status\/(\d{5,25})(?:\/|$|\?)/;

  // A quoted post is a role=link block that contains its own author header.
  function quoteContainer(el, article) {
    let n = el && el.parentElement;
    while (n && n !== article) {
      if (n.getAttribute && n.getAttribute("role") === "link" && D.q("tweetUserName", n)) return n;
      n = n.parentElement;
    }
    return null;
  }

  function permalink(article) {
    for (const time of D.qa("tweetTime", article)) {
      if (quoteContainer(time, article)) continue;
      const a = time.closest('a[href*="/status/"]');
      const m = a && (a.getAttribute("href") || "").match(STATUS_RE);
      if (m) return { handle: m[1].toLowerCase(), id: m[2], time };
      // focal tweet on a status page may render the time without a link
      if (!a) {
        const link = [...article.querySelectorAll('a[href*="/status/"]')].find((x) => !quoteContainer(x, article) && STATUS_RE.test(x.getAttribute("href") || ""));
        const mm = link && link.getAttribute("href").match(STATUS_RE);
        if (mm) return { handle: mm[1].toLowerCase(), id: mm[2], time };
      }
    }
    const link = [...article.querySelectorAll('a[href*="/status/"]')].find((x) => !quoteContainer(x, article) && STATUS_RE.test(x.getAttribute("href") || "") && !/\/(photo|video|analytics|retweets|likes|quotes)\b/.test(x.getAttribute("href")));
    const m = link && link.getAttribute("href").match(STATUS_RE);
    return m ? { handle: m[1].toLowerCase(), id: m[2], time: null } : null;
  }

  function metricFrom(el) {
    if (!el) return null;
    const label = el.getAttribute("aria-label") || "";
    const m = label.match(/([\d.,]+[KMB]?)/i);
    if (m) return D.parseCount(m[1]);
    const t = D.text(el);
    return t ? D.parseCount(t) : 0;
  }

  function metrics(article) {
    const group = D.qa("actionGroup", article).filter((g) => !quoteContainer(g, article)).pop();
    const out = { replies: null, reposts: null, likes: null, views: null };
    const label = group && group.getAttribute("aria-label");
    if (label) {
      const grab = (re) => { const m = label.match(re); return m ? D.parseCount(m[1]) : null; };
      out.replies = grab(/([\d.,]+[KMB]?)\s+repl/i);
      out.reposts = grab(/([\d.,]+[KMB]?)\s+(?:repost|retweet)/i);
      out.likes = grab(/([\d.,]+[KMB]?)\s+like/i);
      out.views = grab(/([\d.,]+[KMB]?)\s+view/i);
    }
    const root = group || article;
    if (out.replies == null) out.replies = metricFrom(D.q("replyButton", root)) || 0;
    if (out.reposts == null) out.reposts = metricFrom(D.q("retweetButton", root)) || 0;
    if (out.likes == null) out.likes = metricFrom(D.q("likeButton", root) || D.q("unlikeButton", root)) || 0;
    if (out.views == null) out.views = metricFrom(D.q("viewsLink", article));
    return out;
  }

  function isPromoted(article) {
    if (article.querySelector('[data-testid="placementTracking"]') && !D.q("tweetTime", article)) return true;
    const promoRe = D.re("promoted");
    for (const s of article.querySelectorAll("span")) {
      if (s.childElementCount) continue;
      if (D.closest(s, "tweetText")) continue;
      const t = (s.textContent || "").trim();
      if (t.length <= 12 && promoRe.test(t)) return true;
    }
    return false;
  }

  function isReplyPost(article) {
    const re = D.re("replyingTo");
    for (const d of article.querySelectorAll("div")) {
      if (d.childElementCount > 4) continue;
      if (D.closest(d, "tweetText") || quoteContainer(d, article)) continue;
      const t = (d.textContent || "").trim();
      if (t.length < 80 && re.test(t)) return true;
    }
    return false;
  }

  function parseTweet(article) {
    if (!article) return null;
    const pl = permalink(article);
    if (!pl) return null;
    const textEl = D.qa("tweetText", article).find((el) => !quoteContainer(el, article)) || null;
    const ctx = D.q("socialContext", article);
    const ctxText = D.text(ctx);
    const nameEl = D.qa("tweetUserName", article).find((el) => !quoteContainer(el, article));
    const nameLines = D.text(nameEl).split("\n").map((s) => s.trim()).filter(Boolean);
    const datetime = pl.time && pl.time.getAttribute("datetime");
    const links = textEl ? [...textEl.querySelectorAll("a[href]")].map((a) => a.getAttribute("href") || "").filter((h) => /^https?:\/\//.test(h) && !/^https?:\/\/(?:x|twitter)\.com\//.test(h)) : [];
    const repost = !!ctx && D.re("reposted").test(ctxText);
    // On a repost the permalink belongs to the original author; keep both.
    return {
      id: pl.id,
      url: `https://x.com/${pl.handle}/status/${pl.id}`,
      author: pl.handle,
      authorName: nameLines[0] && !nameLines[0].startsWith("@") ? nameLines[0] : "",
      text: textWithEmoji(textEl).slice(0, 4000),
      lang: textEl ? (textEl.getAttribute("lang") || "") : "",
      createdAt: datetime ? Date.parse(datetime) || null : null,
      isRepost: repost,
      repostedBy: repost ? ctxText.replace(D.re("reposted"), "").trim() : "",
      isPinned: !!ctx && D.re("pinned").test(ctxText),
      isPromoted: isPromoted(article),
      isReply: isReplyPost(article),
      isQuote: D.qa("tweetUserName", article).length > 1,
      hasMedia: !!D.q("tweetPhoto", article),
      hasCard: !!D.q("cardWrapper", article),
      links,
      liked: !!D.q("unlikeButton", article),
      metrics: metrics(article),
    };
  }

  // X renders emoji as <img alt="🔥"> inside the text; keep them so text comparisons work.
  function textWithEmoji(el) {
    if (!el) return "";
    if (!el.querySelector("img[alt]")) return D.text(el);
    const clone = el.cloneNode(true);
    clone.querySelectorAll("img[alt]").forEach((img) => img.replaceWith(document.createTextNode(img.getAttribute("alt") || "")));
    // innerText needs layout; the clone is detached, so use textContent and keep line breaks from <br>.
    clone.querySelectorAll("br").forEach((br) => br.replaceWith(document.createTextNode("\n")));
    return String(clone.textContent || "").replace(/\u00a0/g, " ").trim();
  }

  function articles(root) {
    const scope = root || D.q("primaryColumn") || document;
    return D.qa("tweet", scope);
  }

  function scrapeTweets(limit = 40) {
    const out = [];
    const seen = new Set();
    let unparsed = 0;
    for (const a of articles()) {
      const t = parseTweet(a);
      if (!t) { unparsed++; continue; }
      if (seen.has(t.id + (t.isRepost ? "r" : ""))) continue;
      seen.add(t.id + (t.isRepost ? "r" : ""));
      out.push(t);
      if (out.length >= limit) break;
    }
    return { tweets: out, articleCount: articles().length, unparsed };
  }

  function linkCount(primary, suffixKey, handle) {
    const links = D.qa(suffixKey, primary).filter((a) => {
      const h = (a.getAttribute("href") || "").toLowerCase();
      return h.startsWith("/" + handle + "/") && !D.closest(a, "userCell");
    });
    for (const a of links) {
      const n = D.parseCount((D.text(a).match(/[\d.,]+\s*[KMB]?/i) || [""])[0]);
      if (n != null) return n;
    }
    return null;
  }

  function relationButtons(primary) {
    const notInList = (b) => !D.closest(b, "userCell");
    const un = D.qa("unfollowBtnSuffix", primary).find(notInList) || null;
    const fo = D.qa("followBtnSuffix", primary).find(notInList) || null;
    const pend = D.qa("pendingBtnSuffix", primary).find(notInList) || null;
    const any = un || fo || pend;
    const idm = any && (any.getAttribute("data-testid") || "").match(/^(\d+)-/);
    return { un, fo, pend, userId: idm ? idm[1] : null };
  }

  // X's "Follows you" badge as plain text: the line right after "@handle" that is exactly the badge text (a bio
  // or display name that merely contains the words never counts).
  function badgeLineAfterHandle(lines, handle) {
    const at = lines.findIndex((l) => l.toLowerCase() === "@" + handle);
    return at >= 0 && at + 1 < lines.length && D.reExact("followsYou").test(lines[at + 1]);
  }

  // The profile header's "Follows you": only next to the profile's own name, never a badge from a "Who to
  // follow" / "You might like" user cell, a post or an overlay that is also in the primary column.
  function profileFollowsYou(primary, nameEl, handle) {
    const own = (b) => !D.closest(b, "userCell") && !D.closest(b, "tweet") && !D.closest(b, "dialog") && !D.closest(b, "knownOverlay");
    if (D.qaAll("followsYouBadge", primary).some(own)) return true;
    const lines = D.text(nameEl).split("\n").map((s) => s.trim()).filter(Boolean);
    return badgeLineAfterHandle(lines, handle);
  }

  function scrapeProfile() {
    const primary = D.q("primaryColumn") || document;
    const m = location.pathname.match(/^\/([A-Za-z0-9_]{1,15})(?:\/|$)/);
    const handle = m ? m[1].toLowerCase() : "";
    const nameEl = D.q("profileUserName", primary);
    if (!nameEl) return { profile: null, tweets: [] };
    const lines = D.text(nameEl).split("\n").map((s) => s.trim()).filter(Boolean);
    const joinText = D.text(D.q("profileJoinDate", primary)).replace(/^joined\s*/i, "");
    const joinedAt = joinText ? Date.parse("1 " + joinText) || null : null;
    const avatarImg = D.q("avatar", primary);
    const avatar = avatarImg ? avatarImg.getAttribute("src") || "" : "";
    const rb = relationButtons(primary);
    const profile = {
      handle,
      userId: rb.userId,
      name: lines[0] && !lines[0].startsWith("@") ? lines[0] : "",
      bio: D.text(D.q("profileBio", primary)).slice(0, 600),
      followers: linkCount(primary, "profileFollowers", handle),
      following: linkCount(primary, "profileFollowing", handle),
      verified: !!D.q("verifiedIcon", nameEl),
      protected: !!D.q("lockIcon", nameEl),
      followsYou: profileFollowsYou(primary, nameEl, handle),
      youFollow: rb.un ? true : rb.fo || rb.pend ? false : null,
      followPending: !!rb.pend,
      defaultAvatar: /default_profile/.test(avatar),
      avatar,
      joinedAt,
      location: "",
    };
    const items = D.q("profileHeaderItems", primary);
    if (items) {
      const loc = items.querySelector('[data-testid="UserLocation"]');
      if (loc) profile.location = D.text(loc).slice(0, 80);
    }
    const { tweets } = scrapeTweets(30);
    return { profile, tweets: tweets.filter((t) => t.author === handle) };
  }

  function scrapeUsers(limit = 200) {
    const users = [];
    const seen = new Set();
    for (const cell of D.qa("userCell", D.q("primaryColumn") || document)) {
      const link = [...cell.querySelectorAll("a[href]")].find((a) => HANDLE_RE.test(a.getAttribute("href") || ""));
      let handle = link ? link.getAttribute("href").match(HANDLE_RE)[1] : "";
      const lines = D.text(cell).split("\n").map((s) => s.trim()).filter(Boolean);
      if (!handle) { const at = lines.find((l) => /^@[A-Za-z0-9_]{1,15}$/.test(l)); if (at) handle = at.slice(1); }
      if (!handle) continue;
      handle = handle.toLowerCase();
      if (seen.has(handle)) continue;
      seen.add(handle);
      const atIdx = lines.findIndex((l) => l.toLowerCase() === "@" + handle);
      const bio = lines.slice(atIdx + 1).filter((l) => !/^(follows you|following|follow|click to follow.*)$/i.test(l)).join(" ").slice(0, 300);
      const btn = cell.querySelector('[data-testid$="-follow"], [data-testid$="-unfollow"], [data-testid$="-cancel"]');
      const st = btn ? (btn.getAttribute("data-testid").match(/-(follow|unfollow|cancel)$/) || [])[1] : null;
      const img = D.q("avatar", cell);
      // The badge element, or (if X renamed its testid) a line that is exactly the badge text right after the
      // handle. Words in a bio ("this account follows you back") never count: the followers-list scan uses
      // these hits as its proof that the badge still works.
      const badge = !!D.q("followsYouBadge", cell);
      users.push({
        handle,
        name: lines[0] && !lines[0].startsWith("@") ? lines[0] : "",
        bio,
        verified: !!D.q("verifiedIcon", cell),
        protected: !!D.q("lockIcon", cell),
        followsYou: badge || badgeLineAfterHandle(lines, handle),
        badge,
        youFollow: st === "unfollow" ? true : st ? false : null,
        defaultAvatar: img ? /default_profile/.test(img.getAttribute("src") || "") : false,
      });
      if (users.length >= limit) break;
    }
    return { users, cellCount: D.qa("userCell").length, badgeCells: users.filter((u) => u.badge).length };
  }

  // Status page: the focal post, whether replying is possible, and replies already in the thread.
  // Visible text of the primary column without any post bodies (for notices like "Who can reply?").
  function noticeText(primary) {
    const clone = primary.cloneNode(true);
    for (const sel of D.cfg().sel.tweet) { try { clone.querySelectorAll(sel).forEach((n) => n.remove()); } catch (_) {} }
    return String(clone.textContent || "").replace(/\s+/g, " ").slice(0, 5000);
  }

  // A section heading after the focal post ("Discover more", "More posts") ends the conversation:
  // posts below it are recommendations, not replies.
  function firstHeadingAfter(el, primary) {
    for (const h of primary.querySelectorAll('h2, [role="heading"]')) {
      if (D.closest(h, "tweet")) continue;
      if (el.compareDocumentPosition(h) & Node.DOCUMENT_POSITION_FOLLOWING) return h;
    }
    return null;
  }

  function scrapeStatus(tweetId, me) {
    const primary = D.q("primaryColumn") || document;
    const all = articles().map((a) => ({ a, t: parseTweet(a) })).filter((x) => x.t);
    const focalIdx = all.findIndex((x) => x.t.id === String(tweetId) && !x.t.isRepost);
    const focal = focalIdx >= 0 ? all[focalIdx].t : null;
    let after = focalIdx >= 0 ? all.slice(focalIdx + 1) : [];
    if (focalIdx >= 0) {
      const stop = firstHeadingAfter(all[focalIdx].a, primary);
      if (stop) after = after.filter((x) => x.a.compareDocumentPosition(stop) & Node.DOCUMENT_POSITION_FOLLOWING);
    }
    const replies = after.map((x) => x.t);
    const restricted = D.re("replyRestricted").test(noticeText(primary)) && !D.q("composerTextbox", primary);
    const myReplies = me ? replies.filter((r) => r.author === me) : [];
    // Parent posts rendered above the focal post mean it is itself a reply inside a thread.
    return { focal, focalIndex: focalIdx, replies: replies.slice(0, 30), canReply: !restricted, myReplies };
  }

  globalThis.SXScrape = { parseTweet, scrapeTweets, scrapeProfile, scrapeUsers, scrapeStatus, articles, relationButtons };
})();
