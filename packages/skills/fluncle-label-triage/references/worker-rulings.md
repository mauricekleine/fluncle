# Label triage rulings

Read once with the file-read tool, then calibration/rules. Exact MBID; propose, never apply.

## Standing boundary

- DnB/jungle and their subgenres are in. Majors, subsidiaries, distributors, aggregators, reissue houses and compilation mills are out, even carrying DnB. MB Distributor/mostly licensed catalogue settles this.
- DnB media imprints (Knowledge, Drum&BassArena, UKF) are in; general dance media (DJ Magazine), dubstep/grime/UKG and jungle-adjacent electronica are out.
- 1990–1994 UK Breakbeat/Hardcore with no house/techno/trance/happy-hardcore drift is in without a Jungle tag. Judge parents separately: Kickin Records out; Kickin’ Underground Sound in.
- Two independent medium-confidence not_dnb passes suffice; standing-ruling conflicts go to operator.
- For few releases use the highest DSP genre oracle; unclear only if none answers.

## Oracle ladder

Apple → Beatport → Deezer album genre/label → Discogs aggregate release styles → Bandcamp JSON-LD keywords. Cite the exact genre; higher answers win. Apple distinguishes Jungle/Drum’n’bass; its absence matters when Apple assigns it elsewhere to that artist. MB first credits signal genre; tags/genres are usually empty.

## Mixed/identity

Census mixed labels, not thin ones/conflations. Count DISTINCT recordings; rules match FIRST artist MBID (recording credit, else release). Check labelRelations: rule an existing boundary imprint instead of artists.

Raw off-lane share ≤15% permits dnb + blocks; above it use dnb_partial + allows for acts with their own DnB run, else not_dnb for incidental credits. dnb_partial preserves seed state. Report residual after dropping globally ruled off-lane credits, never as the rail. residual ≤15% < raw means unclear with globally ruled acts/counts. Copy census caveat and lower confidence. Each rule needs positive first credits; include collaboration MBIDs, verify namesakes, account for existing rules: proposals replace all per-label rules. Globals/unlisted belong to the operator; suggest globals in prose.

Never carve conflation: not_dnb if no DnB strand; otherwise unclear with conflation: strand/catalogue scheme to keep, releases/artists/catnos/years to move, recoverable DnB, moved-strand metadata/namesakes. unclear reasons: thin (no oracle), mixed (unreliable census/straddle), conflation. Failed collection returns to coordinator before a verdict.

## Evidence layout

Read text summaries first. Supplemental lookup: one artist per foreground Bash call, timeout 600000. Use task completion; if unavailable, return missing lookup to coordinator, never wait on files.

JSON shape: top-level `label`, `fetchedAt`, `ok`, `partial`, `requests`, `errors`, `sources`. `sources.<name>` has status `ok|partial|error|no_link|not_configured|skipped`; `data`, `errors`, `note`, `cached` may be absent. `?` optional; Count: `{name:string,count:number}`.

- MB data: optional `label`, `releases`, `census` objects. `sources.musicbrainz.data.releases.releases[]` items: `{artist:string,title:string,mbid:string,barcode:string|null,catno:string|null,date:string|null,format:string|null,status:string|null}`. `releases` OBJECT: numeric `releaseCount`, `releasesRead`, `variousArtistsReleases`, plus `firstCreditArtists[]:{mbid:string,name:string,releases:number}`. `census.firstCredits[]:{artistMbid:string,artistName:string,recordings:number}`; numeric `recordingsCounted`, `uncreditedRecordings`, `pagesFetched`, `releaseCount`, `releasesRead`; `sampled:boolean`, `caveat:string|null`. Imprints: `label.labelRelations[]:{direction:string,mbid:string,name:string,type:string}`. Nullable: label area/country/disambiguation/type and lifeSpan begin/end are string|null; labelCode is number|null.
- Discogs data: optional `label`, `releases`, `styles`, `candidates`. `sources.discogs.data.releases.sample[]` items: `{artist:string,title:string,catno:string|null,format:string|null,year:number|null}`. `releases` OBJECT: `releaseCount:number` and `sources.discogs.data.releases.topArtists[]:{name:string,releases:number}`. No item styles: `sources.discogs.data.styles.styles[]` and `.styles.genres[]` are Count arrays over releases; numeric releasesRead/labelReleasesListed/viaRelease/viaSearch. `label` has profile/name/url strings, numeric id/sublabelCount, string[] sublabels/urls, parentLabel null or `{id:number,name:string}`. `candidates[]:{id:number,title:string,url:string}` are unverified namesakes.
- Beatport data: `sources.beatport.data.genres[]:{name:string,count:number,share:number}` (share 0–1); `subGenres`/`topArtists` Count arrays; `trackCount:number`, `labelUrl`/`tracksUrl` strings. No releases.
- Apple data: `found`/`looked` numbers, `genres` Count array, `sources.apple.data.releases[]:{barcode:string,mbTitle:string,found:boolean,artistName?:string,collectionName?:string,copyright?:string,primaryGenreName?:string}`. Match fields optional; unmatched: barcode/mbTitle/found only.
