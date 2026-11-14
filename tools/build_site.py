#!/usr/bin/env python3
"""Builds the static pages of the ScoreX website (website/): the blog (index + articles), About, Contact, Support,
FAQ, and sitemap.xml. Run from the repository root:  python3 tools/build_site.py
The home page (index.html) and privacy.html are hand-written; everything this script writes is regenerated in full."""
import html, json, os, re, sys
sys.path.insert(0, os.path.dirname(__file__))
from blog_posts_a import POSTS_A
from blog_posts_b import POSTS_B

SITE = "https://scorex.uniquelabs.org"
STORE = "https://chromewebstore.google.com/detail/pckgdccdipdllagmieedopalgdoheklo"
MAIL = "contact@shahriarahmed.net"
OUT = os.path.join(os.path.dirname(__file__), "..", "website")
DATE = "2026-11-14"
DATE_TEXT = "November 14, 2026"
POSTS = POSTS_A + POSTS_B
esc = lambda s: html.escape(s, quote=True)

ORG = {"@type": "Organization", "name": "Unique Labs", "url": SITE + "/about", "logo": SITE + "/img/icon128.png", "email": MAIL}


def ld(obj):
    return '<script type="application/ld+json">' + json.dumps({"@context": "https://schema.org", **obj}, ensure_ascii=False).replace("</", "<\\/") + "</script>"


def page(path, title, desc, body, *, og_type="website", schema=(), keywords="", crumbs=()):
    url = SITE + path
    if crumbs:
        schema = list(schema) + [{"@type": "BreadcrumbList", "itemListElement": [
            {"@type": "ListItem", "position": i + 1, "name": n, "item": SITE + p} for i, (n, p) in enumerate(crumbs)]}]
    head = f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{esc(title)}</title>
  <meta name="description" content="{esc(desc)}">
  {f'<meta name="keywords" content="{esc(keywords)}">' if keywords else ''}
  <meta name="robots" content="index, follow, max-image-preview:large">
  <link rel="canonical" href="{url}">
  <meta property="og:site_name" content="ScoreX">
  <meta property="og:type" content="{og_type}">
  <meta property="og:title" content="{esc(title)}">
  <meta property="og:description" content="{esc(desc)}">
  <meta property="og:url" content="{url}">
  <meta property="og:image" content="{SITE}/img/og.png">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="{esc(title)}">
  <meta name="twitter:description" content="{esc(desc)}">
  <meta name="twitter:image" content="{SITE}/img/og.png">
  <meta name="theme-color" content="#faf8f3">
  <link rel="icon" type="image/png" sizes="32x32" href="/img/icon32.png">
  <link rel="apple-touch-icon" href="/img/icon128.png">
  <link rel="alternate" type="application/rss+xml" title="ScoreX Blog" href="/blog/feed.xml">
  <link rel="stylesheet" href="/styles.css">
  {''.join(ld(s) for s in schema)}
</head>
<body>
  <a class="skip" href="#main">Skip to content</a>
  <header class="nav">
    <div class="wrap nav-in">
      <a class="logo" href="/" aria-label="ScoreX home">Score<span class="x">X</span></a>
      <nav aria-label="Main">
        <a href="/#how">How it works</a>
        <a href="/#features">Features</a>
        <a href="/blog">Blog</a>
        <a href="/faq">FAQ</a>
        <a href="/support">Support</a>
      </nav>
      <a class="btn btn-primary btn-sm" href="{STORE}" target="_blank" rel="noopener">Add to Chrome</a>
    </div>
  </header>
  <main id="main">
"""
    foot = f"""
  </main>
  <footer class="foot">
    <div class="wrap foot-in">
      <div><a class="logo" href="/">Score<span class="x">X</span></a><p>A product of Unique Labs. Developed by Shahriar Ahmed.</p></div>
      <nav aria-label="Footer">
        <a href="/blog">Blog</a>
        <a href="/about">About</a>
        <a href="/faq">FAQ</a>
        <a href="/support">Support</a>
        <a href="/contact">Contact</a>
        <a href="/privacy">Privacy policy</a>
        <a href="{STORE}" target="_blank" rel="noopener">Chrome Web Store</a>
      </nav>
    </div>
    <p class="wrap legal">ScoreX is not affiliated with or endorsed by X Corp., OpenAI, TwitterScore or any score site.</p>
  </footer>
</body>
</html>
"""
    return head + body + foot


def write(rel, text):
    p = os.path.join(OUT, rel)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w", encoding="utf-8") as f:
        f.write(text)


def crumbs_html(items):
    parts = [f'<a href="{p}">{esc(n)}</a>' for n, p in items[:-1]] + [f'<span aria-current="page">{esc(items[-1][0])}</span>']
    return '<nav class="crumbs" aria-label="Breadcrumb">' + ' <span aria-hidden="true">/</span> '.join(parts) + '</nav>'


def faq_html(faq, heading="Frequently asked questions"):
    items = "".join(f"<details><summary>{esc(q)}</summary><p>{a}</p></details>" for q, a in faq)
    return f'<section class="post-faq"><h2>{esc(heading)}</h2><div class="faq">{items}</div></section>'


def faq_schema(faq):
    strip = lambda s: re.sub(r"<[^>]+>", "", s)
    return {"@type": "FAQPage", "mainEntity": [{"@type": "Question", "name": q, "acceptedAnswer": {"@type": "Answer", "text": strip(a)}} for q, a in faq]}


CTA = f"""<aside class="post-cta">
  <h2>Put this on autopilot, with you in control</h2>
  <p>ScoreX is a Chrome extension that watches the accounts you choose, drafts replies in your voice, follows first, answers replies and tracks every follow-back. Review mode is on by default. Invite only for now.</p>
  <p class="cta-row"><a class="btn btn-primary" href="{STORE}" target="_blank" rel="noopener">Add to Chrome</a> <a class="btn" href="/#invite">Request an invite</a></p>
</aside>"""


def build_blog():
    by_slug = {p["slug"]: p for p in POSTS}
    for i, p in enumerate(POSTS):
        path = f"/blog/{p['slug']}"
        related = [POSTS[(i + k) % len(POSTS)] for k in (1, 2, 3)]
        rel_html = "".join(f'<li><a href="/blog/{r["slug"]}">{esc(r["title"])}</a></li>' for r in related)
        words = len(re.sub(r"<[^>]+>", " ", p["body"]).split())
        cr = [("Home", "/"), ("Blog", "/blog"), (p["title"], path)]
        body = f"""    <article class="post wrap">
      {crumbs_html(cr)}
      <header class="post-head">
        <p class="cap">{esc(p['tag'])}</p>
        <h1>{esc(p['title'])}</h1>
        <p class="post-meta">By <a href="/about">Unique Labs</a> · <time datetime="{DATE}">{DATE_TEXT}</time> · {p['read']} min read</p>
      </header>
      <div class="post-body">{p['body']}
      {faq_html(p['faq'])}
      {CTA}
      <section class="post-related"><h2>Keep reading</h2><ul>{rel_html}</ul></section>
      </div>
    </article>"""
        schema = [{"@type": "BlogPosting", "headline": p["title"], "description": p["desc"], "datePublished": DATE, "dateModified": DATE,
                   "author": ORG, "publisher": ORG, "mainEntityOfPage": SITE + path, "image": SITE + "/img/og.png",
                   "articleSection": p["tag"], "wordCount": words, "inLanguage": "en"}, faq_schema(p["faq"])]
        write(f"blog/{p['slug']}.html", page(path, p["title"] + (" | ScoreX" if len(p["title"]) <= 51 else ""), p["desc"], body, og_type="article", schema=schema, keywords=p["keywords"], crumbs=cr))
    assert len(by_slug) == len(POSTS)
    # every internal /blog/ link must exist
    for p in POSTS:
        for s in re.findall(r'href="/blog/([a-z0-9-]+)"', p["body"]):
            assert s in by_slug, f"broken link in {p['slug']}: {s}"

    cards = "".join(f"""<a class="blog-card" href="/blog/{p['slug']}">
        <span class="cap">{esc(p['tag'])}</span>
        <h2>{esc(p['title'])}</h2>
        <p>{esc(p['desc'])}</p>
        <span class="post-meta">{p['read']} min read</span>
      </a>""" for p in POSTS)
    cr = [("Home", "/"), ("Blog", "/blog")]
    body = f"""    <section class="wrap page-head">
      {crumbs_html(cr)}
      <h1>ScoreX Blog</h1>
      <p class="lead left">Practical guides to growing on X (Twitter): influence scores, smart followers, replies that get answered, and doing it safely.</p>
    </section>
    <section class="wrap blog-grid">{cards}</section>
    <section class="wrap">{CTA}</section>"""
    schema = [{"@type": "Blog", "name": "ScoreX Blog", "url": SITE + "/blog", "publisher": ORG,
               "blogPost": [{"@type": "BlogPosting", "headline": p["title"], "url": f"{SITE}/blog/{p['slug']}", "datePublished": DATE} for p in POSTS]}]
    write("blog/index.html", page("/blog", "ScoreX Blog: Grow Your Influence Score on X (Twitter)", "Guides on TwitterScore, smart followers, follow-backs, reply strategy and safe automation on X (Twitter), from the team behind ScoreX.", body, schema=schema, crumbs=cr))

    items = "".join(f"<item><title>{esc(p['title'])}</title><link>{SITE}/blog/{p['slug']}</link><guid>{SITE}/blog/{p['slug']}</guid><description>{esc(p['desc'])}</description><pubDate>Sat, 14 Nov 2026 08:00:00 GMT</pubDate></item>" for p in POSTS)
    write("blog/feed.xml", f'<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"><channel><title>ScoreX Blog</title><link>{SITE}/blog</link><description>Guides to growing your influence score on X (Twitter).</description><language>en</language>{items}</channel></rss>\n')


FAQ = [
 ("What is ScoreX?", "ScoreX is a Chrome extension that helps you grow your influencer score on X (Twitter). It watches the accounts you choose, drafts replies in your voice, follows them first, answers their replies and tracks who follows you back."),
 ("How do I get access?", f'Install ScoreX from the <a href="{STORE}" target="_blank" rel="noopener">Chrome Web Store</a>, then enter the license key from your invite. ScoreX is invite only for now; <a href="/contact">request an invite</a> if you do not have a key.'),
 ("Do you need my X password?", "No. ScoreX works inside the X tab you are already logged in to. It never asks for, sees or stores your password."),
 ("What does it cost to run?", "Replies are written with your own OpenAI API key, so you pay OpenAI directly, usually a fraction of a cent per reply. ScoreX shows the real cost per reply and lets you set a monthly budget."),
 ("Will it post without me?", "Only if you switch to Full auto. In Review mode, which is the default, nothing is posted until you approve it."),
 ("Does ScoreX guarantee follow-backs or a higher TwitterScore?", "No. It makes consistent, relevant replies easy and shows you what works. Whether an account follows back is always their decision."),
 ("Is it safe for my X account?", 'Any automation carries some risk, and you are responsible for following X\'s rules. ScoreX is built to reduce that risk: review mode, hard daily limits, human pacing, no duplicate replies, and it stops on X warnings. Read <a href="/blog/is-automating-replies-on-x-safe">our honest guide to automation safety</a>.'),
 ("Where is my data stored?", 'In your browser. Post text goes to OpenAI to write replies, score sites are contacted only if you turn them on, and the license server only checks your key. See the <a href="/privacy">privacy policy</a>.'),
 ("Which scores does ScoreX track?", "TwitterScore, Sorsa, Ethos and Moni. Each is optional and off until you turn it on."),
 ("Does it follow people for me?", "Yes, if you leave Follow first on. ScoreX follows an account before replying to it and confirms on the profile that X kept the follow. There is a daily follow limit you can lower."),
 ("What happens when someone replies to my comment?", "ScoreX can write an answer from the whole thread. In Full auto it posts it; in Review mode it waits for your approval. It never replies to insults, and after two answers the conversation is left to you."),
 ("Which accounts does it skip?", "Accounts that already follow you, accounts that follow very few people for their size (they rarely follow back), and posts that are ads, giveaways, political, or have restricted replies."),
 ("Can I use it on more than one X account?", "A license key works on one browser installation. ScoreX acts as the account that is logged in to X in that browser and checks it has not changed."),
 ("Does it work in browsers other than Chrome?", "ScoreX is built and tested for Google Chrome on desktop. Other Chromium browsers may work but are not supported."),
 ("How do I stop it?", "Press Pause or Stop in the ScoreX dashboard or popup at any time. Removing the extension deletes everything it stored on your device."),
]


def build_pages():
    # FAQ
    cr = [("Home", "/"), ("FAQ", "/faq")]
    items = "".join(f"<details><summary>{esc(q)}</summary><p>{a}</p></details>" for q, a in FAQ)
    body = f"""    <section class="wrap page-head">
      {crumbs_html(cr)}
      <h1>Frequently asked questions</h1>
      <p class="lead left">Answers about access, cost, safety and how ScoreX works. Still stuck? See <a href="/support">Support</a> or <a href="/contact">contact us</a>.</p>
    </section>
    <section class="wrap"><div class="faq">{items}</div></section>
    <section class="wrap">{CTA}</section>"""
    write("faq.html", page("/faq", "ScoreX FAQ: Access, Cost, Safety and How It Works", "Answers to common questions about ScoreX, the Chrome extension for growing your influencer score on X: invites, cost, safety, data and features.", body, schema=[faq_schema(FAQ)], crumbs=cr))

    # About
    cr = [("Home", "/"), ("About", "/about")]
    body = f"""    <section class="wrap page-head">
      {crumbs_html(cr)}
      <h1>About ScoreX</h1>
      <p class="lead left">ScoreX is built by Unique Labs to make one hard, repetitive job on X manageable: earning the attention of the accounts that matter.</p>
    </section>
    <section class="wrap prose">
      <h2>Why we built it</h2>
      <p>On X, and especially on Crypto Twitter, who follows you matters more than how many do. Influence scores such as TwitterScore measure exactly that. The honest way to raise them is to show up under the right people's posts every day with replies worth answering, and to keep it up for weeks. Done by hand, that is one to two hours a day of watching, writing and tracking. Most people stop after a week.</p>
      <p>ScoreX does the routine parts: it watches your list, drafts replies in your voice, follows first, answers replies and records every follow-back. You stay in charge of what is posted.</p>
      <h2>What we believe</h2>
      <ul>
        <li><strong>You stay in control.</strong> Review mode is the default. Nothing posts until you approve it, unless you choose otherwise.</li>
        <li><strong>Your account, your browser.</strong> ScoreX runs in your own logged-in X tab. It never asks for your password, and your data stays on your device.</li>
        <li><strong>Careful by default.</strong> Hard daily limits, human pacing, skip rules, and a full stop on any warning from X.</li>
        <li><strong>Honest about limits.</strong> No tool can promise follow-backs or a score, and automation always carries some risk. We say so plainly.</li>
        <li><strong>Quality over volume.</strong> One reply an author wants to answer beats a hundred that get scrolled past.</li>
      </ul>
      <h2>Who is behind it</h2>
      <p>ScoreX is a product of <strong>Unique Labs</strong> and is developed by <strong>Shahriar Ahmed</strong>. It is currently in invite-only early access while we work with a small group of users; a public release will follow.</p>
      <h2>Independence</h2>
      <p>ScoreX is not affiliated with or endorsed by X Corp., OpenAI, TwitterScore, Sorsa, Ethos or Moni. It reads public information from those services at your request, with your own keys where needed.</p>
      <h2>Get in touch</h2>
      <p>Questions, feedback or an invite request: <a href="/contact">contact us</a>. For help using ScoreX, see <a href="/support">Support</a> and the <a href="/faq">FAQ</a>. Our guides are on the <a href="/blog">blog</a>.</p>
    </section>
    <section class="wrap">{CTA}</section>"""
    schema = [{"@type": "AboutPage", "name": "About ScoreX", "url": SITE + "/about", "mainEntity": {**ORG, "founder": {"@type": "Person", "name": "Shahriar Ahmed"}}}]
    write("about.html", page("/about", "About ScoreX: Built by Unique Labs", "ScoreX is a Chrome extension by Unique Labs, developed by Shahriar Ahmed, that helps you earn follow-backs from smart accounts on X with you in control.", body, schema=schema, crumbs=cr))

    # Contact
    cr = [("Home", "/"), ("Contact", "/contact")]
    sub_inv = "mailto:" + MAIL + "?subject=ScoreX%20invite%20request&amp;body=My%20X%20handle%3A%20%40%0AWhat%20I%20do%3A%20"
    sub_sup = "mailto:" + MAIL + "?subject=ScoreX%20support&amp;body=ScoreX%20version%3A%20%0AWhat%20happened%3A%20%0AWhat%20I%20expected%3A%20"
    body = f"""    <section class="wrap page-head">
      {crumbs_html(cr)}
      <h1>Contact</h1>
      <p class="lead left">The fastest way to reach us is email. We read every message.</p>
    </section>
    <section class="wrap grid3 contact-grid">
      <div class="card"><h2>Request an invite</h2><p>Tell us your X handle and what you are building. We add people in small groups.</p><p><a class="btn btn-primary" href="{sub_inv}">Request an invite</a></p></div>
      <div class="card"><h2>Get help</h2><p>Something not working? Check <a href="/support">Support</a> first, then email us with the details listed there.</p><p><a class="btn" href="{sub_sup}">Email support</a></p></div>
      <div class="card"><h2>Everything else</h2><p>Feedback, partnerships, press or a privacy request, such as deleting your license record.</p><p><a class="btn" href="mailto:{MAIL}">{MAIL}</a></p></div>
    </section>
    <section class="wrap prose">
      <h2>Before you write</h2>
      <ul>
        <li>Never send us your X password, your OpenAI API key or other secrets. We will never ask for them.</li>
        <li>For a license problem, include the last four characters of your key, not the whole key.</li>
        <li>For a bug, the redacted report from <strong>Settings &gt; General &gt; Diagnostics &gt; Copy report</strong> helps us most. It contains no keys.</li>
      </ul>
      <p>ScoreX is made by Unique Labs and developed by Shahriar Ahmed. More on the <a href="/about">About</a> page.</p>
    </section>"""
    schema = [{"@type": "ContactPage", "name": "Contact ScoreX", "url": SITE + "/contact", "mainEntity": {**ORG, "contactPoint": {"@type": "ContactPoint", "email": MAIL, "contactType": "customer support", "availableLanguage": "English"}}}]
    write("contact.html", page("/contact", "Contact ScoreX: Invites, Support and Feedback", "Contact the ScoreX team at Unique Labs to request an invite, get help with the Chrome extension, send feedback or make a privacy request.", body, schema=schema, crumbs=cr))

    # Support
    cr = [("Home", "/"), ("Support", "/support")]
    steps = [
        ("Install", f'Add ScoreX from the <a href="{STORE}" target="_blank" rel="noopener">Chrome Web Store</a> and pin it to your toolbar.'),
        ("Activate", "Click the ScoreX icon, choose Open dashboard, paste your license key and press Activate."),
        ("Set your handle", "In Settings &gt; General, enter the X handle you are logged in with. ScoreX checks it before every action."),
        ("Add your OpenAI key", "In Settings &gt; Models &amp; costs, paste your OpenAI API key. It is stored only in your browser."),
        ("Add targets", "On Targets, paste usernames or import a CSV. A file with TwitterScores sorts accounts into Tier 1 and Tier 2 for you."),
        ("Start", "Press Start on Today. In Review mode, drafts appear under Review for you to approve, edit or skip."),
    ]
    steps_html = "".join(f'<li><span class="n">{i + 1}</span><h3>{t}</h3><p>{d}</p></li>' for i, (t, d) in enumerate(steps))
    trouble = [
        ("My license key is not accepted", "Check for missing characters and that you are online. A key works on one browser installation; if you moved to a new computer, contact us to release it."),
        ("ScoreX stopped and shows a safety alert", "X showed a captcha, a rate limit or an unusual-activity warning. Open x.com, deal with what X asks, then press Review stop in ScoreX and resume. Consider lower daily limits."),
        ("No replies are being drafted", "Make sure the engine is Running, your OpenAI key is saved, and your targets show as Commenting. New targets are checked first; accounts that already follow you or follow very few people are skipped by design."),
        ("It is not following accounts before replying", "Follow first is on by default in Targets &gt; Edit rules. Run the Live X test in Settings &gt; General &gt; Diagnostics; the Follow button row tells you whether ScoreX can see the button on a profile."),
        ("A reply failed or was skipped", "Open History and click the row: the reason is shown. Common ones are restricted replies, a post that is no longer fresh, or a daily limit."),
        ("My replies get very few views", "ScoreX shows a reach alert when views drop sharply. Pause for a day or two, lower your limits, and review replies by hand for a while."),
        ("The X tab keeps closing or reloading", "ScoreX uses one pinned X tab. Leave it open; it is reopened if closed. If X shows no posts in a background tab, switch the worker tab to a separate window in Settings."),
        ("How do I move my data to another computer?", "Use Settings &gt; General &gt; Backup to export, then import on the other computer. API keys are never exported; add them again."),
    ]
    tr_html = "".join(f"<details><summary>{esc(q)}</summary><p>{a}</p></details>" for q, a in trouble)
    body = f"""    <section class="wrap page-head">
      {crumbs_html(cr)}
      <h1>Support</h1>
      <p class="lead left">Set-up steps, fixes for common problems, and how to reach us.</p>
    </section>
    <section class="wrap sec-tight"><h2>Get started in six steps</h2><ol class="steps steps-3">{steps_html}</ol></section>
    <section class="wrap sec-tight"><h2>Troubleshooting</h2><div class="faq">{tr_html}</div></section>
    <section class="wrap prose sec-tight">
      <h2>Check ScoreX yourself</h2>
      <p><strong>Settings &gt; General &gt; Diagnostics</strong> runs a quick check and a live X test that only reads pages. It tells you which part is failing and offers a redacted report you can copy.</p>
      <h2>Contact support</h2>
      <p>Email <a href="mailto:{MAIL}?subject=ScoreX%20support">{MAIL}</a> with:</p>
      <ul>
        <li>your ScoreX version (bottom left of the dashboard),</li>
        <li>what happened and what you expected,</li>
        <li>the redacted Diagnostics report, if you can.</li>
      </ul>
      <p>Please do not send passwords or API keys. More answers are in the <a href="/faq">FAQ</a>.</p>
    </section>"""
    schema = [faq_schema(trouble), {"@type": "HowTo", "name": "How to set up ScoreX", "step": [{"@type": "HowToStep", "name": t, "text": re.sub(r"<[^>]+>", "", html.unescape(d))} for t, d in steps]}]
    write("support.html", page("/support", "ScoreX Support: Setup Guide and Troubleshooting", "Set up ScoreX in six steps and fix common problems: license keys, safety stops, missing drafts, follow first, failed replies and low reach.", body, schema=schema, crumbs=cr))


def build_sitemap():
    urls = [("/", "1.0", "weekly"), ("/blog", "0.9", "weekly")] + [(f"/blog/{p['slug']}", "0.8", "monthly") for p in POSTS] + \
           [("/faq", "0.7", "monthly"), ("/support", "0.6", "monthly"), ("/about", "0.5", "monthly"), ("/contact", "0.5", "yearly"), ("/privacy", "0.3", "yearly")]
    body = "".join(f"  <url>\n    <loc>{SITE}{u}</loc>\n    <lastmod>{DATE}</lastmod>\n    <changefreq>{c}</changefreq>\n    <priority>{pr}</priority>\n  </url>\n" for u, pr, c in urls)
    write("sitemap.xml", f'<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n{body}</urlset>\n')
    return len(urls)


if __name__ == "__main__":
    build_blog()
    build_pages()
    n = build_sitemap()
    print(f"built {len(POSTS)} articles, blog index, feed, faq, about, contact, support; sitemap has {n} URLs")
