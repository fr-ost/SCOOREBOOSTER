// ScoreX - THE ONE PLACE FOR X (TWITTER) DOM SELECTORS AND PAGE TEXT PATTERNS.
//
// X changes its markup from time to time. When something stops working:
//   1. Open x.com, right-click the element > Inspect, find its data-testid / role.
//   2. Update the matching entry below (each entry is a list of fallbacks, tried in order), or
//   3. Without editing code: Dashboard > Settings > "Selector overrides" accepts a JSON object with the
//      same shape (e.g. {"sel":{"likeButton":["[data-testid=\"like\"]"]}}). Overrides are merged over this file.
//
// Many entries come from your older extensions (GrowX / X Unfollow Manager / X Comment Generator).
// Text patterns are case-insensitive regular expressions (source strings) and are written for an English
// X interface; add your language's wording if you use X in another language.

(function () {
  "use strict";
  globalThis.SX_SELECTORS = {
    version: "2026-10-30",

    sel: {
      // ---- layout / session ----
      primaryColumn: ['[data-testid="primaryColumn"]', "main[role=\"main\"]"],
      loggedInMarker: ['[data-testid="SideNav_AccountSwitcher_Button"]', '[data-testid="AppTabBar_Profile_Link"]', '[data-testid="AppTabBar_Home_Link"]', '[data-testid="SideNav_NewTweet_Button"]', '[data-testid="DashButton_ProfileIcon_Link"]'],
      profileNavLink: ['[data-testid="AppTabBar_Profile_Link"]'], // href="/<your handle>"
      accountSwitcher: ['[data-testid="SideNav_AccountSwitcher_Button"]'],
      dashProfileLink: ['[data-testid="DashButton_ProfileIcon_Link"]'], // narrow (mobile) layout: your avatar, top left
      // Avatars carry the handle in their testid ("UserAvatar-Container-<handle>"). Only read inside the account
      // switcher / mobile avatar button above, never in the page content (that would be someone else's handle).
      navAvatar: ['[data-testid^="UserAvatar-Container-"]'],
      loginButtons: ['[data-testid="loginButton"]', '[data-testid="signupButton"]', 'a[href="/login"]', 'a[href="/i/flow/login"]'],
      captchaFrames: ['iframe[src*="arkoselabs"]', 'iframe[src*="funcaptcha"]', "#arkose", 'div[id^="arkose"]', 'iframe[src*="recaptcha"]', 'iframe[src*="hcaptcha"]'],
      toast: ['[data-testid="toast"]', '[role="alert"]'],
      errorDetail: ['[data-testid="error-detail"]'],
      emptyState: ['[data-testid="empty_state_header_text"]', '[data-testid="emptyState"]'],
      spinner: ['[role="progressbar"]'],
      dialog: ['[role="dialog"]'],
      // Anything X can put over the page while ScoreX posts (dialogs, sheets, interstitials). Every match except
      // the reply composer, toasts and knownOverlay is an "unknown prompt": ScoreX stops and never clicks it.
      prompt: ['[role="dialog"]', '[role="alertdialog"]', '[aria-modal="true"]', '[data-testid="sheetDialog"]', '[data-testid="confirmationSheetDialog"]'],
      // Harmless overlays and docked panels (still checked for text.aiLabel). If ScoreX stops with "X showed a prompt
      // ScoreX does not know" on something harmless, add its selector here (Settings > Selector overrides).
      knownOverlay: ['[data-testid="HoverCard"]', '[data-testid="hoverCardParent"]', '[data-testid="DMDrawer"]', '[data-testid="GrokDrawer"]'],

      // ---- tweets ----
      tweet: ['article[data-testid="tweet"]', 'article[role="article"]'],
      tweetText: ['[data-testid="tweetText"]'],
      tweetUserName: ['[data-testid="User-Name"]'],
      tweetTime: ["time[datetime]"],
      socialContext: ['[data-testid="socialContext"]'], // "X reposted", "Pinned"
      tweetPhoto: ['[data-testid="tweetPhoto"]', '[data-testid="videoPlayer"]', '[data-testid="videoComponent"]', '[data-testid="card.layoutLarge.media"]'],
      cardWrapper: ['[data-testid="card.wrapper"]'],
      quoteMarker: ['[data-testid="quoteTweet"]', 'div[role="link"] [data-testid="User-Name"]'],
      actionGroup: ['[role="group"]'],
      replyButton: ['[data-testid="reply"]'],
      retweetButton: ['[data-testid="retweet"]', '[data-testid="unretweet"]'],
      likeButton: ['[data-testid="like"]'],
      unlikeButton: ['[data-testid="unlike"]'],
      viewsLink: ['a[href$="/analytics"]'],
      verifiedIcon: ['[data-testid="icon-verified"]', 'svg[aria-label="Verified account"]'],
      lockIcon: ['[data-testid="icon-lock"]'],

      // ---- composer (reply box) ----
      composerTextbox: ['div[data-testid="tweetTextarea_0"][role="textbox"]', 'div[data-testid^="tweetTextarea_"][role="textbox"]', 'div[role="textbox"][contenteditable="true"]'],
      // What makes a dialog the reply composer: X's post textarea or its Reply button. A dialog that only has some
      // other text field (a report form, a message box) is never typed into; it is an unknown prompt.
      composerDialogMarker: ['[data-testid^="tweetTextarea_"]', '[data-testid="tweetButton"]'],
      replySubmitInline: ['[data-testid="tweetButtonInline"]'],
      replySubmitModal: ['[data-testid="tweetButton"]'],
      composerClose: ['[data-testid="app-bar-close"]', '[aria-label="Close"]'],
      discardConfirm: ['[data-testid="confirmationSheetConfirm"]'],

      // ---- profiles ----
      profileUserName: ['[data-testid="UserName"]'],
      profileBio: ['[data-testid="UserDescription"]'],
      profileJoinDate: ['[data-testid="UserJoinDate"]'],
      profileHeaderItems: ['[data-testid="UserProfileHeader_Items"]'],
      profileFollowing: ['a[href$="/following"]'],
      profileFollowers: ['a[href$="/verified_followers"]', 'a[href$="/followers"]'],
      followsYouBadge: ['[data-testid="userFollowIndicator"]'],
      avatar: ['[data-testid^="UserAvatar-Container"] img', 'img[src*="profile_images"]', 'img[src*="default_profile"]'],
      followBtnSuffix: ['[data-testid$="-follow"]'], // "<id>-follow"  = you do not follow
      unfollowBtnSuffix: ['[data-testid$="-unfollow"]'], // "<id>-unfollow" = you follow (button says "Following")
      pendingBtnSuffix: ['[data-testid$="-cancel"]'],
      confirmSheet: ['[data-testid="confirmationSheetDialog"]'],
      confirmSheetConfirm: ['[data-testid="confirmationSheetConfirm"]'],
      confirmSheetCancel: ['[data-testid="confirmationSheetCancel"]'],

      // ---- user lists (followers / following / people search) ----
      userCell: ['[data-testid="UserCell"]', 'button[data-testid="UserCell"]'],
    },

    // Case-insensitive regex sources matched against visible text.
    text: {
      // X's strongest warning; always stops the engine.
      automation: "looks like it might be automated|automated (?:behavior|activity)|unusual activity|suspicious activity|protect our users from spam|we can.t complete this action right now",
      rateLimit: "rate limit|over the daily limit|you are over the limit|daily limit for (?:sending|posting)|too many requests|you.ve reached your limit|reached the limit|limit exceeded",
      locked: "your account (?:has been|is) (?:temporarily )?(?:locked|suspended|restricted)|we.ve temporarily limited some of your account features|your account is (?:locked|suspended)",
      captcha: "verify you are (?:a )?human|are you a robot|prove (?:that )?you.re (?:not a robot|human)|authenticate your account|complete the challenge|solve this puzzle",
      errorPage: "something went wrong|try reloading|hmm\\.\\.\\.this page doesn.t exist",
      postGone: "this (?:post|tweet) (?:is unavailable|was deleted|has been deleted)|this page doesn.t exist|post unavailable|you.re unable to view this post|this post is from an account that no longer exists",
      accountGone: "this account doesn.t exist|account suspended|these posts are protected|this account has been withheld|caution: this account is temporarily restricted",
      replySent: "your post was sent|your reply was sent|post sent|reply sent",
      replyRestricted: "who can reply|people .* mentioned can reply|only (?:people|accounts) .* can reply|replies are limited",
      reposted: "reposted|retweeted",
      pinned: "pinned",
      promoted: "^(?:ad|promoted|promoted by)$",
      replyingTo: "^replying to",
      followsYou: "follows you",
      duplicate: "already said that|whoops! you already said that|duplicate",
      // X asking about AI content / warning that a reply may be hidden. Any match while posting (outside your typed
      // reply and the post you reply to) stops ScoreX; it never clicks such a prompt.
      aiLabel: "made with ai|ai[- ]generated|generated (?:by|with) ai|add (?:an )?ai label|may be hidden|probable spam",
    },

    // Things that are not selectors but change with X's UI.
    misc: {
      handleHref: "^/([A-Za-z0-9_]{1,15})/?$",
      avatarTestId: "^UserAvatar-Container-([A-Za-z0-9_]{1,15})$",
      statusHref: "/([A-Za-z0-9_]{1,15})/status/(\\d{5,25})",
      followerCountWords: "followers?",
      followingCountWords: "following",
    },
  };
})();
