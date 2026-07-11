# Mobile release runbook — Fluncle to the App Store

The ordered, actionable path that takes `apps/mobile` from a simulator-only Expo app to the operator's own phone (via TestFlight) and then to public App Store review. This is the checklist to _action_; the standing risk read that sits behind it — the review-guideline posture, the 5.2 music-rights argument, the App Review notes to draft — is [app-store-review.md](app-store-review.md), split out because that doc is a "read before every submission," not a one-time procedure. Read that first for _why_; follow this for _how_ and _in what order_.

Every step is labelled `[operator]` (a human action behind an Apple login, a payment, a legal agreement, or a device) or `[agent]` (a repo/CLI action an agent can run). The agent cannot enrol in Apple's program, accept agreements, or install a build on a phone; the operator does not hand-wrangle certificates — EAS generates them. Keep to the lane labels and neither side blocks on work the other owns.

## What exists vs what is missing (as of this doc)

- **Bundle identifier — SET.** `com.fluncle.app` for both iOS and Android (`apps/mobile/app.config.ts`). Not an open decision; do not change it once a build has shipped under it.
- **Version scheme — SET.** `version` is `0.1.0` in `app.config.ts` (the marketing version). `eas.json` uses `cli.appVersionSource: "remote"` + `autoIncrement` on the production profile, so EAS owns the iOS build number and bumps it per build — you never hand-edit a build number.
- **`eas.json` — ADDED by this PR** (`apps/mobile/eas.json`): a `development` profile (dev client, internal), a `preview` profile (internal distribution, for ad-hoc device installs), a `production` profile (store builds), and a `production` submit profile stub.
- **EAS project id — MISSING.** No `extra.eas.projectId` in the config yet; `eas init` mints it and writes it back (Phase 1).
- **App icon + splash image — MISSING.** There is no icon asset in `apps/mobile` and `app.config.ts` sets no `icon`; the splash plugin currently paints only the Deep Field background with no logo. A store build **must** ship a real 1024×1024 icon. This is gated on the **icon-candidates work in flight in a parallel PR** — merge that (which picks the artwork and wires the `icon` + splash `image` into `app.config.ts`) before the first Phase-1 build. Until then a build ships with the Expo placeholder, which fails review and looks broken on the operator's home screen.
- **Apple Developer account — MISSING** (operator, Phase 1). **App Store Connect app record — MISSING** (operator, Phase 1).

## Secrets involved (by name only)

- `EXPO_ACCESS_TOKEN` — the Expo/EAS personal access token that authorises non-interactive `eas` runs (CI, headless, or an agent-driven build). Vault-managed under the repo's 1Password pattern (fetched with `op`, injected at call time, mirrored into the relevant CI store); never commit its value and never write a concrete vault path into this public repo. Interactive operator runs use `eas login` instead and need no token.
- **App Store Connect API key** (the `.p8` + key id + issuer id) — only needed for _non-interactive_ `eas submit` / auto-submit. For a hand-run submission the operator logs in with their Apple ID and this is not required. If it is set up, it is vault-managed exactly like the above; no value or path lands in the repo.

The `EXPO_FREE_TEAM=1` strip in `app.config.ts` is **not** part of this path — it exists only for running on a physical device with a _free_ Apple ID (it drops push + universal links). TestFlight and the store both require the paid account, so every build in this runbook is built with the env var **unset**.

## The path to the operator's pocket

### Phase 1 — Foundations (one-time)

1. `[operator]` **Enrol in the Apple Developer Program** — €99/yr, at [developer.apple.com](https://developer.apple.com/programs/). Individual or organisation; the enrolment must be _active_ (agreements accepted, not "pending") before any credential can be generated.
2. `[operator]` **Accept the agreements and complete tax/banking in App Store Connect** — free apps still require the Paid Apps agreement's free tier and the tax forms to be signed off, or the app cannot go to external TestFlight or sale. Do this once at [appstoreconnect.apple.com](https://appstoreconnect.apple.com) → Business/Agreements.
3. `[operator]` **Create the app record in App Store Connect** — New App → platform iOS, bundle id `com.fluncle.app` (it must already be registered as an App ID; EAS registers it on first build, or create it under Certificates, Identifiers & Profiles). Name "Fluncle", primary language, SKU. This mints the **App Store Connect App ID (`ascAppId`)** — hand that number to the agent for step 7.
4. `[agent]` **Merge the icon-candidates PR** (prerequisite, see above) so `app.config.ts` carries a real `icon` + splash `image`. Confirm `apps/mobile` has the 1024×1024 icon wired before building.
5. `[agent]` **Link the repo to an EAS project** — from `apps/mobile`, `eas init`. This creates the EAS project and writes `extra.eas.projectId` back into the config. Interactive as the operator (`eas login`) the first time, or non-interactive with `EXPO_ACCESS_TOKEN` set.
6. `[operator]` **Generate iOS signing credentials via EAS** — `eas credentials -p ios` (or let the first `eas build` prompt). Sign in with the Apple Developer account when asked; EAS creates and stores the distribution certificate and provisioning profile on Expo's servers. **No manual certificate export, no Keychain wrangling, no `.p12` files** — this is the whole reason to use EAS. Operator-labelled only because it needs the Apple login.
7. `[agent]` **Record the `ascAppId` for non-interactive submits** — once the operator supplies the number from step 3, set it in `eas.json` under `submit.production.ios.ascAppId` (a public identifier, safe to commit) so `eas submit` runs without an interactive app-picker. Optional; interactive submit prompts for it instead.

### Phase 2 — To the operator's pocket via TestFlight (internal testing, no Beta App Review)

8. `[agent]` **Build the iOS app** — `eas build --platform ios --profile production` (from `apps/mobile`). EAS builds in the cloud using the credentials from Phase 1 and returns a `.ipa`. Mind the **EAS free-tier build queue and monthly build cap** — free builds wait behind paid ones and are limited per month; a paid EAS plan removes the wait. One build is enough to reach TestFlight.
9. `[agent]` **Submit the build to App Store Connect** — `eas submit --platform ios --profile production` (or fold steps 8–9 into one with `eas build --platform ios --auto-submit`). Non-interactive needs `EXPO_ACCESS_TOKEN` plus the ASC API key; interactive uses the operator's Apple login.
10. `[operator]` **Add yourself as an internal TestFlight tester** — in App Store Connect → TestFlight, add the operator's Apple ID to an **internal** testing group (internal testers must have a role on the team). **Internal testers do not require Beta App Review**, so the build is available to the operator within minutes of processing — no Apple human in the loop.
11. `[operator]` **Install via the TestFlight app on the phone** — accept the invite, install, launch. This is the pocket. Verify the **cold open** here (next section) on the real device, on cellular as well as wifi.

### Phase 3 — App Store review (public release)

12. `[operator]` **Complete the App Store listing** — in App Store Connect: screenshots (captured from the TestFlight build or simulator), description, keywords, support URL, and the **privacy policy URL** `https://www.fluncle.com/privacy` (route `apps/web/src/routes/privacy.tsx`).
13. `[operator]` **Fill the App Privacy "nutrition labels"** — disclose the push token as a device identifier used for the opt-in finding/mixtape notifications; declare no tracking, no accounts, no data sold. Match what the app actually sends.
14. `[operator]` **Draft and paste the App Review notes** — lead with the 5.2 argument from [app-store-review.md](app-store-review.md): audio is official previews plus our own brand renders ≤30s, the app links out to Spotify, and the "Submit a track" box is a private one-way suggestion to the operator (not displayed to other users), rate-limited and operator-reviewed. Pre-empting these skips a rejection round.
15. `[agent]` **(Optional) reuse the Phase-2 build** — the same build submitted to TestFlight can be selected for the App Store version in App Store Connect; no rebuild needed unless the code changed.
16. `[operator]` **Submit for review** — attach the build to the App Store version and hit Submit. External TestFlight groups (if you want public beta testers before release) _do_ require **Beta App Review** and the TestFlight test-information fields filled in; internal-only testing (Phase 2) never does.
17. `[operator]` **Respond to any reviewer clarification** — most likely the 5.2 music-rights question; the notes in step 14 usually pre-empt it. Approve/hold decisions are Apple's; the resubmit is `[operator]`.

## The cold-open requirement

The review doc's rule: **first launch must show real content immediately** — reviewers (and the operator, on that first TestFlight install) judge on a cold open, and an empty or errored first paint reads as a broken app. What the app's first paint actually needs:

- **`https://www.fluncle.com/api/v1` reachable** — the feed screen (`apps/mobile/app/(tabs)/index.tsx`) loads its first page from the public oRPC API at `API_BASE` (`apps/mobile/src/config.ts`). If the archive is empty or the API is down at review time, the feed is blank. Seed the archive so the first page returns real findings before you submit.
- **`https://found.fluncle.com` reachable** — the video/cover masters and Cloudflare Media Transformations are addressed by Log ID on this CDN, independent of the API. First paint pulls artwork and the first clip from here.
- **No login wall, no permission gate on first frame** — there is none by design (no accounts; push is opt-in _after_ content is on screen). Keep it that way: the cold open must never be a push-permission prompt over a blank feed.

Confirm the cold open on the real device in Phase 2, step 11 — that install is the last honest check before public review.

## Before you submit (pre-submission checklist)

Run these against the exact build you are shipping. They fold in the review doc's "Before you submit" moves plus this runbook's config gates.

- [ ] Icon-candidates PR merged; a real 1024×1024 icon and splash image are wired in `app.config.ts` (no Expo placeholder).
- [ ] Build made with `EXPO_FREE_TEAM` **unset** (push + associated-domains entitlements present).
- [ ] Cold open verified on a real device on cellular: feed paints real findings, artwork and first clip load, no blank/error state.
- [ ] App Review notes drafted (the 5.2 audio argument + the suggestion-box-is-not-UGC line) and pasted into App Store Connect.
- [ ] Privacy policy URL (`/privacy`) set and App Privacy labels filled (push token disclosed).
- [ ] Store-build render duration stays inside the preview band (≤~30s) — the 5.2 posture depends on it.
- [ ] Spotify branding follows Spotify's guidelines; no implied partnership.
- [ ] Re-read the current [App Store Review Guidelines](https://developer.apple.com/app-store/review/guidelines/) — they change between submissions.
