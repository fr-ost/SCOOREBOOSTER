# ScoreX blog: articles 1-5 (data for tools/build_blog.py). Bodies are plain HTML fragments.
# Rules for this content: no invented statistics, no promises of results, and X's rules described honestly.

POSTS_A = [
{
"slug": "what-is-twitterscore",
"title": "What Is TwitterScore? How the Score Works and Why It Matters",
"desc": "TwitterScore rates an X (Twitter) account from 0 to 1000 by who follows it. Here is what the score measures, what it ignores, and why crypto teams check it.",
"tag": "Scores",
"read": 6,
"keywords": "what is twitterscore, twitter score, twitterscore explained, influencer score",
"body": """
<p class="lede">TwitterScore is a third-party rating for X (Twitter) accounts. It gives every account a number from 0 to 1000, and that number is mostly about one thing: <strong>who follows you</strong>, not how many people do.</p>

<h2>The short answer</h2>
<p>A normal follower count treats every follower the same. TwitterScore does not. It looks at whether respected accounts in a niche (founders, funds, researchers, well-known builders and influencers, mostly in crypto and tech) follow you, and weighs those follows far more than anonymous ones. Two accounts with 10,000 followers can have very different scores.</p>

<h2>What the score measures</h2>
<ul>
  <li><strong>Quality of your followers.</strong> A follow from an account that itself has a high score counts for much more than a follow from a new or inactive account.</li>
  <li><strong>How many notable accounts follow you.</strong> These are often called <a href="/blog/smart-followers-explained">smart followers</a>. The site lists them on your profile page.</li>
  <li><strong>Standing inside a niche.</strong> The score was built around crypto Twitter, so it reflects reputation in that community better than general fame.</li>
</ul>
<p>TwitterScore does not publish its full formula, so treat any exact recipe you read online with caution. What is consistent across accounts is the pattern: gain follows from high-score accounts and your score rises; gain thousands of random followers and it barely moves.</p>

<h2>What the score ignores</h2>
<ul>
  <li><strong>Raw follower count.</strong> Bought or botted followers do not help, and a sudden wave of low-quality followers can make an account look worse to people checking it.</li>
  <li><strong>Likes and impressions on a single post.</strong> One viral post does not change who follows you.</li>
  <li><strong>How long you have had the account</strong>, on its own.</li>
</ul>

<h2>Why people check it</h2>
<p>In crypto and startup circles the score is used as a quick trust filter:</p>
<ul>
  <li><strong>Projects</strong> check it before choosing ambassadors, KOLs and whitelist winners.</li>
  <li><strong>Investors and founders</strong> glance at it before replying to a cold message.</li>
  <li><strong>Campaign platforms</strong> sometimes use influence scores to weight rewards.</li>
  <li><strong>You</strong> can use it to judge whether an account is worth your attention before you spend time on it.</li>
</ul>
<p>It is a signal, not a verdict. Plenty of thoughtful people have low scores because they are new, and a high score says nothing about whether someone is honest.</p>

<h2>What is a good TwitterScore?</h2>
<p>There is no official grading. As a rough guide from how people talk about it: accounts in the low double digits are effectively unknown, a few hundred means some notable accounts follow you, and scores above 500 belong to accounts most people in the niche already recognise. That is why ScoreX treats 500 as the line between its two target tiers.</p>

<h2>TwitterScore and other influence scores</h2>
<p>TwitterScore is not the only one. Sorsa (formerly TweetScout), Ethos and Moni publish their own scores with their own inputs. They often agree on who is influential and disagree on the exact ranking, so it helps to watch more than one. ScoreX can show your TwitterScore, Sorsa, Ethos and Moni scores side by side and track them over time.</p>

<h2>How to raise it</h2>
<p>Because the score follows your followers, the only durable way up is to earn follows from accounts that already score well. That means being visible and useful where they are: in the replies under their posts. We cover the practical steps in <a href="/blog/how-to-increase-twitterscore">How to Increase Your TwitterScore</a> and <a href="/blog/how-to-get-follow-backs-on-x">How to Get Follow-Backs From Bigger Accounts</a>.</p>
""",
"faq": [
 ("Is TwitterScore made by X?", "No. TwitterScore is an independent site. It reads public X data and is not affiliated with X Corp."),
 ("Does buying followers raise my TwitterScore?", "No. The score weighs who follows you, so low-quality or fake followers add little or nothing."),
 ("How often does TwitterScore update?", "The site refreshes accounts on its own schedule, so a new follow from a notable account may take a while to show. Checking once a day is enough."),
],
},
{
"slug": "how-to-increase-twitterscore",
"title": "How to Increase Your TwitterScore: 9 Things That Actually Move It",
"desc": "A practical guide to raising your TwitterScore: pick the right accounts, reply with substance, follow first, fix your profile and track what works.",
"tag": "Growth",
"read": 8,
"keywords": "how to increase twitterscore, raise twitter score, improve twitterscore, grow influencer score",
"body": """
<p class="lede">Your TwitterScore goes up when accounts that already have a high score follow you. Everything in this guide is about earning those follows honestly and repeatedly.</p>

<h2>1. Understand what moves the number</h2>
<p>The score is driven by <a href="/blog/smart-followers-explained">smart followers</a>: notable accounts in your niche. A hundred of them matter more than fifty thousand strangers. If a tactic does not lead to a respected account choosing to follow you, it will not move your score. See <a href="/blog/what-is-twitterscore">What Is TwitterScore?</a> for the background.</p>

<h2>2. Build a target list, not a wish list</h2>
<p>Write down the accounts you want to notice you. Good targets are active, post original thoughts, and still follow people back sometimes. Mix sizes: a few big names for reach, and many mid-sized accounts with real standing, because they notice replies and follow back more often.</p>

<h2>3. Check who is likely to follow back</h2>
<p>An account with 100,000 followers that follows 2,000 people almost never adds one more. An account with 8,000 followers that follows 3,000 does it every week. Look at the <a href="/blog/follower-to-following-ratio">follower-to-following ratio</a> before you invest effort. ScoreX skips accounts that follow under 5% of their followers for this reason.</p>

<h2>4. Reply early, and reply with something</h2>
<p>Replies are the one place a small account can sit next to a large one. Early replies get read by the author and by everyone who opens the post. But only if the reply adds something: a sharp question, an implication the post left out, an honest doubt, a concrete example. "Great post" is invisible. More on this in <a href="/blog/how-to-write-replies-that-get-answered">How to Write Replies That Authors Actually Answer</a>.</p>

<h2>5. Follow before you reply</h2>
<p>When an author sees a good reply, they often click the profile. If you already follow them, that small signal of interest is in place. It costs nothing and it removes one reason not to follow back.</p>

<h2>6. Make your profile worth following</h2>
<p>A reply earns the click. The profile earns the follow. In ten seconds a visitor should understand what you do and what they will get from following you:</p>
<ul>
  <li>A clear bio that says what you work on, without buzzwords.</li>
  <li>A pinned post that shows your best thinking.</li>
  <li>Recent posts of your own, so you are not only a replier.</li>
  <li>A real avatar and a banner that is not empty.</li>
</ul>

<h2>7. Answer when they answer</h2>
<p>If an author replies to you, that is the best moment to earn the follow. Answer what they said, briefly and directly. Do not let it sit for a day. ScoreX can draft or post these answers for you so a conversation never goes cold.</p>

<h2>8. Stay consistent for weeks</h2>
<p>One good reply rarely earns a follow. Being a familiar, useful name under someone's posts for two weeks often does. Decide how many replies you can sustain every day and keep that pace. Bursts followed by silence look like a campaign.</p>

<h2>9. Track follow-backs and adjust</h2>
<p>Keep a record of who followed back, after how many replies, and which kinds of reply came before it. Drop accounts that have not responded after a fair try, and add new ones. Over a month you will see which tiers and tones work for you. ScoreX keeps this record automatically, including each follower's TwitterScore.</p>

<h2>What does not work</h2>
<ul>
  <li><strong>Buying followers or engagement.</strong> It does not raise the score and it damages trust.</li>
  <li><strong>Follow-for-follow groups.</strong> The accounts in them rarely have scores worth having.</li>
  <li><strong>Mass generic replies.</strong> They get muted, and X limits accounts that behave like spam.</li>
</ul>

<h2>How long does it take?</h2>
<p>It depends on your niche, your profile and how well you write. Expect weeks, not days, and expect uneven progress: nothing for a while, then two or three notable follows close together. Nobody can promise a number, and you should be wary of anyone who does.</p>
""",
"faq": [
 ("What is the fastest way to increase TwitterScore?", "Earn follows from accounts that already have a high score. In practice that means consistent, specific replies under their posts and a profile that gives them a reason to follow."),
 ("Do likes and retweets raise my TwitterScore?", "Not directly. They help your posts get seen, which can lead to follows from notable accounts, and those follows are what move the score."),
 ("Can a tool raise my score for me?", "No tool can guarantee follows. A tool like ScoreX can make the daily work consistent and show you what is working; the follow is still the other person's decision."),
],
},
{
"slug": "smart-followers-explained",
"title": "Smart Followers on X: Who They Are and How to Earn Them",
"desc": "Smart followers are the notable accounts that follow you on X. Learn how to find them, why they matter for your score, and how to earn more of them.",
"tag": "Scores",
"read": 6,
"keywords": "smart followers, smart followers twitter, what are smart followers, twitterscore smart followers",
"body": """
<p class="lede">"Smart followers" is the name score sites give to the notable accounts that follow you: founders, investors, researchers, respected builders and established voices in a niche. They are the main input to influence scores like TwitterScore.</p>

<h2>What makes a follower "smart"</h2>
<p>There is no universal list. Each score site decides which accounts count, usually from their own reputation in the network: who follows them, how long they have been active, and how central they are to the niche. A venture fund, a protocol founder and a well-known analyst all tend to qualify. A brand-new account with a generated avatar does not.</p>

<h2>Why they matter more than follower count</h2>
<ul>
  <li><strong>They move your score.</strong> A follow from a high-score account is worth more than thousands of ordinary ones. See <a href="/blog/what-is-twitterscore">how TwitterScore works</a>.</li>
  <li><strong>They are a trust signal.</strong> People look at "followed by" before they decide whether to take you seriously.</li>
  <li><strong>They compound.</strong> When a notable account follows you, their followers start seeing your replies and posts more often, and some of them follow too.</li>
</ul>

<h2>How to see your smart followers</h2>
<p>On TwitterScore, your profile page lists the notable accounts that follow you and their scores. The free view shows a few; an account or API plan shows more. Sorsa and Moni have similar lists with different names. Looking at the same list for an account you admire tells you who is paying attention to them.</p>

<h2>Use other people's smart followers to find targets</h2>
<p>This is the most useful trick in the whole topic. Pick three or four accounts that are where you want to be in a year. Look at who their smart followers are. Those people:</p>
<ul>
  <li>are active in your niche,</li>
  <li>demonstrably follow accounts like the one you want to become,</li>
  <li>and are often mid-sized, which means they still read their replies.</li>
</ul>
<p>That list is your target list. ScoreX has a smart follower finder that scans accounts you name, merges the results, and lets you add the best ones as targets in one click.</p>

<h2>How to earn a smart follower</h2>
<ol>
  <li><strong>Be present under their posts.</strong> Reply within the first hour when you can.</li>
  <li><strong>Add something they would want to answer.</strong> A precise question beats a compliment. Examples are in <a href="/blog/how-to-write-replies-that-get-answered">our reply guide</a>.</li>
  <li><strong>Follow them first.</strong> It is a small courtesy that makes a follow-back more natural.</li>
  <li><strong>Have a profile that explains you.</strong> They will look before they follow.</li>
  <li><strong>Answer when they answer.</strong> A short, good exchange is where most follows come from.</li>
  <li><strong>Give it time.</strong> Familiarity over a couple of weeks does what one reply cannot.</li>
</ol>

<h2>Who not to chase</h2>
<p>Some notable accounts simply do not follow people back. You can usually tell from the <a href="/blog/follower-to-following-ratio">follower-to-following ratio</a>: an account following a tiny fraction of its followers has stopped adding new ones. Their posts are still worth replying to for reach, but do not measure yourself by whether they follow you.</p>

<h2>Keeping them</h2>
<p>Smart followers unfollow accounts that turn into noise. After someone notable follows you, the job changes from getting noticed to being worth the follow: post your own work, keep replies thoughtful, and do not start tagging them in everything.</p>
""",
"faq": [
 ("How many smart followers do I need?", "There is no threshold. Each one from a high-score account helps, and a few dozen genuine ones already separate you from most accounts your size."),
 ("Are smart followers the same on every score site?", "No. TwitterScore, Sorsa and Moni each keep their own list of notable accounts, so the counts differ."),
 ("Can I pay for smart followers?", "Not honestly. A follow that was bought is not a signal of anything, and services that claim to sell them should be avoided."),
],
},
{
"slug": "how-to-get-follow-backs-on-x",
"title": "How to Get Follow-Backs From Bigger Accounts on X",
"desc": "Why bigger accounts follow some repliers and ignore others, and a step-by-step routine for earning follow-backs on X without spamming.",
"tag": "Growth",
"read": 7,
"keywords": "how to get follow backs on twitter, get followed back on x, follow back strategy, get big accounts to follow you",
"body": """
<p class="lede">A follow-back from an account bigger than yours is a small decision made in a few seconds. This guide is about what happens in those seconds, and how to tilt them in your favour.</p>

<h2>Why bigger accounts follow someone back</h2>
<p>Ask people with large followings why they followed a small account and the answers repeat:</p>
<ul>
  <li><strong>"I kept seeing their replies and they were good."</strong> Familiarity plus quality.</li>
  <li><strong>"They asked something I wanted to answer."</strong> A conversation started.</li>
  <li><strong>"Their profile was clearly about the thing I care about."</strong> Relevance.</li>
  <li><strong>"People I respect follow them."</strong> Social proof, which is what <a href="/blog/smart-followers-explained">smart followers</a> are.</li>
</ul>
<p>None of these are about asking for a follow. Asking is the fastest way not to get one.</p>

<h2>Step 1: Choose accounts that can follow back</h2>
<p>Start with the <a href="/blog/follower-to-following-ratio">follower-to-following ratio</a>. Someone who follows 30% of their follower count is open to new people. Someone at 1% has closed the list. Also check that they post often and that their recent replies show them answering strangers.</p>

<h2>Step 2: Follow them, then show up</h2>
<p>Follow first. Then reply to their posts over several days. Turn on notifications for a handful of your top targets so you can be early; an early reply is read by the author far more often than the two-hundredth.</p>

<h2>Step 3: Make every reply answerable</h2>
<p>The reply has one job: give the author a reason to respond or to look at who wrote it. Four reliable shapes:</p>
<ul>
  <li><strong>A sharp question:</strong> "does this still hold when fees spike?"</li>
  <li><strong>An implication:</strong> "which means the small holders carry the risk first"</li>
  <li><strong>An honest doubt, with a reason:</strong> "fair, but only if liquidity stays after week one"</li>
  <li><strong>A concrete example</strong> from the same space.</li>
</ul>
<p>Avoid praise, restating the post, and empty reactions. Full examples are in <a href="/blog/how-to-write-replies-that-get-answered">How to Write Replies That Authors Actually Answer</a>.</p>

<h2>Step 4: Continue the conversation</h2>
<p>When they reply, answer the same day, on the point they made. Keep it short. Concede what is fair. This is where a name becomes a person, and it is the moment most follow-backs happen.</p>

<h2>Step 5: Be worth the click</h2>
<p>Before following, they open your profile. Make sure it shows what you work on, a pinned post with your best thinking, and recent original posts. A profile that is only replies looks like a growth account.</p>

<h2>Step 6: Know when to stop</h2>
<p>Give each account a fair window, around two weeks of regular, good replies. If nothing happens, move on without resentment and put that effort into someone new. ScoreX does this automatically: it counts the days from your first comment and retires targets that never follow back.</p>

<h2>Common mistakes</h2>
<ul>
  <li><strong>Replying to everything.</strong> Ten strong replies beat a hundred weak ones.</li>
  <li><strong>The same reply under different posts.</strong> People notice, and so does X.</li>
  <li><strong>Unfollowing right after they follow back.</strong> It gets noticed and it burns the relationship.</li>
  <li><strong>Arguing to get attention.</strong> You will get attention and no follow.</li>
</ul>

<h2>A realistic daily routine</h2>
<ol>
  <li>Check posts from your target list two or three times a day.</li>
  <li>Write 10 to 30 replies you would be happy to sign.</li>
  <li>Answer every reply you received.</li>
  <li>Once a week, review who followed back and refresh the list.</li>
</ol>
<p>That is the routine ScoreX runs for you, with every reply shown for approval first if you want it that way.</p>
""",
"faq": [
 ("Should I ask for a follow-back?", "No. Asking signals that the follow matters more to you than the conversation. Earn it with useful replies instead."),
 ("How long before someone follows back?", "It varies widely. Many follow-backs come within the first two weeks of consistent, good replies; some accounts never follow anyone new."),
 ("Is it okay to unfollow accounts that do not follow back?", "Yes, after a fair window. Do it gradually, and never unfollow someone right after they followed you."),
],
},
{
"slug": "reply-strategy-to-grow-on-x",
"title": "The Reply Strategy: How Small Accounts Grow on X by Replying",
"desc": "Replies put a small account in front of a large audience. Here is how the reply strategy works on X, how many replies to write, and how to avoid looking like spam.",
"tag": "Growth",
"read": 7,
"keywords": "reply guy strategy, grow on twitter by replying, x reply strategy, twitter growth replies",
"body": """
<p class="lede">If you have a few hundred followers, almost nobody sees your posts. Your replies are different: they appear under posts that thousands of people are already reading. That is the whole idea behind the reply strategy.</p>

<h2>Why replies work for small accounts</h2>
<ul>
  <li><strong>Borrowed reach.</strong> A reply under a post with 50,000 views is seen by people who have never heard of you.</li>
  <li><strong>Direct line to the author.</strong> Authors read their early replies. No other format puts your name in front of them.</li>
  <li><strong>Proof of thinking.</strong> A good reply shows how you think in one line, which is what makes someone click your profile.</li>
</ul>

<h2>The parts of a reply strategy</h2>
<h3>1. A list</h3>
<p>Pick the accounts whose audience and attention you want. Put them in an X list, or in a tool, so you see their posts without the rest of the timeline. Finding them is easier when you start from the <a href="/blog/smart-followers-explained">smart followers</a> of accounts you admire.</p>
<h3>2. Timing</h3>
<p>Early replies win. A reply in the first minutes sits near the top and gets read by the author. After a few hours you are one of hundreds. You do not need to be first; you need to be early enough to be seen.</p>
<h3>3. Substance</h3>
<p>The reply has to add something. A question, an implication, a doubt, an example. See <a href="/blog/how-to-write-replies-that-get-answered">the reply writing guide</a> for the patterns and examples.</p>
<h3>4. Volume you can sustain</h3>
<p>Most people who succeed with replies write somewhere between ten and a few dozen a day, every day. Quality falls apart well before the platform's limits do. Pick a number you can keep up for a month.</p>
<h3>5. Follow-through</h3>
<p>Answer the people who answer you. Follow the accounts you reply to. Keep your own profile alive with original posts, so the click has somewhere to land.</p>

<h2>What "reply guy" gets wrong</h2>
<p>The phrase is an insult for a reason. The stereotype replies to everything, instantly, with nothing to say. Authors mute those accounts and readers scroll past them. The difference between that and a useful regular is not how often you reply. It is whether each reply would be missed if it were gone.</p>

<h2>How X treats heavy repliers</h2>
<p>X limits accounts that behave like spam: many near-identical replies, replies at machine speed, replies with links, or bursts far above your normal activity. Staying safe is mostly common sense:</p>
<ul>
  <li>Never post the same text twice.</li>
  <li>Leave real gaps between replies and take breaks.</li>
  <li>Do not put links or hashtags in replies.</li>
  <li>Grow your daily volume gradually.</li>
</ul>
<p>We go deeper on this in <a href="/blog/is-automating-replies-on-x-safe">Is Automating Replies on X Safe?</a></p>

<h2>Measure the right thing</h2>
<p>Likes on a reply feel good and mean little. The numbers that matter are:</p>
<ul>
  <li><strong>Author replies:</strong> did the person you replied to respond?</li>
  <li><strong>Profile visits and follows</strong> from notable accounts.</li>
  <li><strong>Follow-backs</strong> from your target list, and how many replies each took.</li>
</ul>
<p>If you care about your <a href="/blog/what-is-twitterscore">TwitterScore</a>, follow-backs from high-score accounts are the only metric that moves it.</p>

<h2>Doing it by hand, and with help</h2>
<p>By hand, the strategy costs one to two hours a day: watching for posts, writing, tracking who responded. That is why most people stop after a week. ScoreX exists to take the routine parts off you. It watches your list, drafts replies in your voice, lets you approve each one, follows first, answers replies, and keeps the follow-back record, all inside your own browser.</p>
""",
"faq": [
 ("How many replies a day should I write?", "Start with 10 to 20 good ones and increase slowly. Consistency over weeks matters more than a big number on one day."),
 ("Do replies count as much as posts for growth?", "For small accounts replies usually bring more visibility than posts, because they appear in front of an existing audience. Keep posting your own content too."),
 ("Will replying a lot get my account limited?", "Not if the replies are varied, relevant and paced like a person. Repetitive or very fast replies are what trigger limits."),
],
},
]
