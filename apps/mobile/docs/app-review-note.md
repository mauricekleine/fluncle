# App Review note — Guideline 5.2.3 (paste into App Store Connect → Review Notes)

Operator paste-ready. Factual, specific, no over-claims. Update only if the audio/video sources below change.

---

Thank you for the review. This note documents exactly how Fluncle sources the audio and video it plays, addressing the Guideline 5.2.3 concern about access to third-party audio/video streaming or catalogs.

**What Fluncle is.** Fluncle is a discovery app for a curated, first-party catalog of drum & bass tracks ("findings"). The catalog and all of its metadata are Fluncle's own database. Fluncle is not a streaming service and does not host, stream, or provide access to full-length commercial recordings.

**All audio that plays inside the app is one of two sources, and only these two:**

1. **Short official preview clips (about 30 seconds).** These are the official preview assets exposed by the platforms' own preview APIs — Apple's iTunes / Apple Music preview assets and Deezer's preview API. Fluncle's own server relays the platform's preview stream to the app without modification (it passes the upstream bytes through, honoring HTTP range requests). These are the same public preview clips those platforms serve for their own search and preview features.

2. **Fluncle's own spoken "observations."** On the Radio tab, the audio is Fluncle's own original voice recordings — short spoken notes about a track that we record and produce ourselves. This is first-party audio; it is not a music recording.

**All video in the app is first-party, produced by Fluncle.** The feed's short clips are our own artwork animations that we render. In this resubmitted binary, the feed videos play **muted** — they are shown purely as silent visuals, and the accompanying sound is the official ~30-second preview described in (1) above. No video in the app plays a full commercial recording.

**The app hosts and streams no full recordings.** There is no control anywhere in the app that plays a full-length track. Every "full listen" action is an outbound link that opens the official service — Spotify or Apple Music — where playback happens on that licensed platform, not inside Fluncle.

**Summary of the change in this build:** the previous build's feed videos carried a short baked audio excerpt. This build removes that: feed videos are now muted visuals, and every second of audio the user can hear in the app is either an official platform preview clip (Apple / Deezer preview APIs) or Fluncle's own recorded voice. Full playback is always handed off to Spotify or Apple Music via a link out.

We're happy to provide any further detail. Thank you.
