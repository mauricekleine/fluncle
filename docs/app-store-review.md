# App store review — Fluncle mobile

Context for submitting the Expo app (`apps/mobile`) to the Apple App Store and Google Play. This is not a roadmap item or a checklist to action now — it is a standing read before any store submission, so the known review risks are not a surprise. The app's build and scope live in `apps/mobile`. For the ordered, actionable steps (enrol → TestFlight → review), follow the runbook in [mobile-release.md](mobile-release.md); this doc is the _why_ behind its posture.

## The short version

Apple review risk concentrates in two areas: music-content rights under 5.2.3 and intellectual-property presentation in store metadata under 5.2.1. The submission posture below addresses both.

## What the app does that review cares about

These are the facts a reviewer reacts to, grounded in the code:

- Plays **brand-rendered videos as MUTED visuals** — the feed's video rung declares `hasAudio: false` (`apps/mobile/src/lib/media.ts`), and the card's sound is the official ~30s preview instead. The master `footage.mp4` does carry audio on the web (see [video-variants.md](video-variants.md)); the app deliberately never sounds it. Clip length is bounded to **10–30s (20s default)** (`packages/video/src/remotion/types.ts`).
- Every second of audio in the app is **either an official ~30s preview** (`/api/preview` → Apple/iTunes + Deezer preview endpoints, relayed byte-for-byte) **or Fluncle's own recorded voice** (the Radio's spoken observations). For findings without a rendered video, the same preview plays under drifting cover art.
- **Deep-links out to Spotify** ("Open in Spotify") — it drives traffic to Spotify, it is not a player substitute.
- **Opt-in push** for a new finding and a new mixtape (the consent flow in `src/push/`), nothing more.
- **A native archive** (the four-galaxy lens) and a **finding detail modal** over the same public feed.
- **An anonymous suggestion box** — the "Submit a track" modal (`apps/mobile/app/submit.tsx`) searches Fluncle's catalogue and Deezer (Spotify as the fallback), the crew member picks a match, and it POSTs the existing public `submit_track` op. It rides the same contract the web dialog posts. There are no accounts and no drafts; a submission is a one-way message for the operator to review.
- **No accounts, no in-app purchase, no user-generated content shown to other users.** The one input surface (the suggestion box) sends the operator a private suggestion — nothing a submitter types is ever displayed in-app to anyone.

## The two real risks

### 1. Music and video rights — Guideline 5.2.3

Feed videos are muted visuals. All commercial audio comes from official preview endpoints, and full playback links to licensed platforms.

Store screenshots must be UI-led, with album covers appearing only as incidental list content rather than the hero. If cover use cannot be justified, use synthetic first-party sleeve and avatar fixtures for store captures. A ready-made own-IP screenshot rig exists in closed PR #976.

The canonical posture is a muted visual plus an official-preview audio bed. Radio audio is Fluncle's own recorded voice, and every full listen opens on Spotify or Apple Music.

**The invariant is pinned in code, and it must stay pinned.** `CardMedia`'s video rung types its audio flag as the literal `false` (`apps/mobile/src/lib/media.ts`), and `apps/mobile/src/lib/media.test.ts` asserts it as "THE 5.2.3 INVARIANT". Treat any change that enables feed-video track audio as submission-blocking. Keep store-build visuals within the preview duration.

**If mixtapes gain in-app audio** (the app already interleaves published mixtapes in the feed contract, and `radio.fluncle.com` streams observations): before adding mixtape audio, verify and document that playback remains limited to official previews and Fluncle-authored observation audio.

### 2. Minimum functionality — Guideline 4.2 ("is this just your website?")

Why it bites: the classic rejection for content apps that wrap a site.

Our posture: the app carries a working TOOL, not just content — the Decks tab is an interactive set builder (pick artists or an opener; the harmonic engine ranks what mixes in clean next by key, tempo, and feel; the chain re-ranks on every add and shares as a link). An interactive utility is the strongest possible 4.2 answer, and it sits alongside a native full-screen vertical-video pager, native push, background-audio radio, and a native archive. Low risk — lead with the Decks tool, then the native feed.

## Lower-risk hygiene

- **Spotify branding** — using the logo + "Open in Spotify" to link to Spotify is allowed under their brand guidelines; follow them and do not imply a partnership.
- **Push (4.5.4)** — must be opt-in and not required; the consent flow already satisfies this.
- **Privacy (5.1)** — supply the privacy-policy URL (we have `/privacy`, `apps/web/src/routes/privacy.tsx`) and accurate App Privacy "nutrition labels" disclosing the push token as a device identifier.
- **Optional accounts / no IAP** — The app has optional first-party email/password accounts for syncing saved tracks, sets, and preferences. Every feature remains usable while signed out. Provide in-app account deletion, data export, email verification, and password reset.
- **The suggestion box is not displayed UGC (1.2)** — Guideline 1.2 governs user-generated content that is _shown to other users_ (it wants filtering, blocking, and a report path). The suggestion box shows a submitter's input to nobody: it is a one-way, anonymous message to the operator, closer to a contact form than a feed. The abuse story is the server's, not the app's — the public `submit_track` op is rate-limited (the hourly cap the web dialog shares) and every submission is operator-reviewed before anything is ever published as a finding. Because nothing a stranger types can surface to another user, there is no moderation surface to build in-app. Worth a line in the App Review notes so it is not mistaken for a social feed.

## Before you submit (cheap moves that avoid a rejection round)

- **App Review notes:** Use the review notes to state that videos are muted, audio is limited to official previews or Fluncle's voice, and full playback opens on licensed platforms.
- **Cold open:** first launch must show real content immediately — no empty states, no "coming soon." Reviewers judge on a cold open, so seed the feed.
- **Account + entitlements:** a paid Apple Developer account (€99/yr) is required for store distribution and for TestFlight. Keep the push + associated-domains entitlements in place; the `EXPO_FREE_TEAM` strip is only for free-team local installs, never store builds. The step-by-step enrolment, build, and submit sequence is [mobile-release.md](mobile-release.md).

## Guidelines evolve

Re-read the current App Store Review Guidelines before every submission and update the cited guideline numbers if necessary.
