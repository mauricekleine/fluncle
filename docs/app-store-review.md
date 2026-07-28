# App store review — Fluncle mobile

Context for submitting the Expo app (`apps/mobile`) to the Apple App Store and Google Play. This is not a roadmap item or a checklist to action now — it is a standing read before any store submission, so the known review risks are not a surprise. The app's build and scope live in `apps/mobile`. For the ordered, actionable steps (enrol → TestFlight → review), follow the runbook in [mobile-release.md](mobile-release.md); this doc is the _why_ behind its posture.

## The short version

The predicted risk landed where this doc said it would: 1.0 was **rejected under Guideline 5.2.3** (music rights) on the first pass, remediated, and resubmitted — see the 5.2.3 section for the fix and the invariant that holds it. A second round then came back on **5.2.1**, and not for anything in the app: the store SCREENSHOTS carried real album covers and artist photos. That is the shape to expect from Apple: rounds on the rights question, not a refusal of the app. Music apps that play previews and link out already exist on the store, and Fluncle's native vertical-video feed is genuine native value (not a web wrapper). Google Play review is far more lenient — approval there is near-certain; the friction worth planning around is Apple's.

## What the app does that review cares about

These are the facts a reviewer reacts to, grounded in the code:

- Plays **brand-rendered videos as MUTED visuals** — the feed's video rung declares `hasAudio: false` (`apps/mobile/src/lib/media.ts`), and the card's sound is the official ~30s preview instead. The master `footage.mp4` does carry audio on the web (see [video-variants.md](video-variants.md)); the app deliberately never sounds it. Clip length is bounded to **10–30s (20s default)** (`packages/video/src/remotion/types.ts`).
- Every second of audio in the app is **either an official ~30s preview** (`/api/preview` → Apple/iTunes + Deezer preview endpoints, relayed byte-for-byte) **or Fluncle's own recorded voice** (the Radio's spoken observations). For findings without a rendered video, the same preview plays under drifting cover art.
- **Deep-links out to Spotify** ("Open in Spotify") — it drives traffic to Spotify, it is not a player substitute.
- **Opt-in push** for a new finding and a new mixtape (the consent flow in `src/push/`), nothing more.
- **A native archive** (the four-galaxy lens) and a **finding detail modal** over the same public feed.
- **An anonymous suggestion box** — the "Submit a track" modal (`apps/mobile/app/submit.tsx`) searches Spotify, the crew member picks a match, and it POSTs the existing public `submit_track` op. It rides the same contract the web dialog posts. There are no accounts and no drafts; a submission is a one-way message for the operator to review.
- **No accounts, no in-app purchase, no user-generated content shown to other users.** The one input surface (the suggestion box) sends the operator a private suggestion — nothing a submitter types is ever displayed in-app to anyone.

## The three real risks

### 1. Music & video rights — Guideline 5.2.3 (this one already bit; it is now remediated)

**Not hypothetical: 1.0 was rejected under 5.2.3.** Build 4 went to review on 2026-07-13 with the feed's videos carrying a baked audio excerpt of the track, and Apple read the app as providing access to a third-party audio catalog — the exact shape that draws the _"provide documentation of your rights to this content"_ request. Remediated in commit `97897ed7` (2026-07-21) and resubmitted.

**The shipped posture — a muted visual plus an official-preview audio bed.** The feed's video plays with no sound of its own; the card's audio is the platform's own ~30s preview, relayed byte-for-byte from Apple's iTunes / Apple Music and Deezer preview APIs. The Radio's audio is Fluncle's own recorded voice. So the app has exactly two audio sources, both defensible on their face, and every "full listen" is an outbound link to Spotify or Apple Music where playback happens on the licensed platform. The claim is no longer "our render is preview-length" (an argument) but "we never sound a commercial recording at all" (a fact).

**The invariant is pinned in code, and it must stay pinned.** `CardMedia`'s video rung types its audio flag as the literal `false` (`apps/mobile/src/lib/media.ts`), and `apps/mobile/src/lib/media.test.ts` asserts it as "THE 5.2.3 INVARIANT". Anything that lets a feed video sound its own track re-opens the rejection — treat a change to that flag as submission-blocking, not a refactor. Keeping store-build render duration inside the preview band (~30s) still matters: the audio bed is a preview, so a longer visual would outrun the sound it is paired with.

**If mixtapes gain in-app audio** (the app already interleaves published mixtapes in the feed contract, and `radio.fluncle.com` streams observations): before shipping, verify and document that what plays is the same two-source material — official previews plus the agent-authored observation audio (`docs/agents/observation-agent.md`), never a full commercial track. A surface that streamed full commercial recordings would break the argument outright, and with a 5.2.3 rejection on record the second look would be less forgiving.

### 2. Artwork rights in the STORE ASSETS — Guideline 5.2.1 (this one bit too; the rig is built)

**Rejected 2026-07-28, and not for anything in the app.** The screenshots were shot against the live archive, so the store listing published real album covers and Spotify artist photography — third-party artwork under Fluncle's own marketing, which is exactly what 5.2.1 is about. The app's behaviour was never questioned on this pass.

**The rule, and it is submission-blocking: no third-party artwork appears in ANY store asset.** No cover, no artist photo, no logo that is not ours — screenshots, preview video, and the listing alike. Give it the same weight as the 5.2.3 muted-video invariant: a reviewer reads the screenshots before the app.

**The remedy is a rig, not a discipline.** Every affected slot is re-shot against a synthetic dataset whose sleeves and artist marks are generated by `@fluncle/media` and owned outright — render the art, serve it, seed the local database, point the simulator at it with `EXPO_PUBLIC_API_BASE`. The ordered steps, the shot list (what re-shoots, what keeps, and why Submit is captured in its empty pre-search state), and the fixture rules are in [mobile-store-screenshots.md](mobile-store-screenshots.md).

### 3. Minimum functionality — Guideline 4.2 ("is this just your website?")

Why it bites: the classic rejection for content apps that wrap a site.

Our posture: the app carries a working TOOL, not just content — the Decks tab is an interactive set builder (pick artists or an opener; the harmonic engine ranks what mixes in clean next by key, tempo, and feel; the chain re-ranks on every add and shares as a link). An interactive utility is the strongest possible 4.2 answer, and it sits alongside a native full-screen vertical-video pager, native push, background-audio radio, and a native archive. Low risk — lead with the Decks tool, then the native feed.

## Lower-risk hygiene

- **Spotify branding** — using the logo + "Open in Spotify" to link to Spotify is allowed under their brand guidelines; follow them and do not imply a partnership.
- **Push (4.5.4)** — must be opt-in and not required; the consent flow already satisfies this.
- **Privacy (5.1)** — supply the privacy-policy URL (we have `/privacy`, `apps/web/src/routes/privacy.tsx`) and accurate App Privacy "nutrition labels" disclosing the push token as a device identifier.
- **Optional accounts / no IAP** — from 1.1 the app has an **optional** email/password account that syncs saved tracks, sets, and preferences across web ↔ mobile; it **never gates a feature** (every surface stays fully usable signed-out). Credentials are first-party only — the account is created with an email, a username, and a password, and the app signs in **by username** (the client registers Better Auth's `usernameClient` plugin and calls `signIn.username`; `apps/mobile/src/lib/auth-client.ts`, `apps/mobile/app/account.tsx`), with the email carrying verification and password reset. Because there is no third-party or social login anywhere, the sign-in-services rule (5.1.1(i)) and the Sign in with Apple requirement (4.8) stay untriggered — keep it that way. Account creation collects an email, so the app carries **in-app account deletion** (5.1.1(v), behind a confirmation) plus data export and email password reset. No IAP, so every payment rule (3.x) stays out of scope. (In 1.0 there were no accounts at all; this bullet updates at the 1.1 submission — see the privacy-label + review-notes delta in [mobile-release.md](mobile-release.md).)
- **The suggestion box is not displayed UGC (1.2)** — Guideline 1.2 governs user-generated content that is _shown to other users_ (it wants filtering, blocking, and a report path). The suggestion box shows a submitter's input to nobody: it is a one-way, anonymous message to the operator, closer to a contact form than a feed. The abuse story is the server's, not the app's — the public `submit_track` op is rate-limited (the hourly cap the web dialog shares) and every submission is operator-reviewed before anything is ever published as a finding. Because nothing a stranger types can surface to another user, there is no moderation surface to build in-app. Worth a line in the App Review notes so it is not mistaken for a social feed.

## Before you submit (cheap moves that avoid a rejection round)

- **App Review notes:** paste the ready text from [mobile-release.md](mobile-release.md) → _The submission kit_ → "Review notes". It states up front that the feed's videos are muted visuals, that every second of audio is an official ~30s preview or Fluncle's own voice, and that full playback links out to Spotify and Apple Music. Pre-empting the 5.2.3 question is the cheapest thing on this list — 1.0 skipped it and paid a full rejection round.
- **Cold open:** first launch must show real content immediately — no empty states, no "coming soon." Reviewers judge on a cold open, so seed the feed.
- **Account + entitlements:** a paid Apple Developer account (€99/yr) is required for store distribution and for TestFlight. Keep the push + associated-domains entitlements in place; the `EXPO_FREE_TEAM` strip is only for free-team local installs, never store builds. The step-by-step enrolment, build, and submit sequence is [mobile-release.md](mobile-release.md).

## Guidelines evolve

Apple's rules change between submissions. Re-read the current [App Store Review Guidelines](https://developer.apple.com/app-store/review/guidelines/) at submission time. The numbers cited here (4.2, 5.2.1, 5.2.3, 4.5.4, 5.1.1) are stable as of 2026-07.
