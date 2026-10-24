# Label triage rulings

Read this file once with the file-read tool, then the live enabled/disabled calibration and ratified artist rules named in your brief. Research the exact MusicBrainz MBID. The operator ratifies proposals; a worker returns evidence and never applies rulings.

## Standing boundary

- Drum & bass and jungle, including their subgenres, are in. Majors, subsidiaries, distributors, aggregators, reissue houses and compilation mills are out even when they carry DnB. A MusicBrainz `Distributor` identity or a Discogs catalogue mostly carrying other labels settles that before genre research.
- DnB-specific media imprints (Knowledge, Drum&BassArena, UKF) are in; general dance media (DJ Magazine) are out. Dubstep, grime, UKG and merely jungle-adjacent electronica are out.
- A 1990–1994 UK breakbeat-hardcore imprint styled Breakbeat/Hardcore with no house, techno, trance or happy-hardcore drift is in, even without a Jungle tag. Judge a parent separately from its hardcore sublabel: Kickin Records is out; Kickin’ Underground Sound is in.
- Two independent medium-confidence `not_dnb` passes suffice to propose disabling, except when a standing ruling conflicts; send that case to the operator.
- Decide a one-release or handful-of-releases label from a DSP genre oracle, not prose: in-lane enables, another lane disables. `unclear` is available only when no rung answers.

## Oracle ladder

Use the highest answering rung and cite its exact genre string: Apple/iTunes (`sources.apple.data.releases[].primaryGenreName`), Beatport (`sources.beatport.data.genres`, track counts/shares), Deezer album genre and `label`, Discogs release styles (`sources.discogs.data.styles.styles`), Bandcamp JSON-LD keywords. A lower rung never overrides an answering higher rung. Apple distinguishes `Jungle/Drum’n’bass`; its absence on an electronic release is evidence when Apple assigns that genre to the same artist elsewhere. MusicBrainz first-credit artists are useful genre signals; its tags/genres are usually empty. Discogs `no_link` candidates are unverified namesakes.

## Mixed catalogues and identity

- Flag a genuinely two-sided label for census, not a thin catalogue or conflation. The denominator is DISTINCT recordings, not releases. Artist exceptions fire on the FIRST credited artist MBID (recording credit, else release), never guests or names.
- Check MusicBrainz `labelRelations` first. An existing child imprint covering the boundary means propose no artist rules; rule that entity instead.
- Raw off-lane first-credit share ≤15% permits `dnb` plus blocks. Above 15%, propose `dnb_partial` plus allows for in-lane acts with their own DnB run, or `not_dnb` when the in-lane credits are incidental. `dnb_partial` leaves the seed state as it stands.
- Also report residual share after globally ruled off-lane credits are dropped. Residual is never the rail. When residual ≤15% < raw, return `unclear` with the globally ruled acts and counts for the operator. A census sampling caveat can also make the share unreliable: copy it verbatim and lower confidence.
- Every proposed rule needs a positive first-credit count. Include separate collaboration MBIDs; verify same-named acts separately. Proposals replace the whole per-label rule set, so account for existing exceptions. Global rules and visibility-only `unlisted` rulings belong to the operator; suggest globals only in prose.
- A conflated MBID is never carved with rules. If no strand is in lane, return `not_dnb`. If a DnB strand exists, return `unclear` with `conflation`: the strand to keep and its catalogue scheme, releases to move with artists/catalogue numbers/years, whether DnB is recoverable, and traps such as metadata pointing to the strand being moved or another namesake.
- `unclear` has three reasons: thin (no oracle answers), mixed (unreliable census or straddling shares), conflation (a DnB strand needs an upstream split). Missing or timed-out evidence goes back to the coordinator for collection before a verdict.
