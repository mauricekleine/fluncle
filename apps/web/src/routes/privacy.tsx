import { Link, createFileRoute } from "@tanstack/react-router";
import { siteUrl } from "@/lib/fluncle-links";

// The privacy policy: the public site's data page, and the page the Chrome Web Store
// points to for Fluncle Lens. TikTok's developer-app review also points here.
// Register is honest-plain (machine/legal, third person for the entity) with a light
// touch of Fluncle warmth — an ARRIVAL surface read by strangers and reviewers, so
// zero cosmos vocabulary in the substance. Everything here MUST stay accurate to what
// the site, the account system, and the extension actually do — no invented claims,
// no embellishment. The "last updated" date is passed in statically (no new Date() at
// render); bump it by hand whenever the text below changes.

const title = "Privacy · Fluncle";
const description =
  "How fluncle.com and Fluncle Lens handle your data: privacy-friendly analytics with no tracking cookies, no ads, no data sold, and clear ways to export or delete your account.";

// Static so it is identical on the server and the client; bump by hand when the
// policy text below changes.
const lastUpdated = "July 20, 2026";

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
          <h1 className="log-coordinate log-index-title">Privacy</h1>
        </header>

        <section aria-label="Overview" className="log-about-story">
          <p>
            Fluncle is a one-person drum & bass archive, and this page is the plain version of how
            it treats your data. The short of it: you can read the whole archive without an account,
            nothing tracks you across the web, there are no ads, and no data is ever sold. When you
            do sign in or sign up for the newsletter, only what is described below is kept, and you
            can export or delete it whenever you want.
          </p>
          <p>Last updated: {lastUpdated}.</p>
        </section>

        <section aria-label="Accounts" className="log-about-definitions">
          <h2>Accounts</h2>
          <p className="log-privacy-intro">
            You never need an account to browse fluncle.com. An account only exists to save your own
            things and carry them between devices.
          </p>
          <dl>
            <div className="log-about-definition">
              <dt>How you sign in</dt>
              <dd>
                With Google, or with an email address and a password. Passwords are stored hashed,
                never in plain text. If you use email, Fluncle sends a verification link to confirm
                the address; if you sign in with Google, Fluncle receives your email address and
                name from Google to set the account up.
              </dd>
            </div>
            <div className="log-about-definition">
              <dt>What the account holds</dt>
              <dd>
                Your email address, a display name and username you choose, and an optional profile
                picture. Sign-in sessions record the browser and IP address they were created from,
                so a session can be kept active and revoked if needed.
              </dd>
            </div>
            <div className="log-about-definition">
              <dt>What you save</dt>
              <dd>
                The tracks you save, the sets you build, the artists and labels you watch, your
                settings, your progress in the Galaxy game, and any tracks you submit while signed
                in. This is yours; it is used to show you your own things, not to profile you.
              </dd>
            </div>
            <div className="log-about-definition">
              <dt>The Frontier playlist</dt>
              <dd>
                Fluncle can build you a weekly Frontier playlist of recommendations. It lives on
                Fluncle's own Spotify account, not yours, so signing in never gives Fluncle access
                to your Spotify library, and nothing is written to your Spotify account.
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
                The archive and the API serve public track data: titles, artists, notes, and links.
                You do not need an account to read it.
              </dd>
            </div>
            <div className="log-about-definition">
              <dt>Analytics</dt>
              <dd>
                Visitor counts use Simple Analytics, which is cookieless and collects no personal
                information. The server also keeps standard request logs to run and protect the
                site. There is no advertising and no cross-site tracking.
              </dd>
            </div>
            <div className="log-about-definition">
              <dt>Cookies</dt>
              <dd>
                Only functional ones: a cookie that keeps you signed in and a token that protects
                forms from cross-site abuse. No advertising or tracking cookies are set.
              </dd>
            </div>
          </dl>
        </section>

        <section aria-label="Newsletter" className="log-about-definitions">
          <h2>The newsletter</h2>
          <dl>
            <div className="log-about-definition">
              <dt>What is stored</dt>
              <dd>
                If you sign up, your email address is stored with Resend, the service that sends the
                weekly newsletter. It is used to send that newsletter and nothing else.
              </dd>
            </div>
            <div className="log-about-definition">
              <dt>Leaving</dt>
              <dd>
                Every newsletter has a one-click unsubscribe link, and unsubscribing removes you
                from the list. You do not need an account to sign up or to leave.
              </dd>
            </div>
          </dl>
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

        <section aria-label="Push notifications" className="log-about-definitions">
          <h2>Push notifications (the app)</h2>
          <dl>
            <div className="log-about-definition">
              <dt>What is stored</dt>
              <dd>
                If you turn on notifications in the Fluncle app, your device's push token is stored
                so the app can tell you when a new finding or mixtape lands. It is a device
                identifier used only to deliver those notifications, never sold or used to track
                you. Turn notifications off in the app to remove it; tokens that go quiet are pruned
                on their own.
              </dd>
            </div>
          </dl>
        </section>

        <section aria-label="Who handles your data" className="log-about-definitions">
          <h2>Who helps run all this</h2>
          <p className="log-privacy-intro">
            A handful of services do specific jobs. None of them are given your data to advertise to
            you or to sell.
          </p>
          <dl>
            <div className="log-about-definition">
              <dt>Cloudflare and Turso</dt>
              <dd>
                Cloudflare hosts and serves the site; Turso is the database that stores it. These
                providers operate internationally, so your data may be processed outside your own
                country.
              </dd>
            </div>
            <div className="log-about-definition">
              <dt>Resend, Google, and Spotify</dt>
              <dd>
                Resend sends account and newsletter emails; Google handles "Continue with Google"
                sign-in; Spotify hosts the playlists and the previews the archive links to. Each one
                only sees what it needs for its job.
              </dd>
            </div>
          </dl>
        </section>

        <section aria-label="Your choices" className="log-about-definitions">
          <h2>Your data, your call</h2>
          <dl>
            <div className="log-about-definition">
              <dt>Export it</dt>
              <dd>
                From your account you can download a copy of everything tied to it: your profile,
                saved tracks and sets, watched artists and labels, settings, Galaxy progress, and
                your submissions.
              </dd>
            </div>
            <div className="log-about-definition">
              <dt>Delete it</dt>
              <dd>
                You can delete your account from your settings. That removes your saved tracks,
                sets, watches, settings, and game progress, ends your sessions, and anonymizes any
                tracks you submitted so they stay useful as review history without your name on
                them. Email and chat providers may keep their own copies for their own retention
                windows.
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
          <Link to="/terms">Terms</Link>
          <Link to="/about">About Fluncle</Link>
        </footer>
      </article>
    </main>
  );
}
