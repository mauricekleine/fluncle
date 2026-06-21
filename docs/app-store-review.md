# App store review — Fluncle mobile

Context for submitting the Expo app (`apps/mobile`) to the Apple App Store and Google Play. This is not a roadmap item or a checklist to action now — it is a standing read before any store submission, so the known review risks are not a surprise. The app's build and scope live in [the mobile RFC](rfcs/mobile-app.md).

## The short version

Rough odds: **~80% approved on the first or second submission.** Music apps that play previews and link out already exist on the store, and Fluncle's native vertical-video feed is genuine native value (not a web wrapper). The realistic outcome is approval with maybe one clarification round, most likely about music rights. Google Play review is far more lenient — approval there is near-certain; the friction worth planning around is Apple's.

## What the app does that review cares about

These are the facts a reviewer reacts to, grounded in the code:

- Plays **brand-rendered videos that carry the track's audio** — `footage.mp4` is the clean square master _with audio_ (see [video-variants.md](video-variants.md)). Clip length is bounded to **10–30s (20s default)** (`packages/video/src/remotion/types.ts`), i.e. preview-length, not full tracks.
- For findings without a rendered video, falls back to the **official 30s preview** (`/api/preview` → Deezer/iTunes preview endpoints), under drifting cover art.
- **Deep-links out to Spotify** ("Open in Spotify") — it drives traffic to Spotify, it is not a player substitute.
- **Opt-in push** for a new finding and a new mixtape (the consent flow in `src/push/`), nothing more.
- **No accounts, no user-generated content, no in-app purchase, no submit-a-track** in V1. It is a read-only surface over the public API.

## The two real risks

### 1. Music & video rights — Guideline 5.2 (the one to actually plan for)

Why it bites: the videos bake in commercial track audio, so to a reviewer the app reads as "a feed of videos set to commercial music" — exactly the shape that draws a _"provide documentation of your rights to this content"_ request.

Our posture: the audio is **bounded to preview length** (≤30s, 20s default), comparable to a standard streaming preview; every clip is our **own brand render**; the app **links out to Spotify** rather than replacing it; and the no-video fallback uses **official preview endpoints**. Keep store-build render duration inside the preview band (do not push `--duration-ms` past ~30s for app content) so the "this is a preview" argument stays true.

### 2. Minimum functionality — Guideline 4.2 ("is this just your website?")

Why it bites: the classic rejection for content apps that wrap a site.

Our posture: a native full-screen vertical-video pager, native push, and a native archive with the four-galaxy lens is well beyond a web wrapper. Low-to-moderate risk and easy to argue if questioned — lead with the native feed.

## Lower-risk hygiene

- **Spotify branding** — using the logo + "Open in Spotify" to link to Spotify is allowed under their brand guidelines; follow them and do not imply a partnership.
- **Push (4.5.4)** — must be opt-in and not required; the consent flow already satisfies this.
- **Privacy (5.1)** — supply the privacy-policy URL (we have `/privacy`, `apps/web/src/routes/privacy.tsx`) and accurate App Privacy "nutrition labels" disclosing the push token as a device identifier.
- **No accounts / no IAP** — a help, not a risk: it skips the Sign in with Apple requirement (5.1.1) and every payment rule (3.x) outright.

## Before you submit (cheap moves that avoid a rejection round)

- **App Review notes:** state up front that audio is official previews plus our own brand renders ≤30s and that the app links out to Spotify. Pre-empting the 5.2 question often skips the rejection round entirely.
- **Cold open:** first launch must show real content immediately — no empty states, no "coming soon." Reviewers judge on a cold open, so seed the feed.
- **Account + entitlements:** a paid Apple Developer account ($99/yr) is required for store distribution. Keep the push + associated-domains entitlements in place; the `EXPO_FREE_TEAM` strip is only for free-team local installs, never store builds.

## Guidelines evolve

Apple's rules change between submissions. Re-read the current [App Store Review Guidelines](https://developer.apple.com/app-store/review/guidelines/) at submission time. The numbers cited here (4.2, 5.2, 4.5.4, 5.1.1) are stable as of 2026-06.
