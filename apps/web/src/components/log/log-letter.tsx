import { Link } from "@tanstack/react-router";
import { SubscribeDialog } from "@/components/subscribe-dialog";
import { type EditionDTO, editionFindingCount, orderedGalaxies } from "@/lib/editions";
import { formatDateLong } from "@/lib/format";
import { splitLogId } from "@/lib/log-prose";

// The letter's plate — one sent newsletter edition at its coordinate, `/log/023.L.1A`.
//
// A finding is a marker Fluncle left at a place; a mixtape is him dreaming. A letter is
// the one thing he ADDRESSES: he writes down what the week held and posts it back down
// the trail (LORE.md). So the plate renders the letter as it went out — the salutation,
// his opening, the finds he wanted the crew to have, and the sign-off — not a summary
// OF an email. The persisted `content` payload is the source (the same one the email
// HTML renders from; one source, two renders).
//
// Every finding it names links to its own `/log` page: the letter is the breadcrumb
// trail back into the archive, exactly as a mixtape's tracklist is.
export function LogLetter({
  edition,
  galaxyNames,
  labels,
}: {
  edition: EditionDTO;
  /** The live sonic-galaxy names, in public order — the block sort ranks against them. */
  galaxyNames: string[];
  /** `logId` → `Artist — Title`, hydrated server-side so the letter never goes stale. */
  labels: Record<string, string>;
}) {
  const logId = edition.logId ?? "";
  const { sector } = splitLogId(logId);
  const mark = logId.split(".")[2] ?? "";
  const { content } = edition;
  const galaxies = orderedGalaxies(content, galaxyNames);
  const findingCount = editionFindingCount(content);

  return (
    <main className="log-plate-stage">
      <article className="log-plate">
        <header className="log-masthead">
          <p className="log-nameplate">Letter No. {edition.number}</p>
          <h1 className="log-coordinate">{logId}</h1>
          <p className="log-coordinate-uri">fluncle://{logId}</p>
        </header>

        <section aria-label="The letter" className="log-definition">
          <h2 className="log-track-title">{edition.subject ?? `Letter No. ${edition.number}`}</h2>
          <p className="log-track-artist">Fluncle</p>
          <p className="log-letter-salutation">Ahoy cosmonauts,</p>
          {content.intro?.trim() ? (
            <p className="log-newsletter-intro">{content.intro.trim()}</p>
          ) : undefined}
        </section>

        <dl className="log-fields">
          {edition.sentAt ? (
            <div className="log-field">
              <dt>Sent</dt>
              <dd>
                <time dateTime={edition.sentAt}>{formatDateLong(edition.sentAt)}</time>
              </dd>
            </div>
          ) : undefined}
          <div className="log-field">
            <dt>Bangers</dt>
            <dd>{findingCount}</dd>
          </div>
        </dl>

        {/*
          The finds. The letter's payload usually carries ONE flat block with an empty
          label (the letter copy stopped grouping by galaxy), so the heading renders
          only when the agent actually named a galaxy — an empty <h2> would be a heading
          with nothing to say.
        */}
        {galaxies.map((block, index) => {
          const galaxy = block.galaxy.trim();

          return (
            <section
              aria-label={galaxy ? `Findings in ${galaxy}` : "The findings"}
              className="log-related"
              key={galaxy || `block-${index}`}
            >
              {galaxy ? <h2>{galaxy}</h2> : undefined}
              <ul className="log-related-list log-newsletter-finds">
                {block.findings.map((finding) => (
                  <li key={finding.logId}>
                    <Link params={{ logId: finding.logId }} to="/log/$logId">
                      <span className="log-related-coordinate">
                        {labels[finding.logId] ?? finding.logId}
                      </span>
                      {finding.why?.trim() ? (
                        <span className="log-newsletter-why">{finding.why}</span>
                      ) : undefined}
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}

        {content.mixtapeRef?.trim() ? (
          <section aria-label="The mixtape" className="log-related">
            <h2>And a new mixtape</h2>
            <ul className="log-related-list">
              <li>
                <Link params={{ logId: content.mixtapeRef.trim() }} to="/log/$logId">
                  <span className="log-related-coordinate">{content.mixtapeRef.trim()}</span>
                  <span className="log-related-line">
                    One long dream I mixed from the week's finds.
                  </span>
                </Link>
              </li>
            </ul>
          </section>
        ) : undefined}

        {content.tidbits?.length ? (
          <section aria-label="From the wider cosmos" className="log-related">
            <h2>From the wider cosmos</h2>
            <ul className="log-newsletter-tidbits">
              {content.tidbits.map((tidbit, index) => (
                <li key={`${index}-${tidbit.text.slice(0, 24)}`}>
                  {tidbit.text}
                  {tidbit.source?.trim() ? (
                    <>
                      {" "}
                      <a href={tidbit.source} rel="noreferrer" target="_blank">
                        (source)
                      </a>
                    </>
                  ) : undefined}
                </li>
              ))}
            </ul>
          </section>
        ) : undefined}

        <p className="log-letter-signoff">
          Happy raving,
          <br />
          Fluncle
        </p>

        {/* The one thing to do at the bottom of a letter you liked: get the next one. */}
        <div className="log-actions">
          <SubscribeDialog label="Get the next one" />
        </div>

        <section aria-label="How to read a Log ID" className="log-decode">
          <h2>How to read the coordinate</h2>
          <p>
            <span className="log-decode-part">{sector}</span> is the sector: the days between the
            epoch, 2026-05-30, and the day I sent this one home.{" "}
            <span className="log-decode-part">L</span> marks a letter.{" "}
            <span className="log-decode-part">{mark}</span> is its number, minted once and never
            changed. <Link to="/about">More on Log IDs and the Galaxy</Link>.
          </p>
        </section>

        <footer className="log-plate-footer">
          <Link to="/newsletter">All back issues</Link>
          <Link to="/">Back to the archive</Link>
        </footer>
      </article>
    </main>
  );
}
