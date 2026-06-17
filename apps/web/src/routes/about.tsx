import { Link, createFileRoute } from "@tanstack/react-router";
import {
  instagramUrl,
  mixcloudUrl,
  musicbrainzUrl,
  siteUrl,
  spotifyPlaylistUrl,
  telegramUrl,
  tiktokUrl,
  wikidataUrl,
  youtubeUrl,
} from "@/lib/fluncle-links";
import { fluncleDescription, fluncleMetaDescription } from "@/lib/identity";

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
      "The Galaxy is everything Fluncle, taken together: the archive at fluncle.com, Fluncle's Findings on Spotify, the Telegram channel, the CLI, and the rave terminal at ssh rave.fluncle.com. Each surface shows the same findings under the same Log IDs, so following any one of them is following the same journey. There is also a small game at galaxy.fluncle.com where every finding is a star you can fly to.",
    question: "What is Fluncle's Galaxy?",
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
];

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
      youtubeUrl,
      mixcloudUrl,
      musicbrainzUrl,
      wikidataUrl,
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
    scripts: [
      { children: JSON.stringify(entity), type: "application/ld+json" },
      { children: JSON.stringify(faqPage), type: "application/ld+json" },
    ],
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
            Somewhere along the way the record bag became a ship's hold. I travel, I listen, and
            when a tune stops me mid-sector I log it and send it back. That's the whole machine.
          </p>
          <p>
            I don't travel alone. The crew is the ragtag lot this music belongs to: junglists,
            ravers, the crowd whose dancing looks like a fight until someone goes down and everyone
            stops to pick them up. Everything here is addressed to them, which means it's addressed
            to you.
          </p>
          <p>
            Everything I send back lands somewhere in the Galaxy: the archive you came from, the
            playlist, the Telegram feed, a terminal at the deep end. Different rooms, one journey.
            The findings hold it together.
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
                of light.
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
            <div className="log-about-question" key={entry.question}>
              <h3>{entry.question}</h3>
              <p>{entry.answer}</p>
            </div>
          ))}
        </section>

        <footer className="log-plate-footer">
          <Link to="/">Back to the archive</Link>
          <Link to="/log">The full log</Link>
        </footer>
      </article>
    </main>
  );
}
