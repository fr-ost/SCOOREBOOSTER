# ScoreX blog: articles 6-10 (data for tools/build_blog.py). Same rules as blog_posts_a.py.

POSTS_B = [
{
"slug": "how-to-write-replies-that-get-answered",
"title": "How to Write Replies That Authors Actually Answer (With Examples)",
"desc": "Six reply patterns that get answers on X, with before-and-after examples, plus the phrases that make a reply invisible.",
"tag": "Writing",
"read": 7,
"keywords": "how to write twitter replies, good twitter replies examples, replies that get engagement, how to reply on x",
"body": """
<p class="lede">An author scrolling their replies decides in a second whether yours is worth a response. Replies that get answered share one trait: they give the author something to do.</p>

<h2>The test</h2>
<p>Before posting, ask: <strong>could the author answer this in one line, and would they want to?</strong> If the only possible response is "thanks", the reply is decoration.</p>

<h2>Six patterns that work</h2>

<h3>1. The sharp question</h3>
<p>Ask about the mechanism or the edge case, not about the author.</p>
<ul class="ex">
  <li class="bad">Great thread! What do you think about the future?</li>
  <li class="good">does this still work once the incentives end, or is that the cliff</li>
</ul>

<h3>2. The implication</h3>
<p>Say what follows from their point that they did not spell out.</p>
<ul class="ex">
  <li class="bad">So true, this is huge.</li>
  <li class="good">which means the teams with distribution win even with the worse product</li>
</ul>

<h3>3. The honest doubt</h3>
<p>Disagree a little, with a reason, in a friendly tone. Authors answer doubts far more often than agreement.</p>
<ul class="ex">
  <li class="bad">I disagree.</li>
  <li class="good">fair, but doesnt this only hold if liquidity sticks around after the first week</li>
</ul>

<h3>4. The concrete example</h3>
<p>Tie the point to a case everyone in the niche knows. Do not invent numbers or events.</p>
<ul class="ex">
  <li class="bad">This reminds me of many projects.</li>
  <li class="good">same thing happened with app chains, nobody cared until the fees did</li>
</ul>

<h3>5. The practical next step</h3>
<p>Say what someone acting on the post should do first.</p>
<ul class="ex">
  <li class="bad">Very useful, thanks for sharing.</li>
  <li class="good">the first thing to fix here is onboarding, everything after that is noise until it works</li>
</ul>

<h3>6. The sharper restatement</h3>
<p>Say their point in a more quotable way, with your own twist. Use sparingly; it is the easiest to do badly.</p>
<ul class="ex">
  <li class="bad">Exactly, well said.</li>
  <li class="good">boring infra wins quietly, then all at once</li>
</ul>

<h2>Phrases that make a reply invisible</h2>
<p>These read as filler or as a bot, and many authors skim past anything that starts with them:</p>
<ul>
  <li>"Great post", "well said", "this is huge", "love this", "so true"</li>
  <li>"Sounds like", "seems like", "looks like"</li>
  <li>"Curious to see how this plays out", "excited to see"</li>
  <li>"Thanks for sharing", "very insightful", "game changer"</li>
</ul>
<p>ScoreX blocks these phrases outright and rewrites any draft that contains them.</p>

<h2>Format and tone</h2>
<ul>
  <li><strong>One thought.</strong> Twelve to twenty-five words is usually right. A paragraph under someone else's post is a post of your own in the wrong place.</li>
  <li><strong>Plain and casual.</strong> Lowercase and loose punctuation are fine on X. Corporate polish is not.</li>
  <li><strong>No links, no hashtags, no tagging others.</strong> They look like promotion and X treats them with suspicion in replies.</li>
  <li><strong>Peer to peer.</strong> No flattery, no "sir", no asking for a follow.</li>
  <li><strong>Same language as the post.</strong></li>
</ul>

<h2>When they answer you</h2>
<p>Keep it going with one short message on what they said. If they asked a question, answer it plainly. If they corrected you, take it well. Do not restart the topic or repeat your first reply. Two good exchanges are worth more than ten first replies, and they are where <a href="/blog/how-to-get-follow-backs-on-x">follow-backs</a> happen.</p>

<h2>When not to reply</h2>
<ul>
  <li>Posts about a death, a tragedy or personal bad news, unless you know the person.</li>
  <li>Political fights. They attract the wrong attention.</li>
  <li>Giveaways and engagement bait.</li>
  <li>Posts where you have nothing to add. Skipping is a skill.</li>
</ul>

<h2>Using AI without losing your voice</h2>
<p>AI is good at speed and bad at taste by default. If you use it, give it your own voice, forbid the filler phrases above, and read what it writes. We cover the details in <a href="/blog/ai-replies-on-x-without-sounding-like-a-bot">AI Replies on X: How to Use AI Without Sounding Like a Bot</a>.</p>
""",
"faq": [
 ("How long should a reply on X be?", "One thought, usually 12 to 25 words. Short enough to read at a glance, long enough to say something specific."),
 ("Is it okay to disagree with a big account?", "Yes, if you give a reason and stay friendly. A thoughtful doubt gets more answers than agreement does."),
 ("Should I use emojis in replies?", "Rarely. One fitting emoji now and then is fine; rockets, sparkles and hundred-point signs read as promotion."),
],
},
{
"slug": "crypto-twitter-growth-guide",
"title": "Crypto Twitter Growth Guide for Small Accounts",
"desc": "How to grow on Crypto Twitter from a small account: pick a lane, find the right people, reply well, earn smart followers and avoid the traps.",
"tag": "Crypto",
"read": 8,
"keywords": "crypto twitter growth, grow on crypto twitter, ct growth guide, crypto twitter small account",
"body": """
<p class="lede">Crypto Twitter (CT) runs on reputation. Who follows you opens doors that follower count never will: early access, ambassador roles, honest answers from founders. This guide is for accounts starting small.</p>

<h2>How CT is different</h2>
<ul>
  <li><strong>It is a small town.</strong> A few thousand accounts set the conversation, and they notice who shows up consistently.</li>
  <li><strong>Reputation is measured.</strong> Projects check influence scores like <a href="/blog/what-is-twitterscore">TwitterScore</a> before choosing collaborators.</li>
  <li><strong>Trust is fragile.</strong> One shilled scam can undo a year of good posts.</li>
</ul>

<h2>Step 1: Pick a lane</h2>
<p>"Crypto" is too wide. Choose something you can be specific about: a chain, DeFi mechanics, on-chain data, security, a single ecosystem, memecoin culture, regulation. People follow accounts they can describe in one sentence.</p>

<h2>Step 2: Set up a profile that passes the ten-second test</h2>
<ul>
  <li>Bio: what you look at and why you are worth reading. No "DYOR | NFA | WAGMI" lists.</li>
  <li>Pinned post: your best original piece of thinking.</li>
  <li>A consistent avatar. People recognise the picture before the name.</li>
</ul>

<h2>Step 3: Find the right 100 people</h2>
<p>Do not start from the biggest names. Start from the <a href="/blog/smart-followers-explained">smart followers</a> of two or three accounts you respect in your lane. They are the active middle of the community: big enough to matter, small enough to read replies. Check each one's <a href="/blog/follower-to-following-ratio">follower-to-following ratio</a> so you spend effort on people who still follow back.</p>

<h2>Step 4: Live in the replies</h2>
<p>For a small account, replies are the product. Be early under posts from your list and add something: a question about the mechanism, a risk they did not mention, an example. The method is in <a href="/blog/reply-strategy-to-grow-on-x">The Reply Strategy</a> and the wording in <a href="/blog/how-to-write-replies-that-get-answered">How to Write Replies That Authors Actually Answer</a>.</p>

<h2>Step 5: Post your own work twice a week</h2>
<p>Replies bring visitors; your posts convince them. Good formats for small accounts:</p>
<ul>
  <li>One chart or one transaction, explained.</li>
  <li>A short thread on how something actually works.</li>
  <li>What you got wrong last month and what you learned.</li>
  <li>A clear summary of a governance proposal or a long report.</li>
</ul>

<h2>Step 6: Protect your reputation</h2>
<ul>
  <li><strong>Do not shill what you have not checked.</strong> Say when you hold something.</li>
  <li><strong>Disclose paid posts.</strong> Hidden promotion is found out sooner or later.</li>
  <li><strong>Never post or click wallet-drainer links</strong>, and be suspicious of DMs offering paid collaborations to tiny accounts.</li>
  <li><strong>Stay out of pile-ons.</strong> They bring followers you do not want.</li>
</ul>

<h2>Step 7: Track what matters</h2>
<p>Weekly, look at three things: which notable accounts followed you, which replies got an answer from the author, and how your score moved. Ignore impressions on single posts. If you want this recorded automatically, ScoreX keeps a follow-back log with each account's TwitterScore and charts your scores over time.</p>

<h2>Traps to avoid</h2>
<ul>
  <li><strong>Engagement pods and follow-for-follow.</strong> They inflate numbers nobody respects.</li>
  <li><strong>Buying followers.</strong> It does not move influence scores and it is visible to anyone who looks.</li>
  <li><strong>Copy-paste replies under every post.</strong> You will be muted, and X limits accounts that do it. See <a href="/blog/is-automating-replies-on-x-safe">automation safety</a>.</li>
  <li><strong>Chasing airdrop farms.</strong> A reputation as a farmer is hard to lose.</li>
</ul>

<h2>A 30-day plan</h2>
<ol>
  <li><strong>Days 1 to 3:</strong> choose your lane, fix your profile, write a pinned post.</li>
  <li><strong>Days 4 to 7:</strong> build a list of 100 accounts; follow them.</li>
  <li><strong>Weeks 2 to 4:</strong> 15 to 30 good replies a day, two original posts a week, answer every reply you get.</li>
  <li><strong>End of month:</strong> review follow-backs, retire silent targets, add new ones.</li>
</ol>
<p>Results vary, and nobody can promise a number. What this plan guarantees is that the right people see you often enough to form an opinion.</p>
""",
"faq": [
 ("How many followers do I need to be taken seriously on Crypto Twitter?", "Fewer than you think. A small account followed by respected people is taken more seriously than a large one followed by nobody notable."),
 ("Should I use my real name?", "Many respected CT accounts are pseudonymous. Consistency and a track record matter more than a real name."),
 ("How often should I post?", "A couple of original posts a week plus daily replies is enough to start. Quality and regularity beat volume."),
],
},
{
"slug": "follower-to-following-ratio",
"title": "Follower-to-Following Ratio: What It Tells You About Who Follows Back",
"desc": "An account's follower-to-following ratio is the best quick predictor of whether it will follow you back. How to read it, with examples and a simple rule.",
"tag": "Targeting",
"read": 5,
"keywords": "follower to following ratio, twitter follow ratio, who follows back on twitter, following ratio meaning",
"body": """
<p class="lede">Before you spend two weeks replying to someone, look at two numbers on their profile: followers and following. Together they tell you how likely that account is to follow anyone new, including you.</p>

<h2>What the ratio is</h2>
<p>Divide <strong>following</strong> by <strong>followers</strong>. The result is the share of their own audience size that they follow.</p>
<table class="tbl">
  <thead><tr><th>Followers</th><th>Following</th><th>Share</th><th>What it suggests</th></tr></thead>
  <tbody>
    <tr><td>100,000</td><td>2,500</td><td>2.5%</td><td>Rarely follows anyone new</td></tr>
    <tr><td>40,000</td><td>4,000</td><td>10%</td><td>Selective, but still adds people</td></tr>
    <tr><td>12,000</td><td>4,800</td><td>40%</td><td>Follows back readily</td></tr>
    <tr><td>3,000</td><td>2,900</td><td>97%</td><td>Follows almost everyone</td></tr>
  </tbody>
</table>

<h2>Why it predicts follow-backs</h2>
<p>Following is a habit. People who follow thousands of accounts press the button easily and keep doing so. People who have kept their list to a few hundred while their audience grew have made a choice not to. A good reply does not change that habit very often.</p>

<h2>A simple rule</h2>
<ul>
  <li><strong>Under 5%:</strong> skip as a follow-back target. Reply for reach if you like the account, but do not count on a follow.</li>
  <li><strong>5% to 10%:</strong> possible, with patience.</li>
  <li><strong>10% to 50%:</strong> the best range. Real standing, and still open to new people.</li>
  <li><strong>Above 50%:</strong> easy follows. Check the account's quality, because some of these follow everyone.</li>
</ul>
<p>The rule matters most for larger accounts. Below about 1,000 followers the ratio is too noisy to mean much.</p>

<h2>Other signs worth checking</h2>
<ul>
  <li><strong>Do they answer strangers?</strong> Scroll their replies tab.</li>
  <li><strong>Did their following count change recently?</strong> If it has not moved in months, the list is closed.</li>
  <li><strong>Who do they follow?</strong> If it is only very large accounts, a small one is unlikely to be added.</li>
  <li><strong>Are they active?</strong> No posts in two weeks means no follow-backs either.</li>
</ul>

<h2>Balancing ratio against score</h2>
<p>There is a tension here. The accounts whose follow would raise your <a href="/blog/what-is-twitterscore">TwitterScore</a> most are often the ones with the lowest ratios. The answer is a mix:</p>
<ul>
  <li>Put most of your effort into mid-sized, high-quality accounts in the 10% to 50% range. They are the realistic source of <a href="/blog/smart-followers-explained">smart followers</a>.</li>
  <li>Keep a small number of very large accounts for visibility, without expecting a follow.</li>
</ul>

<h2>Your own ratio</h2>
<p>Others read your ratio too. An account following 5,000 people with 300 followers looks like follow-for-follow. If you follow many targets, clean up now and then: unfollow accounts that never followed back after a fair window. Do it gradually, and never right after someone follows you.</p>

<h2>How ScoreX uses the ratio</h2>
<p>ScoreX reads both counts whenever it checks a profile. By default it leaves out accounts following under 5% of their followers (you can move the line), marks them "Follows few" in your target list, and answers posts from accounts with a healthy ratio first. It is one of the settings that most changes how many follow-backs you get for the same number of replies.</p>
""",
"faq": [
 ("What is a good follower-to-following ratio?", "For judging who will follow back, look for accounts that follow at least 10% of their follower count. For your own profile, following fewer people than follow you looks healthiest."),
 ("Does a low ratio mean an account is high quality?", "Often it means the account is established, but it is not proof of quality. It mainly tells you the person rarely follows anyone new."),
 ("Should I never reply to accounts with a low ratio?", "Reply if the conversation is worth it or you want the reach. Just do not judge your results by whether they follow you."),
],
},
{
"slug": "is-automating-replies-on-x-safe",
"title": "Is Automating Replies on X Safe? Limits, Risks and Rules",
"desc": "An honest look at automating replies on X (Twitter): what X's rules say, what gets accounts limited, and the safeguards that reduce the risk.",
"tag": "Safety",
"read": 8,
"keywords": "is twitter automation safe, x automation rules, automate twitter replies, twitter reply bot risk",
"body": """
<p class="lede">Short answer: automation on X always carries some risk, and anyone who tells you otherwise is selling something. The honest question is how much risk, and what you can do about it.</p>

<h2>What X's rules say</h2>
<p>X publishes automation rules and a platform manipulation policy. In plain terms they prohibit spam: bulk, duplicative or unsolicited replies and mentions, artificially inflating engagement, and aggressive following and unfollowing. Automated replies to people who did not ask for them are specifically something X restricts.</p>
<p>That means a tool that helps you write and send replies sits in a grey area at best. <strong>You are responsible for how your account behaves</strong>, whatever tool you use. Read the current rules yourself; they change.</p>

<h2>What actually gets accounts limited</h2>
<p>From what account owners report, enforcement is mostly about behaviour that looks like spam:</p>
<ul>
  <li><strong>Repetition.</strong> The same or near-identical text under many posts.</li>
  <li><strong>Machine speed.</strong> Replies seconds apart, around the clock, with no breaks.</li>
  <li><strong>Sudden spikes.</strong> Going from five replies a day to three hundred.</li>
  <li><strong>Links, hashtags and mentions</strong> in replies to strangers.</li>
  <li><strong>Follow churn.</strong> Mass following and unfollowing.</li>
  <li><strong>Reports.</strong> People muting, blocking or reporting your replies.</li>
</ul>
<p>The consequences range from reduced reach, to a temporary lock with a captcha, to suspension. Reduced reach is the hardest to notice: your replies still post, but fewer people see them.</p>

<h2>Limits to know</h2>
<p>X has technical caps, such as a daily limit on follows (400 a day for most accounts at the time of writing) and limits on posts per day. Hitting a cap is not a violation, but running near the caps every day is a pattern. Staying well below them is the point.</p>

<h2>Two kinds of automation</h2>
<table class="tbl">
  <thead><tr><th></th><th>Server bots</th><th>In-browser assistants</th></tr></thead>
  <tbody>
    <tr><td>Where it runs</td><td>Someone else's server</td><td>Your own browser, your own session</td></tr>
    <tr><td>Credentials</td><td>Needs your password or tokens</td><td>Needs neither</td></tr>
    <tr><td>Who reviews</td><td>Usually nobody</td><td>You can approve each reply</td></tr>
    <tr><td>Scale</td><td>Many accounts at once</td><td>One account, human pace</td></tr>
  </tbody>
</table>
<p>The second kind is not exempt from the rules. It is simply closer to what a person does, and it keeps you in control of every action.</p>

<h2>Safeguards that reduce the risk</h2>
<ol>
  <li><strong>Review before posting.</strong> Approving each reply is the strongest safeguard there is.</li>
  <li><strong>Hard daily caps</strong> and a slow ramp over the first weeks.</li>
  <li><strong>Human pacing.</strong> Minutes between replies, breaks, and sleeping hours.</li>
  <li><strong>No duplicates.</strong> Every reply checked against your recent ones.</li>
  <li><strong>No links or hashtags</strong> in replies.</li>
  <li><strong>Relevance.</strong> Only replying to accounts you chose, with something specific to the post.</li>
  <li><strong>Skip rules.</strong> Ads, giveaways, political posts, tragedies and restricted replies.</li>
  <li><strong>Stop on warnings.</strong> If X shows a captcha, a rate limit or an "unusual activity" notice, stop and look.</li>
  <li><strong>Watch your reach.</strong> A sharp drop in views on your replies is an early warning.</li>
</ol>

<h2>How ScoreX approaches it</h2>
<p>ScoreX is built around those safeguards. It runs in your own logged-in browser tab and never asks for your password. Review mode is the default, so nothing posts until you approve it. It enforces hard daily limits, spaces replies like a person, refuses duplicate or generic text, skips sensitive posts, and stops when X shows a warning. It also watches the views on your replies and alerts you if they collapse.</p>
<p>None of that makes it risk-free. It makes the risk something you can see and manage, and it leaves the decisions with you.</p>

<h2>If your account gets limited</h2>
<ul>
  <li>Stop all automation immediately.</li>
  <li>Complete any verification X asks for.</li>
  <li>Use the account by hand for several days.</li>
  <li>When you resume, use lower limits and review every reply.</li>
</ul>

<h2>The bottom line</h2>
<p>If a reply is relevant, specific and something you would be happy to have written by hand, it is unlikely to be treated as spam whoever typed it. If it is not, no pacing trick will save it. Start with <a href="/blog/how-to-write-replies-that-get-answered">better replies</a>, keep the volume modest, and stay in the loop.</p>
""",
"faq": [
 ("Does X allow automated replies?", "X's rules restrict automated, unsolicited replies and prohibit spam. Any tool that helps you reply carries some risk, and you are responsible for your account's behaviour."),
 ("Can X detect a browser extension?", "X sees behaviour: timing, repetition, volume and reports. Assume any pattern that looks automated can be noticed, and keep activity at a human pace."),
 ("What is the safest way to use a reply tool?", "Keep review mode on, use low daily limits, never post duplicates or links, and stop at the first warning from X."),
],
},
{
"slug": "ai-replies-on-x-without-sounding-like-a-bot",
"title": "AI Replies on X: How to Use AI Without Sounding Like a Bot",
"desc": "AI can draft X replies in seconds, and most of them sound like AI. How to brief it, what to ban, and how to keep your own voice.",
"tag": "Writing",
"read": 7,
"keywords": "ai twitter replies, ai reply generator twitter, chatgpt twitter replies, ai replies sound human",
"body": """
<p class="lede">Everyone on X has learned to spot an AI reply. It praises the post, restates it, and ends with a question nobody would ask. Used that way, AI costs you reputation. Used well, it is a fast first draft in your own voice.</p>

<h2>Why AI replies get spotted</h2>
<ul>
  <li><strong>Empty agreement.</strong> "Great insight! This really highlights..."</li>
  <li><strong>Restating the post</strong> in slightly different words.</li>
  <li><strong>Assistant vocabulary.</strong> "Intriguing", "insightful", "it's important to note", "game changer".</li>
  <li><strong>Perfect polish.</strong> Full sentences, tidy punctuation, an em dash, no personality.</li>
  <li><strong>The same shape every time.</strong> Compliment, summary, question.</li>
  <li><strong>Forced slang.</strong> A model told to "sound casual" overdoes it.</li>
</ul>

<h2>Brief it like a person, not like a tool</h2>
<p>The single biggest improvement is describing your own voice in your own words: how you talk, how long you write, what you never say. A few lines are enough:</p>
<blockquote>Dry, direct, lowercase. One thought, under 20 words. I ask about mechanisms, not about feelings. No hype, no emojis, never start with "great".</blockquote>
<p>Then tell the model what the reply is for. "Write a reply" produces filler. "Ask one sharp question about their main claim" produces something an author might answer. The patterns are in <a href="/blog/how-to-write-replies-that-get-answered">How to Write Replies That Authors Actually Answer</a>.</p>

<h2>Ban list</h2>
<p>Models drift back to the same phrases. Forbid them explicitly, and check the output:</p>
<ul>
  <li>Openers: Great, Wow, Love, Interesting, Sounds like, Looks like, I think</li>
  <li>Phrases: well said, this is huge, game changer, curious to see, excited to see, thanks for sharing, couldn't agree more</li>
  <li>Format: links, hashtags, @mentions, em dashes, bullet points, quotation marks around the reply</li>
  <li>Emojis that read as promotion: rocket, sparkles, hundred, target, chart</li>
</ul>

<h2>Vary the shape</h2>
<p>Even good replies become a pattern if they all look alike. Change length, opening, capitalisation and approach from one reply to the next: sometimes a question, sometimes a doubt, sometimes an example. ScoreX draws these at random for every reply so consecutive ones never match.</p>

<h2>Never let it make things up</h2>
<p>A model will happily invent a statistic, a personal story or "when I worked at". On a public account, in your name, that is a real risk. Rules worth enforcing:</p>
<ul>
  <li>No numbers, names or events that are not in the post.</li>
  <li>No claims about what you did, used, read or own.</li>
  <li>Opinions, questions and general observations only.</li>
</ul>

<h2>Check before posting</h2>
<p>A second pass catches most problems. Ask of every draft:</p>
<ol>
  <li>Could this be posted under any post? If yes, discard it.</li>
  <li>Does it give the author something to answer?</li>
  <li>Is it in the same language as the post?</li>
  <li>Is it too similar to something I posted recently?</li>
  <li>Would I be comfortable if the author knew a model drafted it?</li>
</ol>
<p>ScoreX runs a rule check and a separate editor model on every draft, scores how likely the author is to respond, and rewrites weak ones before you see them.</p>

<h2>Stay in the loop</h2>
<p>The safest setup is the one where you read each reply before it goes out, at least until you trust the voice. Edit freely: a tool that learns from your edits gets closer to you every week. Review mode also matters for your account's safety; see <a href="/blog/is-automating-replies-on-x-safe">Is Automating Replies on X Safe?</a></p>

<h2>What AI should not reply to</h2>
<ul>
  <li>Grief, illness and personal news.</li>
  <li>Politics and heated arguments.</li>
  <li>Insults aimed at you. No reply is the right reply.</li>
  <li>Anything where being wrong would hurt someone.</li>
</ul>

<h2>The standard to hold</h2>
<p>A reply is good if the author would want to answer it and you would be happy to have written it. Whether a model typed the first draft matters less than whether a person stands behind the final one.</p>
""",
"faq": [
 ("Can people tell if a reply was written by AI?", "Often, yes. Generic praise, restating the post and assistant vocabulary give it away. A specific reply in a consistent personal voice is much harder to tell apart."),
 ("Which AI model is best for X replies?", "Any recent model works if the brief is good. Your voice description, a ban list and a quality check matter more than the model."),
 ("Should I disclose that I use AI for replies?", "That is your call and may depend on your audience. What matters most is that you read and stand behind what is posted in your name."),
],
},
]
