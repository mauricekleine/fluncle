# Discovery UX: research

Evidence behind the [personas](./personas.md) and [user stories](./user-stories.md). Gathered 2026-09-24 with the Firecrawl CLI (search + scrape), the Arctic Shift Reddit archive (Firecrawl refuses reddit.com), and a real browser for the platform teardown. Quotes are verbatim and trimmed with "…"; usernames are dropped. This is a planning brainstorm, never specification: where it disagrees with PRODUCT.md, DESIGN.md, or VOICE.md, canon wins.

**Skew.** r/DnB leans older and UK-heavy, and TikTok itself could not be scraped, so the Gen-Z voice is under-sampled and leans on the market data below to size it.

## 1. The audience in numbers

| Claim                                                                                         | Number      | Year       | Source                                                                                                                                                                                           |
| --------------------------------------------------------------------------------------------- | ----------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| UK DnB streams on Spotify since 2021                                                          | +94%        | 2021→24    | [DJ Mag](https://djmag.com/news/drum-bass-streams-increased-94-past-three-years-spotify-reports)                                                                                                 |
| Spotify DnB listeners under 34                                                                | 68%         | 2024       | DJ Mag; [MusicRadar](https://www.musicradar.com/music-industry/streaming-sharing/spotify-says-streams-of-drum-n-bass-are-up-94-percent-over-the-last-three-years)                                |
| "BACKBONE" (Chase & Status, Stormzy): most-streamed UK DnB tune, UK #1                        | #1          | 2024       | [Official Charts](https://www.officialcharts.com/chart-news/chase-and-status-stormzy-backbone-number-1-single/)                                                                                  |
| DnB artists' TikTok followers aged 18–24 / 25–34                                              | 49% / 31%   | 2024       | [Chartmetric](https://hmc.chartmetric.com/drum-and-bass-gen-z-uk-electronic-music/)                                                                                                              |
| DnB artists' Instagram followers aged 25–34 / 18–24                                           | 46% / 29%   | 2024       | Chartmetric                                                                                                                                                                                      |
| DnB on Beatport: #2 for new releases; sales rank #3 → #4                                      | —           | 2024–25    | [MIDiA IMS 2025](https://www.midiaresearch.com/blog/ims-business-report-2025); [Billboard IMS 2026](https://www.billboard.com/lists/ims-ibiza-2026-ims-business-report-key-takeaways-streaming/) |
| Rampage Open Air record attendance; Let It Roll draws from 60+ countries                      | 66,000; 60+ | 2025; 2024 | [Hard News](https://hardnews.nl/en/rampage-open-air-drops-harder-styles-on-the-line-up/); [Let It Roll](https://letitroll.eu/history/)                                                           |
| 16–24s naming TikTok a main discovery source (all ages: 37%)                                  | 51%         | 2025       | [MIDiA](https://www.midiaresearch.com/blog/gen-z-social-habits-spell-trouble-for-music-discovery)                                                                                                |
| 16–24s who went on to hear more of a new artist they loved                                    | 19%         | 2025       | MIDiA (same)                                                                                                                                                                                     |
| 16–24s on TikTok weekly vs ever used "add to music app"                                       | 75% vs 31%  | 2025       | MIDiA (same)                                                                                                                                                                                     |
| Discovering via niche sources (blogs, magazines) goes with more time and money spent on music | —           | 2023       | [MIDiA](https://www.midiaresearch.com/blog/music-discovery-in-2023-is-about-the-journey-not-the-moment)                                                                                          |
| New tracks delivered to streaming services per day; tracks under 1,000 streams                | 106k; 88%   | 2025       | [Music Ally](https://musically.com/2026/01/15/5-1tn-annual-music-streams-but-120-5m-tracks-had-10-or-fewer/)                                                                                     |
| Nordic listeners who want AI music filtered out of recommendations                            | 74%         | 2026       | [CISAC](https://www.cisac.org/Newsroom/society-news/nordic-digital-music-survey-2026-consumers-demand-control-over-ai-generated)                                                                 |
| Songs skipped within 5 seconds; EDM listeners scrub to the drop                               | ~25%        | 2019       | [arXiv 1903.06008](https://arxiv.org/html/1903.06008v1)                                                                                                                                          |
| Skip rate mobile vs desktop (old data)                                                        | 51% vs 40%  | 2014       | [Hypebot](https://www.hypebot.com/new-data-reveals-almost-25-of-people-skipping-song-within-5-seconds/)                                                                                          |
| US "superfans" (the rest are casual)                                                          | ~20%        | 2024       | [Luminate](https://luminatedata.com/blog/supercharge-your-super-fan-strategy/)                                                                                                                   |

Could not be sourced: DnB's share of all streaming, festival demographics, Shazam genre data, mobile share of music browsing specifically.

## 2. The fans in their own words

Fifteen behavioural segments came out of 57 Reddit threads (mostly r/DnB, 2023–26), a Dogs On Acid thread, and Pitchfork / i-D coverage of the Gen-Z wave. They collapse into the five personas; the strongest quotes per segment:

- **Festival convert.** "Thought I could give the DnB stage a try and I gotta admit, it kinda slaps." · "I listened to Sub Focus - Solar System and it blew my mind … what are the following levels?"
- **ID hunter.** "90% of the time I try to ID it with … Shazam, it keeps coming up with no results, and a few months later the song is released."
- **Present-moment raver.** "When I'm raving I don't take my phone out. If I hear a song I love, I just cherish the moment."
- **Lean-back rider.** "I click on a song I like and let autoplay take it away … and I add the best to my apple music playlist."
- **Weekly ritualist.** "My go-to for new tunes, benefiting from someone's hard work so I don't have to!"
- **Set listener.** "Listening to tracks unmixed is like going to the zoo when you had the opportunity to go on safari."
- **TikTok wave.** "[PinkPantheress] has a few snippets on tiktok that I absolutely love but I can't quite pin down the genre to find more alike and completed songs."
- **Functional listener.** "jump up DnB, timing the drop when lifting especially." · "Running at the BPM is the ultimate pace setter!"
- **Soundtrack kid.** "Forza Horizon 4's Hospital station." · "this was a radio in gta 3 when I was like 12 yo this got me to dnb"
- **Vibe seeker.** "like nasty nasty bass-y, and not too many sad vocals … songs that make me feel like I'm on uppers" · "This tune sent me to saturnus."
- **Returner.** "I'm a 53 year old OG junglist … (knees can't take it) so I just follow labels."
- **Evangelist.** "Friends always asking me for new gems … I'm happy to get the kudos, ngl."
- **Rabbit-hole digger.** "Find labels you enjoy. Get everything. Sift through it. Slowly fall in love with it all."
- **Bedroom DJ.** "you can tell whether or not you like a track within the first few seconds of hearing it."
- **Authenticity guard (cross-cutting, rising).** "AT LEAST TELL ME IF ITS AI OR NOT" · "artwork always screams of ai"

**How they judge a track fast:** the first seconds and the drop, the label, the cover (as an AI tell), and hearing it more than once in sets. **What they do after:** save to a playlist, follow the label or artist, buy on Bandcamp, send it to mates, rinse it.

**Vocabulary they actually use.** Praise: banger, tune ("They're not songs, they're tracks or tunes"), big tune, heater, slaps, goes hard, gem, lush, filthy. Sets: ID?, tracklist, dub, VIP, double drop, rinse. Styles: liquid, jump up, neuro, rollers, jungle, dancefloor, minimal, steppers. Newcomer tells: "songs", "Spotify friendly", "I don't know the word for it", "the following levels".

**Top frustrations.** (1) Shazam fails on DnB. (2) Unreleased dubs. (3) The algorithm loops the same tracks. (4) AI tracks in recommendations. (5) Too much to get through. (6) Always behind the crowd. (7) Scattered, broken tools ("bandcamp is key but its shit for discovery"). (8) Discovery depends on Instagram. (9) No map of the subgenres ("the breakbeats make all of it sound exactly the same to me"). (10) Gatekeeping toward newcomers.

**Top delights.** (1) The community naming a 3-second clip within the hour. (2) Timestamped tracklist commenters. (3) The first-hear "what is this?!" jolt. (4) The room going electric on a double drop. (5) A lost tune resurfacing. (6) A trusted human doing the weekly sift. (7) Rabbit holes that compound ("I asked for a song ID and got a whole new set!"). (8) Being the friend with the gems. (9) A daily drip of new tunes. (10) Stumbling on a classic.

**The job, in one line:** _that feeling again, with a name on it._ A fan arrives from a moment (a rave, a set, a clip, a run) and wants to leave with a tune they can keep and share.

## 3. What other discovery tools do

Teardown of Bandcamp, Beatport, 1001tracklists, RA, UKF, label shops (Hospital, Shogun, Critical), Juno, Every Noise, musicmap, Radiooooo, Cosine.club, RYM, Discogs, Mixcloud, Boiler Room, Shazam, and the Spotify / Apple / SoundCloud hubs. The landscape has gaps Fluncle can own: Juno Download has shut down, Every Noise has been frozen since Dec 2023, and the big platforms' genre hubs show nothing without a login.

**Patterns worth stealing** (each needs translating into canon before use):

- **The list is the queue** (Cosine: "NOW PLAYING · 1/100"). Any track list plays straight through; a slim player shows the position.
- **Tap the cover to play, tap the words to open** (Bandcamp, Cosine). Play and navigate are separate targets.
- **Play every clip in a listing** (the late Juno). A "scan this week" gesture over a release list.
- **Track-seeded radio** (SoundCloud stations, Apple). "Keep this going" from any track.
- **Chain hop** (Cosine's chevron, Music-Map). Re-centre the list on a neighbour and leave a trail of covers.
- **Honest similarity** (Cosine: "alike, not good; dig past the top few"). Distance in words, never a percentage.
- **Plain-language feel controls** (Radiooooo's SLOW / FAST / WEIRD). Feel words before genre words.
- **Date-grouped releases with counts** (Beatport, RA). "This week · 23", plus a "since your last visit" divider held in the browser.
- **Small daily picks** (Cosine's Today's gems, RA's Mix of the Day). A finite set beats an endless feed.
- **Index pages with a pulse.** Sort by latest activity, a strip of recent covers, a count of what is new; A–Z as the fallback.
- **Proof from DJs** (Beatport's "Appears on", 1001tracklists play counts). For Fluncle: the mixtapes a finding landed in.

**Anti-patterns:** Beatport's spreadsheet rows and its BPM noise (DnB listed at 87, 104, 119 and 120 BPM); consent or login walls before any sound; hubs that keep showing the same stars; dead-end empty states; endless feeds with no "you're caught up"; a one-record-at-a-time transport as the front door (already rejected by PRODUCT.md).

## 4. What this means for Fluncle

1. **Sound is one tap away, everywhere.** A quarter of listeners decide in five seconds, and today every discovery page takes two taps and a page load to make a sound ([baseline](./baseline.md)).
2. **Feel before genre.** Newcomers can't name subgenres and get gatekept for trying; "more like this one" beats a genre menu for them, and the galaxies are already Fluncle's sonic neighbourhoods.
3. **The human pick is the product.** Fans trust a named curator over an algorithm and increasingly fear AI tracks. Fluncle's note on a finding is exactly the "why it's a banger" line the research asks for; the design should lean on it harder, not bury it.
4. **Finite beats endless.** 106k tracks arrive a day. A small, dated, human set with a "you're caught up" end answers the overload.
5. **Keep and share are the exits.** Most of the funnel dies between loving a track and keeping it (19% go further; 31% ever used "add to music app"). Saving to Spotify and sending it to a mate should sit beside every track.
6. **Mobile, one thumb, first.** The core age band discovers on a phone.
7. **Plain words, international.** The crowd spans 60+ countries; UK slang in the interface is a barrier, while Fluncle's persona voice stays his own.
