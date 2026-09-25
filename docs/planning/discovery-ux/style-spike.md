# Discogs and MusicBrainz style seed spike

Read-only production snapshot: 24 September 2026. This is a measurement for the [Discovery UX programme](./README.md), not a style-engine specification. Q12, Q13, Q15a, Q16 and Q32 in [decisions.md](./decisions.md) govern the product decision.

## Decision

This decision covers **inferred** styles (a label assigned per track). The anchor-probe route Q15a chose instead, a style as a re-ranking probe, is measured separately in [Anchor-probe ranking gate](#anchor-probe-ranking-gate) below, where Liquid and Neurofunk clear their bar.

**No inferred style set clears the full gate yet.** Discogs release styles supplied enough Jungle and Halftime seeds for a two-class test. MusicBrainz artist tags supplied enough Liquid and Neuro seeds for artist-grouped testing. Some two-style combinations clear 75% held-out accuracy, but no eligible one- to four-style set supports a stable open-set rejection threshold across the independent artist folds. None demonstrates the 90% print-precision gate with background controls. Do not turn these measurements into automatic rank assignments or inferred public chips. Use Q13's typed lexicon and artist-anchor fallback for the missing fan vocabulary, and require a new held-out and open-set check before an anchor-derived style ships. Q16's direct Discogs seed exemption remains distinct from an artist-tag-derived label.

| Round                                  | Candidate | Seed tracks | Held-out centroid accuracy | Five-neighbour accuracy | Result                             |
| -------------------------------------- | --------- | ----------: | -------------------------: | ----------------------: | ---------------------------------- |
| 1: Discogs-only, two classes           | Jungle    |       2,368 |                      79.8% |                   96.0% | Closed-set seed/accuracy gate only |
| 1: Discogs-only, two classes           | Halftime  |         407 |                      84.3% |                   50.9% | Closed-set seed/accuracy gate only |
| 2: Discogs + artist tags, four classes | Jungle    |       1,657 |                      55.9% |                   80.7% | Fails 75% centroid gate            |
| 2: Discogs + artist tags, four classes | Halftime  |         261 |                      55.9% |                   22.6% | Fails 75% centroid gate            |
| 2: Discogs + artist tags, four classes | Liquid    |         474 |                      54.2% |                   34.0% | Fails 75% centroid gate            |
| 2: Discogs + artist tags, four classes | Neuro     |         345 |                      71.9% |                   78.3% | Fails 75% centroid gate            |

The rounds use different candidate vocabularies and fold groups, so their percentages are not a before/after improvement measure. Round 1 groups tracks by release and has no “none” class; Round 2 groups all credited artists together and adds background controls. The centroid is the proposed engine; kNN is a geometry check, not a replacement decision rule.

## Sources and seed rule

Production held 32,759 albums, 149,972 tracks and 48,756 embeddings. Of 16,010 resolved Discogs albums, 2,861 named exactly one of the observed DnB substyles, yielding 2,368 Jungle and 407 Halftime embedded tracks in Round 1. Ten albums named both and were excluded. “Drum n Bass” is a parent label, not a substyle; cross-genre labels such as Hardcore and Breakbeat are not silently converted into DnB styles. The [Round 1 script](../../../scripts/discovery/style_spike.py) tested five release-grouped folds and a uniform random sample of 2,000 embedded tracks. Its 90% aggregate closed-set print margin concealed poor inferred Halftime precision (57.2% at that margin) and no background rejection, so it did not validate public chips.

For Round 2, the local MusicBrainz artist dump was streamed and joined by `artists.mbid`. The dump contained 2,938,889 artist records; 14,104 of 14,174 unique requested MBIDs matched, with 70 absent. Production had 17,732 artists, 14,254 artist rows with an MBID, 65,746 embedded-track performer edges, and 48,703 embedded tracks with a performer edge. Repeated Fluncle rows can share an MBID. The source dump was dated July 2026; its tags and the September production catalogue are different snapshots.

A MusicBrainz artist seeds a substyle only when its strongest DnB substyle has at least two votes and at least 60% of its DnB substyle votes. Genre and tag entries for the same spelling contribute their maximum vote count, not duplicate votes. Bare ambiguous words such as “liquid,” “minimal,” and “dancefloor” require a DnB parent tag. Artists with competing substyles, conflicting credited collaborators, or a MusicBrainz–Discogs disagreement do not seed those tracks. Each credited artist is capped at 40 seed tracks; multi-artist credit components stay together in evaluation folds. Of 216 overlapping candidate tracks whose sources agreed, 206 appear in the capped seed set; 75 source disagreements were excluded. The final capped set has 2,890 seeds: 1,423 MusicBrainz-only, 1,261 Discogs-only, and 206 supported by both.

| Style       | Combined capped tracks | Distinct credited seed artists | MusicBrainz-only / Discogs-only / both | Source and gate                          |
| ----------- | ---------------------: | -----------------------------: | -------------------------------------: | ---------------------------------------- |
| Jungle      |                  1,657 |                            525 |                      398 / 1,076 / 183 | Both; accuracy and rejection fail        |
| Halftime    |                    261 |                             89 |                          53 / 185 / 23 | Both; accuracy and rejection fail        |
| Liquid      |                    474 |                             16 |                            474 / 0 / 0 | MusicBrainz; accuracy and rejection fail |
| Neuro       |                    345 |                             14 |                            345 / 0 / 0 | MusicBrainz; accuracy and rejection fail |
| Techstep    |                     77 |                              2 |                             77 / 0 / 0 | Too few tracks and artists               |
| Dancefloor  |                     74 |                              2 |                             74 / 0 / 0 | Too few tracks and artists               |
| Atmospheric |                      2 |                              1 |                              2 / 0 / 0 | Too few tracks and artists               |

Jump Up, Darkstep, Minimal, Drumfunk and Rollers produced no qualifying capped seeds under this rule. At the chosen 60% vote share, dominant MusicBrainz artists numbered Jungle 53, Liquid 16, Neuro 15 and Halftime 4 before track and credit exclusions. Liquid changes from 17 to 16 dominant artists when the share moves from 50% to 60%, then to 12 at 70%; Neuro changes 15 → 15 → 11, and Jungle 53 → 53 → 51. Most catalogue tag appearances have only one vote, so the two-vote floor matters more than a small change in share. The script records per-alias evidence and DnB-looking tags left unmapped for review.

## Artist-held-out and open-set evidence

The script L2-normalises each 1,024-dimensional MuQ vector, trims the farthest 10% of each training class, and fits a normalised centroid. Five folds keep every connected component of credited artists in one partition. The four-class evaluation held out 4,823 tracks: 2,737 seeds of those four styles, 153 sparse-style seeds, 1,465 parent-only controls, and 468 weak/untagged controls. The four-class confusion below shows the four evaluated seed styles and the controls; the 153 sparse-style rows are omitted from this compact matrix. This is **forced choice without rejection**.

| Actual → predicted       | Halftime | Jungle | Liquid | Neuro |
| ------------------------ | -------: | -----: | -----: | ----: |
| Halftime                 |      146 |     33 |     30 |    52 |
| Jungle                   |      186 |    927 |    335 |   209 |
| Liquid                   |       77 |     86 |    257 |    54 |
| Neuro                    |       51 |     24 |     22 |   248 |
| Parent-only background   |      271 |    158 |    552 |   484 |
| Weak/untagged background |      143 |     79 |    126 |   120 |

The forced-choice **aggregate** background false-positive rate is 100% because every control receives a style. By predicted style, the parent-only assignment rates are Halftime 18.5%, Jungle 10.8%, Liquid 37.7% and Neuro 33.0%; the weak-control rates are 30.6%, 16.9%, 26.9% and 25.6%. These are diagnostic false positives _before_ a rejection threshold. No independently calibrated threshold survived every artist fold, so a post-rejection FPR and ≥90% print precision are **unmeasured**, not zero. The two control groups are a capped case-control sample with metadata proxy labels, so even a measured precision on them would not estimate catalogue-wide print precision without a deployment prevalence estimate or independently labelled random recordings.

The script also tests each eligible singleton and every two-, three- and four-style subset, recalibrating each vocabulary separately. In the two-style forced-choice tests, Liquid/Neuro scored 81.2%/84.9% held-out centroid accuracy and Halftime/Jungle 78.2%/78.7%. Neither pair passed the independent open-set rank floor, and none of the eleven multi-style sets passed print. A singleton predicts its sole style for every track before rejection, so its accuracy gate uses binary balanced accuracy after a calibrated threshold, with other known styles and both control groups as negatives. Halftime and Liquid calibrated zero of five rank folds; Jungle and Neuro calibrated two of five, with partial-fold balanced accuracy of 50.1% and 51.5% respectively. No singleton passed the rank gate or calibrated a print threshold. Set selection on this same data is exploratory and would need fresh validation even if one had passed. For each outer test fold, threshold calibration uses a separate artist fold and centroids fitted on the remaining folds; the outer fold does not choose its own threshold.

## Coverage, writes and remaining gap

The **passing** rank and inferred-print sets are empty. Their projected coverage of the 1,898 nonseed tracks in the Round 1 random sample is therefore zero, with zero first-run and nightly assignment writes for an inferred style engine that obeys these gates. This zero excludes the 1,467 capped Discogs-only or both-source seeds, which retain separate direct provenance under Q16. It is a gate decision, not evidence that no catalogue track has a recognisable style. Round 1's two-class, no-rejection projection would have assigned about 23,913 of 48,756 embedded tracks to its style-specific rank rails and about 21,879 to its provisional print rails; those figures are deliberately not carried into the recommendation because Round 2 exposes background errors. With no deployed inferred set, there is no meaningful nightly style churn estimate. Any future engine should write only inserts, changes and clears; actual churn requires a second snapshot, while its initial backlog should drain in bounded batches.

The remaining fan words need Q13's typed aliases and optional artist anchors, checked against Fluncle artist centroids. MusicBrainz provides artist-level evidence for Liquid and Neuro but no validated recording label; Jump Up, Dancefloor, Minimal, Darkstep, Rollers and the other sparse styles need better anchors or labelled recordings. A future gate should reserve independently labelled random embedded tracks to establish background prevalence and public-chip precision, and repeat artist-held-out evaluation after seed or vocabulary changes. Direct Discogs release labels retain their Q16 provenance exemption; MusicBrainz-only seeds never inherit it.

## Reproduce

The [script](../../../scripts/discovery/style_spike.py) keeps all row data and vectors outside the repository. Its production pulls are SELECT-only with count and row caps. Round 1 used 32,759 album rows, 2,889 candidate vectors before resolution exclusion, and a 2,000-track random sample. Round 2 used 17,732 artist rows, 65,746 embedded performer edges, 3,316 new vectors and the Round 1 vectors, 8,097 unique vector rows in total. The new-vector CSV is about 40 MB. Only requested track IDs use `vector_extract`.

```sh
uv run --with numpy scripts/discovery/style_spike.py pull --db '<database-name>' --seed-style jungle --seed-style halftime --max-seed-vectors 5000 --sample-limit 2000 --output-dir /tmp/style-spike-data
uv run --with numpy scripts/discovery/style_spike.py pull-artist-links --db '<database-name>' --output-dir /tmp/style-spike-data --max-artists 25000 --max-performer-edges 80000
uv run --with numpy scripts/discovery/style_spike.py extract-mb-artists --dump '<local-artist.tar.xz>' --artist-map /tmp/style-spike-data/artist-map.csv --output /tmp/style-spike-data/artists.jsonl
uv run --with numpy scripts/discovery/style_spike.py select-artist-tracks --artist-map /tmp/style-spike-data/artist-map.csv --track-artists /tmp/style-spike-data/track-artists.csv --mb-artists /tmp/style-spike-data/artists.jsonl --tracks /tmp/style-spike-data/tracks.csv --output /tmp/style-spike-data/selected-track-ids.csv --expected-credit-edges '<observed-count>'
uv run --with numpy scripts/discovery/style_spike.py verify-artist-credits --db '<database-name>' --track-ids /tmp/style-spike-data/tracks.csv --track-ids /tmp/style-spike-data/selected-track-ids.csv --track-artists /tmp/style-spike-data/track-artists.csv
uv run --with numpy scripts/discovery/style_spike.py pull-artist-vectors --db '<database-name>' --selected-track-ids /tmp/style-spike-data/selected-track-ids.csv --tracks /tmp/style-spike-data/tracks.csv --output /tmp/style-spike-data/new-vectors.csv --max-vectors 12000
uv run --with numpy scripts/discovery/style_spike.py analyze-artists --artist-map /tmp/style-spike-data/artist-map.csv --track-artists /tmp/style-spike-data/track-artists.csv --mb-artists /tmp/style-spike-data/artists.jsonl --albums /tmp/style-spike-data/albums.csv --tracks /tmp/style-spike-data/tracks.csv --new-vectors /tmp/style-spike-data/new-vectors.csv --expected-credit-edges '<observed-count>' --output /tmp/style-spike-data/report.json
```

Carry the `pull-artist-links` edge count into `--expected-credit-edges`; a mismatch rejects analysis. The random catalogue sample has no trusted style labels. Discogs release styles and MusicBrainz artist tags are noisy proxies for track sound, and a catalogue embedding can change as enrichment proceeds. Beatport data is excluded by the programme decision.

## Anchor-probe ranking gate

The Q15a outcome turns a style into an anchor-artist sonic probe that re-ranks the catalogue, so the gate measures ranking precision rather than per-track assignment. For each candidate, 3–8 anchor artists that have a stored centroid average into one probe (the mean of means, exactly what the product ranks with), and one read-only exact scan ranks all 49,023 embedded tracks by cosine distance to it, 300 deep. The generalisation view removes every track credited to an anchor before scoring, so a style must reach past its own anchors. A track is positive for a style when its album's Discogs styles or a credited artist's MusicBrainz tags name it, negative when they name only other styles, and unlabelled otherwise. Every attempt is kept in `results.json`; liquid, neurofunk and jungle had a second anchor set.

**The bar.** The weak labels reach only 14–42% of any probe's top 50, and they are about as sparse in a uniform random sample of 2,000 embedded tracks (547 labelled, 27%), so an unlabelled row is missing evidence rather than evidence of another style. A bar that counts unlabelled rows as misses (the first pass of this gate: 26/50 positives at 60% coverage) is unreachable by construction, for any style, at this coverage. So "mostly that style" is measured where evidence exists: among the labelled non-anchor results, the style must be the majority with 95% confidence (Wilson lower bound above 50%), with at least ten labelled rows, at the top 50 and again at the top 100 (so a lucky head does not carry it), and at 1.5× or more of its share of labelled tracks in the random sample. The conservative overall P@50 and coverage stay in the table for reference.

| Style        | Anchors | Top 50 labelled (precision, lower bound) | Top 100 labelled    | Labelled base rate | Lift | Overall P@50 / coverage | Ships                                  |
| ------------ | ------: | ---------------------------------------- | ------------------- | -----------------: | ---: | ----------------------- | -------------------------------------- |
| Liquid       |       6 | 10/11 (91%, LB 62%)                      | 26/29 (90%, LB 74%) |              43.7% | 2.1× | 20% / 22%               | **yes**                                |
| Neurofunk    |       4 | 10/12 (83%, LB 55%)                      | 19/24 (79%, LB 60%) |              15.0% | 5.6× | 20% / 24%               | **yes**                                |
| Jungle       |       4 | 7/17 (41%, LB 22%)                       | 14/26 (54%, LB 35%) |              56.1% | 0.7× | 14% / 34%               | no                                     |
| Jump Up      |       5 | 0/17 (0%, LB 0%)                         | 0/34 (0%, LB 0%)    |               2.0% | 0.0× | 0% / 34%                | no                                     |
| Dancefloor   |       5 | 0/9 (0%, LB 0%)                          | 1/18 (6%, LB 1%)    |               2.0% | 0.0× | 0% / 18%                | no                                     |
| Halftime     |       4 | 0/7 (0%, LB 0%)                          | 1/21 (5%, LB 1%)    |               5.9% | 0.0× | 0% / 14%                | no                                     |
| Minimal      |       5 | 0/17 (0%, LB 0%)                         | 0/27 (0%, LB 0%)    |               4.6% | 0.0× | 0% / 34%                | no                                     |
| Rollers      |       4 | 0/12 (0%, LB 0%)                         | 0/24 (0%, LB 0%)    |               0.0% |    — | 0% / 24%                | no                                     |
| Techstep     |       4 | 0/9 (0%, LB 0%)                          | 1/18 (6%, LB 1%)    |               4.4% | 0.0× | 0% / 18%                | no                                     |
| Darkstep     |       3 | 0/16 (0%, LB 0%)                         | 1/26 (4%, LB 1%)    |               1.6% | 0.0× | 0% / 32%                | no                                     |
| Atmospheric  |       4 | 0/14 (0%, LB 0%)                         | 0/28 (0%, LB 0%)    |               4.4% | 0.0× | 0% / 28%                | no                                     |
| Drumfunk     |       0 | —                                        | —                   |               2.2% |    — | —                       | no (no three centroid-bearing anchors) |
| Ragga Jungle |       0 | —                                        | —                   |               0.9% |    — | —                       | no (no three centroid-bearing anchors) |

**Result: Liquid and Neurofunk ship; the other eleven do not.** Liquid (calibre, nu-tone, logistics, etherwood, technimatic, lsb) and Neurofunk (joe-ford, nickbee, black-sun-empire, audio) are the majority of their labelled neighbours at both depths with lower bounds well above one half and clear lift. Jungle's labelled neighbours are half jungle, no better than its 56% share of labelled tracks at random, and every other candidate has at most a handful of labelled positives. Styles that fail are dropped from the lexicon rather than kept as search aliases: a probe that does not sound like its word would answer "jungle" with something else, which is worse than the name tiers answering it.

**Caveats (accepted by the operator, decisions Q15a (chips)).** The labelled rows are not a random subset of the ranking: MusicBrainz tags cluster on better-known artists (popularity bias), and an artist tag labels a whole discography even when only part of it fits the style, so labelled precision is optimistic where the unlabelled mass differs. The labels are correlated: rows sharing an artist or a release carry the same tag, so the Wilson bound treats them as more independent observations than they are, and the top 100 contains the top 50 rather than confirming it independently. The anchor sets were chosen by comparing attempts on the same data the gate evaluates, so the confidence is not an unqualified 95%. An independent check would freeze the anchors and criteria, then judge previously unlabelled results by ear, accounting for artist and release clustering. Neurofunk's anchors carry thin centroids (one to four finding vectors each), so a centroid recompute can move its probe more than Liquid's; the post-deploy probe fails if any anchor stops resolving, and a re-measure is due whenever the anchors or the catalogue shift materially. The random sample predates the current catalogue. Beatport data is excluded by the programme decision.

**Galaxy profiles** (the evidence behind each galaxy's plain sound line; weak styles are evidence counts, not labels): Lunar, 16 findings, median 174 BPM, 14/16 minor keys, median release 2020, liquid-leaning (Netsky, Pola & Bryson, Technimatic). Solar, 46, 174 BPM, 35/38 minor, 2018, liquid 9 and jungle 4 (Whiney, Krakota, Ownglow, Askel & Elere, 1991, Urbandawn). Nebular, 38, 174 BPM, 28/32 minor, 2017, liquid 9 and jungle 7 (Command Strange, Archangel, Monrroe, Zero T, GLXY). Pulsar, 16, 174 BPM, 13/15 minor, 2025, remixes of songs from outside drum & bass (Birdy, Sarah McLachlan, Delerium, Kate McGill, John Summit) beside 1991 and Lexurus.

Reproduce (scratch outside the repository; the anchor manifests are `{"style":"liquid","anchors":["calibre","nu-tone","logistics"]}` files, one per attempt):

```sh
SCRATCH=/tmp/style-gate
uv run --with numpy scripts/discovery/style_gate.py pull-centroids --db '<database-name>' --output "$SCRATCH/centroids.jsonl"
uv run --with numpy scripts/discovery/style_gate.py pull-galaxies --db '<database-name>' --output-dir "$SCRATCH"
for spec in "$SCRATCH"/anchors/*.json; do uv run --with numpy scripts/discovery/style_gate.py rank --db '<database-name>' --centroids "$SCRATCH/centroids.jsonl" --anchors "$spec" --output "$SCRATCH/ranks/${spec##*/}"; done
uv run --with numpy scripts/discovery/style_gate.py pull-metadata --db '<database-name>' --rank-dir "$SCRATCH/ranks" --sample '<spike-data>/sample.jsonl' --findings "$SCRATCH/findings.jsonl" --output "$SCRATCH/fresh.jsonl"
uv run --with numpy scripts/discovery/style_gate.py pull-collisions --db '<database-name>' --output "$SCRATCH/collisions.jsonl"
uv run --with numpy scripts/discovery/style_gate.py report --albums '<spike-data>/albums.csv' --tracks '<spike-data>/tracks.csv' --sample '<spike-data>/sample.jsonl' --artist-map '<spike-data>/artist-map.csv' --links '<spike-data>/track-artists.csv' --mb-dump '<spike-data>/artists.jsonl' --fresh "$SCRATCH/fresh.jsonl" --rank-dir "$SCRATCH/ranks" --galaxies "$SCRATCH/galaxies.jsonl" --findings "$SCRATCH/findings.jsonl" --collisions "$SCRATCH/collisions.jsonl" --output "$SCRATCH/results.json"
uv run --with numpy --with pytest pytest scripts/discovery/test_style_gate.py
```

`<spike-data>` is the output directory of the earlier spike's pulls (Reproduce, above). Each ranking is SELECT-only and bounded; a text-bound probe makes the offline scan slow (about 17 s per style), which is why the product binds its probe as a raw BLOB and ranks on Sonar.
