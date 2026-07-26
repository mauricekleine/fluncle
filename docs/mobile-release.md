# Mobile release runbook — Fluncle to the App Store

The ordered, actionable path that takes `apps/mobile` from a simulator-only Expo app to the operator's own phone (via TestFlight) and then to public App Store review. This is the checklist to _action_; the standing risk read that sits behind it — the review-guideline posture, the 5.2.3 music-rights argument 1.0 was rejected under — is [app-store-review.md](app-store-review.md), split out because that doc is a "read before every submission," not a one-time procedure. Read that first for _why_; follow this for _how_ and _in what order_.

Every step is labelled `[operator]` (a human action behind an Apple login, a payment, a legal agreement, or a device) or `[agent]` (a repo/CLI action an agent can run). The agent cannot enrol in Apple's program, accept agreements, or install a build on a phone; the operator does not hand-wrangle certificates — EAS generates them. Keep to the lane labels and neither side blocks on work the other owns.

## The config state (what is wired today)

Every item below is SHIPPED in the repo — this block is the standing inventory, not a to-do list. The app config is **`apps/mobile/app.config.js`**, plain CommonJS on purpose: expo ≥56.0.15 evaluates a TS config as an ES module (where the `expo/config*` CJS directory shims throw "Directory import … is not supported") and its transpile fallback crashes under `typescript@7`, whose native compiler dropped the legacy `transpileModule` JS API. A `.js` config takes the boring `require()` path. **A TS config here is known-broken by design — do not "restore" one**; the file's own header carries the full diagnosis.

- **Bundle identifier — SET.** `com.fluncle.app` for both iOS and Android (`apps/mobile/app.config.js`). Not an open decision; do not change it once a build has shipped under it.
- **Version scheme — SET.** `version` is `0.1.0` in `app.config.js` (the marketing version — still the 1.0 value; the 1.1 bump is tracked in _The 1.1 checklist_ below). `eas.json` uses `cli.appVersionSource: "remote"` + `autoIncrement` on the production profile, so EAS owns the iOS build number and bumps it per build — you never hand-edit a build number.
- **`eas.json` — SET** (`apps/mobile/eas.json`): a `development` profile (dev client, internal), a `preview` profile (internal distribution, for ad-hoc device installs), a `production` profile (store builds), and a `production` **submit** profile that is still an empty stub — no `ascAppId` yet, so `eas submit` prompts (step 6).
- **EAS project id — SET.** `extra.eas.projectId` is in `app.config.js` (minted by `eas init`; a public identifier, not a secret).
- **App icon + splash image — SET.** `icon: "./assets/icon.png"` (the operator's pick, 2026-07-12: the drifting traveler on plain Deep Field, a 1024×1024 opaque PNG), the Android `adaptiveIcon` foreground (`./assets/adaptive-icon.png`), and the `expo-splash-screen` plugin's `image: "./assets/splash-icon.png"` over the Deep Field ground. All three are rendered from `@fluncle/media` (`bun run --cwd packages/media render:mobile-assets`); changing one is a NATIVE asset change — rebuild, not reload.
- **Apple Developer account — LIVE** (operator). **App Store Connect app record — LIVE** (operator); 1.0 has been through review.

## Secrets involved (by name only)

- `EXPO_ACCESS_TOKEN` — the Expo/EAS personal access token that authorises non-interactive `eas` runs (CI, headless, or an agent-driven build). Vault-managed under the repo's 1Password pattern (fetched with `op`, injected at call time, mirrored into the relevant CI store); never commit its value and never write a concrete vault path into this public repo. Interactive operator runs use `eas login` instead and need no token.
- **App Store Connect API key** (the `.p8` + key id + issuer id) — only needed for _non-interactive_ `eas submit` / auto-submit. For a hand-run submission the operator logs in with their Apple ID and this is not required. If it is set up, it is vault-managed exactly like the above; no value or path lands in the repo.

The `EXPO_FREE_TEAM=1` strip in `app.config.js` is **not** part of this path — it exists only for running on a physical device with a _free_ Apple ID (it drops push + universal links). TestFlight and the store both require the paid account, so every build in this runbook is built with the env var **unset**.

## The path to the operator's pocket

### Phase 1 — Foundations (one-time)

1. `[operator]` **Enrol in the Apple Developer Program** — €99/yr, at [developer.apple.com](https://developer.apple.com/programs/). Individual or organisation; the enrolment must be _active_ (agreements accepted, not "pending") before any credential can be generated.
2. `[operator]` **Accept the agreements and complete tax/banking in App Store Connect** — free apps still require the Paid Apps agreement's free tier and the tax forms to be signed off, or the app cannot go to external TestFlight or sale. Do this once at [appstoreconnect.apple.com](https://appstoreconnect.apple.com) → Business/Agreements.
3. `[operator]` **Create the app record in App Store Connect** — New App → platform iOS, bundle id `com.fluncle.app` (it must already be registered as an App ID; EAS registers it on first build, or create it under Certificates, Identifiers & Profiles). Name "Fluncle", primary language, SKU. This mints the **App Store Connect App ID (`ascAppId`)** — hand that number to the agent for step 6.
4. `[agent]` **Link the repo to an EAS project — DONE.** `eas init` (from `apps/mobile`) created the EAS project and wrote `extra.eas.projectId` into `app.config.js`. Nothing to redo; re-running it against a live project only re-confirms the id.
5. `[operator]` **Generate iOS signing credentials via EAS** — `eas credentials -p ios` (or let the first `eas build` prompt). Sign in with the Apple Developer account when asked; EAS creates and stores the distribution certificate and provisioning profile on Expo's servers. **No manual certificate export, no Keychain wrangling, no `.p12` files** — this is the whole reason to use EAS. Operator-labelled only because it needs the Apple login.
6. `[agent]` **Record the `ascAppId` for non-interactive submits** — once the operator supplies the number from step 3, set it in `eas.json` under `submit.production.ios.ascAppId` (a public identifier, safe to commit) so `eas submit` runs without an interactive app-picker. Optional; interactive submit prompts for it instead.

### Phase 2 — To the operator's pocket via TestFlight (internal testing, no Beta App Review)

7. `[agent]` **Build the iOS app** — `eas build --platform ios --profile production` (from `apps/mobile`). EAS builds in the cloud using the credentials from Phase 1 and returns a `.ipa`. Mind the **EAS free-tier build queue and monthly build cap** — free builds wait behind paid ones and are limited per month; a paid EAS plan removes the wait. One build is enough to reach TestFlight.
8. `[agent]` **Submit the build to App Store Connect** — `eas submit --platform ios --profile production` (or fold steps 7–8 into one with `eas build --platform ios --auto-submit`). Non-interactive needs `EXPO_ACCESS_TOKEN` plus the ASC API key; interactive uses the operator's Apple login.
9. `[operator]` **Add yourself as an internal TestFlight tester** — in App Store Connect → TestFlight, add the operator's Apple ID to an **internal** testing group (internal testers must have a role on the team). **Internal testers do not require Beta App Review**, so the build is available to the operator within minutes of processing — no Apple human in the loop.
10. `[operator]` **Install via the TestFlight app on the phone** — accept the invite, install, launch. This is the pocket. Verify the **cold open** here (next section) on the real device, on cellular as well as wifi.

### Phase 3 — App Store review (public release)

11. `[operator]` **Complete the App Store listing** — in App Store Connect: screenshots (captured from the TestFlight build or simulator), description, keywords, support URL, and the **privacy policy URL** `https://www.fluncle.com/privacy` (route `apps/web/src/routes/privacy.tsx`).
12. `[operator]` **Fill the App Privacy "nutrition labels"** — disclose the push token as a device identifier used for the opt-in finding/mixtape notifications; declare no tracking, no accounts, no data sold. Match what the app actually sends.
13. `[operator]` **Paste the App Review notes** — the full text is in _The submission kit_ below; do not re-draft it. It leads with 4.2, then the **5.2.3** audio-sourcing statement (feed videos are muted visuals, every second of audio is an official ~30s preview or Fluncle's own voice, full playback links out), then the 1.2 suggestion-box line. 5.2.3 is the guideline 1.0 was actually rejected under, so this block is the one that matters most.
14. `[agent]` **(Optional) reuse the Phase-2 build** — the same build submitted to TestFlight can be selected for the App Store version in App Store Connect; no rebuild needed unless the code changed.
15. `[operator]` **Submit for review** — attach the build to the App Store version and hit Submit. External TestFlight groups (if you want public beta testers before release) _do_ require **Beta App Review** and the TestFlight test-information fields filled in; internal-only testing (Phase 2) never does.
16. `[operator]` **Respond to any reviewer clarification** — most likely the 5.2 music-rights question, and 1.0 did draw exactly that (rejected under **5.2.3** on the first pass; see the note below the kit). The notes in step 13 now carry the remediated language. Approve/hold decisions are Apple's; the resubmit is `[operator]`.

## The submission kit (operator-ratified 2026-07-12)

The App Store Connect listing values, ratified by the operator — paste these when filling Phase 3's listing step; edit here first if they change (this doc is the source of truth, not ASC).

- **Name** (30 chars): `Fluncle` · **Subtitle**: `Drum & bass, found & certified`
- **Category**: Music (secondary: Entertainment) · **Age rating**: 4+ (questionnaire: all "None")
- **Support URL**: `https://www.fluncle.com/about` · **Privacy policy**: `https://www.fluncle.com/privacy`
- **Keywords** (≤100 chars): `drum and bass,dnb,jungle,liquid,neurofunk,music discovery,radio,dj mix,mixtape,set builder`
- **Description** (multi-paragraph; paste with the line breaks):

  > Drum & bass bangers from another dimension.
  >
  > I'm Fluncle, the uncle with the good records. I dig drum & bass out of the far sectors, and when a tune gets an involuntary "oof" out of me, I certify it and log it as a finding, with its own coordinate. No algorithm, no playlist filler: if it's in the archive, it put my knees up.
  >
  > The feed plays each finding's own video, one I made for that track and nothing else. The radio runs my whole archive as one long set. Drop in mid-flight, wherever it's got to. And on the Decks you take over: name a few artists you like, pick an opener, and I rank what mixes in clean next, by key, tempo, and feel. Chain a set, then share it with the crew.
  >
  > Browse the archive by what I found and when, search by name or coordinate, save what hits, and listen on Spotify or Apple Music. Heard one I missed? Send it in. If it earns its place, I log it with a coordinate of its own.

- **Promotional text** (optional ASC field, updatable without review): `Fresh bangers, most nights. The radio never stops; drop in mid-flight.`
- **App Privacy labels**: Identifiers → Device ID (the push token), app functionality only, not linked to identity, no tracking. User Content → track submissions + optional contact, app functionality, not linked. Everything else: Data Not Collected (the app ships no analytics SDK).
- **Review notes** — the FULL paste-ready text for the ASC "Notes" field, and the ONLY copy of it (reviewer-facing, deliberately plain per the narrator rule; the 4.2 lead, then the **5.2.3** audio-sourcing statement, then the 1.2 line). The 5.2.3 wording below is the REMEDIATED language written after 1.0's rejection — paste it verbatim; edit it only if the audio/video sources actually change:

  > Thank you for reviewing Fluncle. A few notes up front that usually answer the common questions:
  >
  > What the app is. Fluncle is a single-editor drum & bass archive with an interactive set-building tool. Every track in the app was selected, verified, and published by the developer personally; there is no user-generated feed and no third-party catalog.
  >
  > Interactive functionality (Guideline 4.2). The "Decks" tab is a working tool, not a content browser: the user picks artists they like (or searches for a track), chooses an opening track, and a harmonic mixing engine ranks which tracks mix in cleanly next, by musical key, tempo, and sonic similarity, re-ranking after every addition. The user builds an ordered set, can remove tracks, and can share the finished set as a link. This runs alongside the native video feed, a continuous radio station with background-audio and lock-screen playback, full archive search, local saves, and push notifications.
  >
  > Where the audio and video come from (Guideline 5.2.3). Fluncle is not a streaming service and does not host, stream, or provide access to full-length commercial recordings. All audio that plays inside the app is one of exactly two sources. (1) Short official preview clips, about 30 seconds: the official preview assets exposed by the platforms' own preview APIs — Apple's iTunes / Apple Music preview assets and Deezer's preview API. Our own server relays the platform's preview stream to the app without modification (it passes the upstream bytes through, honoring HTTP range requests); these are the same public preview clips those platforms serve for their own search and preview features. (2) Fluncle's own spoken "observations": on the Radio tab the audio is our own original voice recordings — short spoken notes about a track that we record and produce ourselves. That is first-party audio, not a music recording.
  >
  > All video in the app is first-party, produced by us. The feed's short clips are our own artwork animations, which we render. In this binary the feed videos play muted — they are shown purely as silent visuals, and the accompanying sound is the official ~30-second preview described in (1) above. No video in the app plays a full commercial recording, and there is no control anywhere in the app that plays a full-length track. Every "full listen" action is an outbound link that opens the official service — Spotify or Apple Music — where playback happens on that licensed platform, not inside Fluncle.
  >
  > The "Submit a track" feature is not user-generated content (Guideline 1.2). It is a private, one-way suggestion box addressed to the developer: nothing a user submits is ever shown to any other user or published automatically. Submissions are rate-limited server-side and each one is manually reviewed by the developer, who decides whether to add the track to the archive through a separate editorial process. It is functionally a contact form, so there is no user-facing moderation surface to provide.
  >
  > No account, no sign-in. Every feature above can be reviewed without creating an account or logging in — the app has no accounts at all. No demo credentials are needed. Push notifications are optional and requested only after content is on screen; declining them changes nothing.
  >
  > If anything needs clarification, we're happy to answer quickly through Resolution Center.

- **Screenshots**: the 6.9" set (3-10 shots) from the iPhone Pro Max-class simulator: feed (a dark cover), the Decks mid-chain (a numbered set + the ranked rail — the 4.2 evidence), radio playing, archive, a finding, submit.

### The 5.2.3 rejection and what fixed it (2026-07-21)

1.0 build 4 went to review on 2026-07-13 and came back **REJECTED under Guideline 5.2.3** — the feed's videos carried a baked audio excerpt of the track, which reads as providing access to a third-party audio catalog. The remediation is in the code, not in the wording: commit `97897ed7` (`fix(mobile): all in-app audio is official-preview audio (App Store 5.2.3)`) made the feed video a **muted visual** and moved the card's sound onto the official preview bed. The invariant is pinned in the type itself — `CardMedia`'s video rung declares `hasAudio: false` (`apps/mobile/src/lib/media.ts`) and `media.test.ts` asserts it as "THE 5.2.3 INVARIANT". **Any change that lets a feed video sound its own track re-opens the rejection**; that test is the tripwire.

One paragraph belongs in the notes only on the build that carries the change (it was in the resubmission; drop it once a later version is the baseline):

> Summary of the change in this build: the previous build's feed videos carried a short baked audio excerpt. This build removes that: feed videos are now muted visuals, and every second of audio the user can hear in the app is either an official platform preview clip (Apple / Deezer preview APIs) or Fluncle's own recorded voice. Full playback is always handed off to Spotify or Apple Music via a link out.

## The 1.1 submission delta (accounts)

Everything above is the **1.0 kit** (no accounts). It stands as-is; do not rewrite it. This section carries only what CHANGES when 1.1 (accounts in the pocket) is submitted — the scope operator-ratified 2026-07-14 in `docs/planning/ROADMAP.md` ("The 1.1 arc — accounts in the pocket"). 1.1 adds an **optional** email/password account (an `/account` modal, never a tab) that syncs saved findings, saved sets, and the key-notation preference across web ↔ mobile. The law holds on every slice: **an account never gates a feature** — every surface stays fully usable signed-out, so everything a reviewer touches is reviewable without an account. Signing in only syncs.

### App Privacy label changes

The app now creates accounts, so the App Privacy questionnaire gains one collected data type and re-classifies two existing ones **for signed-in users**. An anonymous user's posture is unchanged from the 1.0 kit above. The app still ships **no analytics or tracking SDK**, so the answer to "Used for tracking?" stays **No** for every type. Re-declare in App Store Connect at the 1.1 submission:

- **Contact Info → Email Address** — **NEW.** Collected: **Yes**. Purpose: **App Functionality** only (account creation, sign-in, and password reset). Linked to the user's identity: **Yes** (it is the account key). Used for tracking: **No**.
- **User Content** (the track submissions + optional contact from the 1.0 kit) — still collected for **App Functionality**, still **not** used for tracking. Linked to identity: **Yes for a signed-in account holder** (saved findings and saved sets are stored against their account and are covered by account export + delete). An anonymous submission stays **not linked**, exactly as 1.0. Declare it **Linked** (the questionnaire is per data type across the app, and the signed-in path links it).
- **Identifiers** (the push-token Device ID from the 1.0 kit) — still **App Functionality**, still **no tracking**. Linked to identity: **Yes for a signed-in account holder** (the account ties the device/session to the person); **not linked** for anonymous. Declare it **Linked**.
- **Everything else: Data Not Collected**, unchanged. No new tracking, no data sold, no third-party analytics — the account is a first-party sync backup, nothing more.

### Review-notes addendum (paste-ready)

Append this to the existing review-notes block above (do not replace it — the 4.2 / 5.2 / 1.2 posture is unchanged). Reviewer-facing plain prose, per the narrator rule:

> Accounts (new in this version). This version adds an optional account so a user can sync their saved tracks, their built sets, and their preferences across our web app and this app. Accounts are entirely optional and gate nothing: every feature — the video feed, the radio, the Decks set builder, search, saving, and submitting — is fully usable without signing in, so nothing in the app requires an account to review. Signing in only syncs data the app already stores on the device.
>
> Account creation is email and password only. We do not offer any third-party or social login (no Sign in with Apple, Google, or Facebook), so Guideline 4.8 does not apply.
>
> Account deletion is available in the app. The account screen has a "Delete account" action, behind a confirmation, that permanently deletes the account and all associated data from within the app itself (Guideline 5.1.1(v)) — no website visit or support request is required. The same screen also lets a user export their saved data. Users who forget their password can reset it from the sign-in screen via an email link.

### The 1.1 checklist

Run alongside the 1.0 "Before you submit" checklist above; these are the 1.1-specific moves.

- [ ] Marketing `version` bumped in `apps/mobile/app.config.js` — **still `0.1.0` as of this doc**, so this is an open gate, not a done one (EAS still owns the build number via `autoIncrement`).
- [ ] New screenshots **only if a surface changed materially** — the candidate is the Decks "Save set" shot (the new signed-in secondary action); the rest of the 1.0 set still holds. Do not re-shoot unchanged screens.
- [ ] App Privacy labels re-pasted per the changes above (Email Address added; User Content and Identifiers set to Linked; tracking still No).
- [ ] Review-notes addendum appended to the ASC "Notes" field.
- [ ] On the exact store build: verify sign-up, sign-in, sign-out, **in-app account deletion** (behind the confirm), data export, and password-reset email — all before submitting.

## The cold-open requirement

The review doc's rule: **first launch must show real content immediately** — reviewers (and the operator, on that first TestFlight install) judge on a cold open, and an empty or errored first paint reads as a broken app. What the app's first paint actually needs:

- **`https://www.fluncle.com/api/v1` reachable** — the feed screen (`apps/mobile/app/(tabs)/index.tsx`) loads its first page from the public oRPC API at `API_BASE` (`apps/mobile/src/config.ts`). If the archive is empty or the API is down at review time, the feed is blank. Seed the archive so the first page returns real findings before you submit.
- **`https://found.fluncle.com` reachable** — the video/cover masters and Cloudflare Media Transformations are addressed by Log ID on this CDN, independent of the API. First paint pulls artwork and the first clip from here.
- **No login wall, no permission gate on first frame** — there is none by design (no accounts; push is opt-in _after_ content is on screen). Keep it that way: the cold open must never be a push-permission prompt over a blank feed.

Confirm the cold open on the real device in Phase 2, step 11 — that install is the last honest check before public review.

## Before you submit (pre-submission checklist)

Run these against the exact build you are shipping. They fold in the review doc's "Before you submit" moves plus this runbook's config gates.

- [ ] Build made with `EXPO_FREE_TEAM` **unset** (push + associated-domains entitlements present).
- [ ] Cold open verified on a real device on cellular: feed paints real findings, artwork and first clip load, no blank/error state.
- [ ] App Review notes pasted into App Store Connect verbatim from the kit above (the 5.2.3 audio-sourcing statement + the suggestion-box-is-not-UGC line).
- [ ] Privacy policy URL (`/privacy`) set and App Privacy labels filled (push token disclosed).
- [ ] `bun run --cwd apps/mobile test` green — `media.test.ts` is the 5.2.3 tripwire (`hasAudio: false`); a feed video that sounds its own track is the exact thing 1.0 was rejected for.
- [ ] Store-build render duration stays inside the preview band (≤~30s) — the audio bed is an official preview, and a clip that outran it would ask the visual to carry sound it does not have.
- [ ] Spotify branding follows Spotify's guidelines; no implied partnership.
- [ ] Re-read the current [App Store Review Guidelines](https://developer.apple.com/app-store/review/guidelines/) — they change between submissions.
