import { Link, createFileRoute } from "@tanstack/react-router";
import { siteUrl } from "@/lib/fluncle-links";

// The terms of use: the public site's rules page, pointed at by TikTok's developer-app
// review and overdue for the site generally. Same register as the privacy page — an
// ARRIVAL surface read by strangers and reviewers, so honest-plain (third person for the
// entity, plain-legal-lite) with a light touch of Fluncle warmth and zero cosmos
// vocabulary in the substance. Everything here MUST stay accurate to what Fluncle
// actually is and does. The "last updated" date is static (no new Date() at render);
// bump it by hand whenever the text below changes.

const title = "Terms · Fluncle";
const description =
  "The plain terms for fluncle.com: a personal, non-commercial drum & bass archive. What you can do here, who owns the music and the writing, and what to expect.";

// Static so it is identical on the server and the client; bump by hand when the terms
// text below changes.
const lastUpdated = "July 20, 2026";

function termsHead() {
  const pageUrl = `${siteUrl}/terms`;

  return {
    links: [{ href: pageUrl, rel: "canonical" }],
    meta: [
      { title },
      { content: description, name: "description" },
      { content: title, property: "og:title" },
      { content: description, property: "og:description" },
      { content: `${siteUrl}/fluncle-cover.png`, property: "og:image" },
      { content: pageUrl, property: "og:url" },
    ],
  };
}

export const Route = createFileRoute("/terms")({
  component: TermsPage,
  head: termsHead,
});

function TermsPage() {
  return (
    <main className="log-plate-stage">
      <article className="log-plate log-about">
        <header className="log-masthead">
          <h1 className="log-coordinate log-index-title">Terms</h1>
        </header>

        <section aria-label="Overview" className="log-about-story">
          <p>
            Fluncle is a personal, non-commercial archive of drum & bass that one person finds,
            certifies, and writes up. These are the plain terms for using it. By reading the
            archive, making an account, or submitting a track, you agree to what is set out below.
          </p>
          <p>Last updated: {lastUpdated}.</p>
        </section>

        <section aria-label="Using the site" className="log-about-definitions">
          <h2>Using the site</h2>
          <dl>
            <div className="log-about-definition">
              <dt>It is free and for people</dt>
              <dd>
                You can read the archive, listen to the previews, follow the links, share what you
                find, and make an account, all for your own personal, non-commercial use.
              </dd>
            </div>
            <div className="log-about-definition">
              <dt>Play fair with it</dt>
              <dd>
                Do not use the site to break the law, to harm or harass anyone, or to attack,
                overload, or scrape it in ways that degrade it for everyone else. The API and feeds
                are there for reasonable use.
              </dd>
            </div>
            <div className="log-about-definition">
              <dt>Your account</dt>
              <dd>
                Keep your login yours and your details accurate. Fluncle can suspend or remove an
                account that breaks these terms.
              </dd>
            </div>
          </dl>
        </section>

        <section aria-label="The music" className="log-about-definitions">
          <h2>The music and the artwork</h2>
          <p className="log-privacy-intro">
            Fluncle is an archive that points at music, not a music service.
          </p>
          <dl>
            <div className="log-about-definition">
              <dt>It belongs to the rights holders</dt>
              <dd>
                Every track, every piece of cover art, and every name belongs to the artists,
                labels, and other rights holders behind it. Fluncle does not own or sell the music.
              </dd>
            </div>
            <div className="log-about-definition">
              <dt>How it plays here</dt>
              <dd>
                The archive plays only short preview clips from official sources and links out to
                those sources, like Spotify, for the full track. It does not host the full
                recordings for playback.
              </dd>
            </div>
            <div className="log-about-definition">
              <dt>If it is yours and you want it changed</dt>
              <dd>
                If you are a rights holder and want a track or its details corrected or removed,
                email <a href="mailto:hey@fluncle.com">hey@fluncle.com</a> and Fluncle will sort it
                out.
              </dd>
            </div>
          </dl>
        </section>

        <section aria-label="Fluncle's own work" className="log-about-definitions">
          <h2>Fluncle's own work</h2>
          <dl>
            <div className="log-about-definition">
              <dt>The writing and the videos</dt>
              <dd>
                The findings, notes, logs, videos, artwork, and copy that Fluncle makes are
                Fluncle's own. Link to them and share them freely; do not republish them wholesale
                or pass them off as your own.
              </dd>
            </div>
            <div className="log-about-definition">
              <dt>The code</dt>
              <dd>
                The site's source code is open source on GitHub and is covered by the license in
                that repository.
              </dd>
            </div>
          </dl>
        </section>

        <section aria-label="Submissions" className="log-about-definitions">
          <h2>Submitting a track</h2>
          <dl>
            <div className="log-about-definition">
              <dt>What sending one means</dt>
              <dd>
                When you submit a track, you are giving Fluncle the go-ahead to listen to it,
                consider it, and, if it makes the cut, log it and write about it across Fluncle's
                surfaces. Only submit music it is fair for you to share.
              </dd>
            </div>
            <div className="log-about-definition">
              <dt>No promises</dt>
              <dd>
                A submission is not a guarantee it gets logged, and there is no payment either way.
                Fluncle listens to what comes in and certifies by ear.
              </dd>
            </div>
          </dl>
        </section>

        <section aria-label="No warranty and changes" className="log-about-definitions">
          <h2>No warranty, and changes</h2>
          <dl>
            <div className="log-about-definition">
              <dt>As is</dt>
              <dd>
                The archive is provided as is, with no warranty. Things can break, links can rot,
                and the site can go down. Fluncle is not liable for any loss that comes from using
                it.
              </dd>
            </div>
            <div className="log-about-definition">
              <dt>It can change</dt>
              <dd>
                Fluncle may change, pause, or discontinue any part of the site, and may update these
                terms. When the terms change, the date at the top changes with them.
              </dd>
            </div>
          </dl>
        </section>

        <section aria-label="Contact" className="log-about-story">
          <h2 className="log-privacy-heading">Contact</h2>
          <p>
            Questions about any of this reach Fluncle at{" "}
            <a href="mailto:hey@fluncle.com">hey@fluncle.com</a>.
          </p>
        </section>

        <footer className="log-plate-footer">
          <Link to="/">Back to the archive</Link>
          <Link to="/privacy">Privacy</Link>
          <Link to="/about">About Fluncle</Link>
        </footer>
      </article>
    </main>
  );
}
