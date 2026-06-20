import { Link, createFileRoute } from "@tanstack/react-router";
import { siteUrl } from "@/lib/fluncle-links";

// The privacy policy: the page the Chrome Web Store points to for Fluncle Lens.
// Register is honest-plain (machine/legal, third person for the entity) with a
// light touch of Fluncle warmth. Everything here MUST stay accurate to what the
// extension and the site actually do — no invented claims, no embellishment.
// The "last updated" date is passed in statically (no new Date() at render).

const title = "Privacy — Fluncle";
const description =
  "How Fluncle Lens and fluncle.com handle your data: pages are scanned locally, only a detected coordinate is sent, and nothing about your browsing is collected.";

// Static so it is identical on the server and the client; bump by hand when the
// policy text below changes.
const lastUpdated = "June 21, 2026";

function privacyHead() {
  const pageUrl = `${siteUrl}/privacy`;

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

export const Route = createFileRoute("/privacy")({
  component: PrivacyPage,
  head: privacyHead,
});

function PrivacyPage() {
  return (
    <main className="log-plate-stage">
      <article className="log-plate log-about">
        <header className="log-masthead">
          <p className="log-nameplate">Fluncle's Findings</p>
          <h1 className="log-coordinate log-index-title">Privacy</h1>
        </header>

        <section aria-label="Overview" className="log-about-story">
          <p>
            This page covers what Fluncle Lens, the browser extension, and fluncle.com, the public
            archive, do with your data. The short of it: Fluncle Lens reads pages locally in your
            browser to find Fluncle coordinates, and the only thing it ever sends out is a
            coordinate it has already detected. Nothing about your browsing leaves the browser.
          </p>
          <p>Last updated {lastUpdated}.</p>
        </section>

        <section aria-label="Fluncle Lens" className="log-about-definitions">
          <h2>Fluncle Lens (the browser extension)</h2>
          <p className="log-privacy-intro">
            Fluncle Lens scans the pages you let it scan for Fluncle coordinates, written
            fluncle://XXX.Y.ZZ, and surfaces the matching finding.
          </p>
          <dl>
            <div className="log-about-definition">
              <dt>What it reads</dt>
              <dd>
                Each page's text, locally in your browser, to spot coordinates. The page content is
                not collected, stored, or sent anywhere.
              </dd>
            </div>
            <div className="log-about-definition">
              <dt>What it sends</dt>
              <dd>
                Only a detected coordinate, which is a public Fluncle finding ID, to fluncle.com, to
                fetch that finding's public details: title, artist, and links. Nothing else about
                the page leaves the browser.
              </dd>
            </div>
            <div className="log-about-definition">
              <dt>What it stores</dt>
              <dd>
                Your settings, and only your settings: the "scan all websites" toggle, the "show
                hover cards" toggle, and the "open findings on" preference. These are saved locally
                through the browser's own storage and are not transmitted.
              </dd>
            </div>
            <div className="log-about-definition">
              <dt>What it does not do</dt>
              <dd>
                It does not track your browsing, run analytics on the pages you visit, collect
                personal information, show ads, or sell or transfer any data.
              </dd>
            </div>
            <div className="log-about-definition">
              <dt>Permissions it uses</dt>
              <dd>
                activeTab, to read the current tab when you act on it; storage, to save your
                settings; and host access to www.fluncle.com, to fetch a coordinate's public
                details. That is the whole list.
              </dd>
            </div>
          </dl>
        </section>

        <section aria-label="The site" className="log-about-definitions">
          <h2>The site (fluncle.com)</h2>
          <dl>
            <div className="log-about-definition">
              <dt>Public data</dt>
              <dd>
                The archive and the API serve public finding data: titles, artists, and links. You
                do not need an account to read it.
              </dd>
            </div>
            <div className="log-about-definition">
              <dt>Logs and analytics</dt>
              <dd>
                The server keeps standard request logs to run and protect the site. Visitor counts
                use Simple Analytics, which is cookieless and collects no personal information.
                There is no advertising or cross-site tracking.
              </dd>
            </div>
          </dl>
        </section>

        <section aria-label="Contact" className="log-about-story">
          <h2 className="log-privacy-heading">Contact</h2>
          <p>
            Questions about any of this, or a request about your data, reach Fluncle at{" "}
            <a href="mailto:hey@fluncle.com">hey@fluncle.com</a>. If the policy changes, the date at
            the top changes with it.
          </p>
        </section>

        <footer className="log-plate-footer">
          <Link to="/">Back to the archive</Link>
          <Link to="/about">About Fluncle</Link>
        </footer>
      </article>
    </main>
  );
}
