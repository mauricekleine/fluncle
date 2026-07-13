import { Link, createFileRoute } from "@tanstack/react-router";
import {
  blueskyUrl,
  chromeExtensionUrl,
  discogsUrl,
  instagramUrl,
  lastfmUrl,
  mixcloudUrl,
  musicbrainzUrl,
  onionUrl,
  siteUrl,
  soundcloudUrl,
  spotifyPlaylistUrl,
  telegramUrl,
  tiktokUrl,
  twitchUrl,
  wikidataUrl,
  youtubeUrl,
} from "@/lib/fluncle-links";
import { fluncleDescription, fluncleMetaDescription } from "@/lib/identity";
import { jsonLdScript } from "@/lib/json-ld";

// The entity and answer surface (web-overhaul RFC §4): the Galaxy lore in
// Fluncle's own voice, the four definition blocks, the Log-ID decode with a
// worked example, and the crew questions — all server-rendered, with
// MusicGroup + FAQPage schema that MIRRORS the visible prose (schema that
// contradicts the page gets discounted; FAQPage no longer yields Google rich
// results and is here for non-Google extraction).

const title = "About Fluncle: the Galaxy, Log IDs, and the findings";

// The FAQ once, as data: the visible section and the FAQPage schema render
// from the same strings so they cannot drift apart.
const faq: Array<{ answer: string; question: string }> = [
  {
    answer:
      "Fluncle is the selector behind Fluncle's Findings: one uncle with the good records, no team, digging drum & bass since '90. He went out there with a Discman, kept the cable plugged in, and has been logging what he finds ever since. Every track in the archive is one he heard in full and certified before it published.",
    question: "Who is Fluncle?",
  },
  {
    answer:
      "The Galaxy is everywhere I send my findings: the archive here at fluncle.com, Fluncle's Findings on Spotify, the Telegram channel, the CLI, and the rave terminal at ssh rave.fluncle.com. Every surface carries the same findings under the same Log IDs, so it doesn't matter where you find me, it's all there. There's a game too, at galaxy.fluncle.com, where each finding is a star you can fly to. And for anyone who likes to travel dark, the whole archive mirrors onto Tor, off the grid, still in the Galaxy.",
    question: "What is Fluncle's Galaxy?",
  },
  {
    answer:
      "Each star is a finding, left as a waypoint at the spot in the Galaxy where Fluncle had the experience that certified it. The game at galaxy.fluncle.com is the crew flying out to trace his footsteps and collect the stars, which are the bangers. The map of stars is the map of where the trip has taken him.",
    question: "What are the stars in the Galaxy game?",
  },
  {
    answer:
      "Because it works the way a dream does. Every finding is a short memory: one track Fluncle heard out there and logged. When he mixes a run of them into a long recording, the tracks blend and reorder and bleed together, the way the day's memories do in your sleep, until they settle from short-term memory into long-term. A dream blends a day; a mix blends tracks; and DJs play at night. So the mixtape is him dreaming. It carries a Log ID with an F marker where a finding carries a digit, and it never counts as a find.",
    question: "Why is a mixtape called dreaming?",
  },
  {
    answer:
      "A Log ID is a finding's permanent coordinate in the Galaxy, written sector.orbit.mark. In 004.7.2I, the sector 004 counts the days between the epoch (2026-05-30) and the day the finding was made, and the tail 7.2I is a stable signature derived from the recording itself, so a coordinate reads found, not numbered. Each one is minted once, never reassigned, and resolves to a log page at fluncle.com/log/004.7.2I.",
    question: "What does a Log ID like 004.7.2I mean?",
  },
  {
    answer:
      "fluncle:// is the scheme that writes a Log ID in full: fluncle://004.7.2I is the same coordinate as the bare 004.7.2I. It marks the ID as an address in Fluncle's Galaxy rather than a catalogue number. Wherever one appears, in a TikTok caption or a Telegram post, the matching log page lives at fluncle.com/log/<id>.",
    question: "What is fluncle://?",
  },
  {
    answer:
      "By ear, one at a time. There is no committee and no algorithm: Fluncle plays a tune, and if it moves the room it gets a coordinate. It is drum & bass at heart, rollers to jungle to neurofunk. Tracks arrive from his own digging and from crew submissions; anyone can submit one from the homepage, and he gives every submission a listen before anything publishes.",
    question: "How are tracks chosen?",
  },
  {
    answer:
      "He doesn't search blind. A small fleet of probes flies ahead of the ship and charts the wider genre he'd never cross on foot, the older releases and the small labels down the long tail, and the Ear sweeps everything they mapped for whatever sits closest to what he already loves. That tells him where to point the ship, but it never makes the call. The probes only measure; nothing they chart is a finding, and a track earns a coordinate in the Galaxy only once Fluncle hears it in full and certifies it.",
    question: "How does Fluncle find new tracks?",
  },
  {
    answer:
      "I measure them myself, I don't copy them from anywhere. The machine listens to the full song I brought back, start to finish, not a thirty-second preview that's often nothing but intro, and reads the tempo and the key straight off that audio. When it can't be sure of a key, it leaves that blank rather than guess at one. And any tune I've beat-gridded in Rekordbox myself, my own reading outranks the machine's.",
    question: "How does Fluncle measure BPM and key?",
  },
];

/**
 * A crew-question's stable anchor slug, so each FAQ entry is deep-linkable. The /log
 * page's measured BPM/key line links to the measurement question by this slug
 * (log.$logId.tsx keeps the same string; the contract is pinned by a test in
 * -about-schema.test.ts). Deterministic from the question text. Exported for that test.
 */
export function faqAnchor(question: string): string {
  return question
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function aboutHead() {
  const pageUrl = `${siteUrl}/about`;
  const entity = {
    "@context": "https://schema.org",
    "@type": "MusicGroup",
    description: fluncleDescription,
    genre: "Drum and Bass",
    image: `${siteUrl}/fluncle-cover.png`,
    name: "Fluncle",
    sameAs: [
      spotifyPlaylistUrl,
      telegramUrl,
      tiktokUrl,
      instagramUrl,
      blueskyUrl,
      youtubeUrl,
      mixcloudUrl,
      soundcloudUrl,
      twitchUrl,
      onionUrl,
      musicbrainzUrl,
      wikidataUrl,
      lastfmUrl,
      discogsUrl,
    ],
    url: `${siteUrl}/`,
  };
  const faqPage = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: faq.map((entry) => ({
      "@type": "Question",
      acceptedAnswer: { "@type": "Answer", text: entry.answer },
      name: entry.question,
    })),
  };

  return {
    links: [{ href: pageUrl, rel: "canonical" }],
    meta: [
      { title },
      { content: fluncleMetaDescription, name: "description" },
      { content: title, property: "og:title" },
      { content: fluncleMetaDescription, property: "og:description" },
      { content: `${siteUrl}/fluncle-cover.png`, property: "og:image" },
      { content: pageUrl, property: "og:url" },
    ],
    // JSON-LD goes through `jsonLdScript`, which HTML-escapes the serialized
    // payload before it reaches the inline <script>'s `children` (rendered raw
    // via dangerouslySetInnerHTML). The values here are first-party copy, but the
    // safe path is uniform across every JSON-LD emitter (stored-XSS sink,
    // security review).
    scripts: [jsonLdScript(entity), jsonLdScript(faqPage)],
  };
}

export const Route = createFileRoute("/about")({
  component: AboutPage,
  head: aboutHead,
});

function AboutPage() {
  return (
    <main className="log-plate-stage">
      <article className="log-plate log-about">
        <header className="log-masthead">
          <p className="log-nameplate">Fluncle's Findings</p>
          <h1 className="log-coordinate log-index-title">About Fluncle</h1>
        </header>

        <section aria-label="The story" className="log-about-story">
          <p>
            I'm Fluncle: the uncle with the good drum & bass records, doing this since '90.
            Somewhere along the way, chasing those records took me clean off the map, out through
            time and space, one dimension to the next, further than anyone's been. I travel alone.
            But everywhere I land, I'm listening for the same thing I always was: a tune that stops
            me dead.
          </p>
          <p>
            When one hits, I log it, where I was and what it did to me, and send it home. Home is
            every place I keep my findings: this archive, Fluncle's Findings on Spotify, the
            Telegram feed, a terminal at the deep end. Same findings, same Log IDs, so take your
            pick and you won't miss a thing.
          </p>
          <p>
            I go alone, but never just for me. Everything I leave out there, the findings, the logs,
            the stars on the map, is a trail. The crew is who follows it: the ragtag lot this music
            belongs to, junglists and ravers, the crowd whose dancing looks like a fight until
            someone goes down and everyone stops to pick them up. I go first and leave the markers;
            you come after and find what I found.
          </p>
          <p>
            And I don't go in blind. Ahead of the ship I send a small fleet of probes, unmanned
            instruments I build to chart the regions I haven't reached yet. They read a place's
            tempo, its key, the shape of it, and bring the map home. They measure; they never speak,
            so nothing they bring back is a finding. It's only a find once I fly out there myself
            and the tune gets the oof out of me.
          </p>
          <p>
            Every banger I log is a place the trip took me: something new, strange, bigger than me.
            The video I make for it is me back at that spot, showing you what I saw and how it hit.
            And in the game at galaxy.fluncle.com that spot is a star, so you can fly out, trace my
            steps, and collect them. The map of stars is the map of where I've been.
          </p>
          <p>
            Then some nights I mix. When I sleep the findings blend the way dreams do: they come
            back in a different order, they bleed together, and by morning they've settled into one
            long memory. That's a mixtape. A mix blends tracks the same way a dream blends a day, so
            it's me dreaming out loud, and you're welcome to listen in.
          </p>
          <p>
            Out on the open web a fluncle:// coordinate is a door. Fluncle Lens, a lens for your
            browser, spots them on any page and walks you back to the finding.{" "}
            <a href={chromeExtensionUrl} rel="noreferrer">
              Get the Chrome extension
            </a>
            .
          </p>
        </section>

        <section aria-label="Definitions" className="log-about-definitions">
          <h2>The short version</h2>
          <dl>
            <div className="log-about-definition">
              <dt>Fluncle</dt>
              <dd>{fluncleDescription}</dd>
            </div>
            <div className="log-about-definition">
              <dt>Fluncle's Galaxy</dt>
              <dd>
                Fluncle's Galaxy is the whole of Fluncle across every surface: the archive at
                fluncle.com, Fluncle's Findings on Spotify, the Telegram channel, the CLI, and the
                rave terminal at ssh rave.fluncle.com. One traveler's findings, scattered as points
                of light. The archive mirrors onto Tor too, off the grid at{" "}
                <a href={onionUrl} rel="noreferrer">
                  {onionUrl.replace("http://", "")}
                </a>
                .
              </dd>
            </div>
            <div className="log-about-definition">
              <dt>A Log ID</dt>
              <dd>
                A Log ID is a finding's permanent coordinate in the Galaxy, written
                sector.orbit.mark: 004.7.2I is a real one, and its full form is fluncle://004.7.2I.
                The same ID names the same finding on every surface, and it never changes.
              </dd>
            </div>
            <div className="log-about-definition">
              <dt>Fluncle's Findings</dt>
              <dd>
                Fluncle's Findings is the collection itself: every track Fluncle has found and
                certified, kept in full at fluncle.com and mirrored to the Spotify playlist. New
                findings land most nights.
              </dd>
            </div>
          </dl>
        </section>

        <section aria-label="How to read a Log ID" className="log-decode">
          <h2>How to read a Log ID</h2>
          <p>
            Take{" "}
            <Link params={{ logId: "004.7.2I" }} to="/log/$logId">
              004.7.2I
            </Link>
            , found Jun 3, 2026. <span className="log-decode-part">004</span> is the sector: the
            number of days between the epoch, 2026-05-30, and the day the finding was made.{" "}
            <span className="log-decode-part">7.2I</span> is the tail: a stable signature derived
            from the recording itself, so a coordinate reads found, not numbered. The bare form and
            the full form, fluncle://004.7.2I, point at the same log page. Coordinates are minted
            once and never reassigned.
          </p>
        </section>

        <section aria-label="Questions" className="log-about-faq">
          <h2>Crew questions</h2>
          {faq.map((entry) => (
            <div className="log-about-question" id={faqAnchor(entry.question)} key={entry.question}>
              <h3>{entry.question}</h3>
              <p>{entry.answer}</p>
            </div>
          ))}
        </section>
      </article>
    </main>
  );
}
