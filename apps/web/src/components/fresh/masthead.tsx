// `/fresh` — the shared masthead. The nameplate and the intro are canon-approved strings (the copy
// is careful never to claim Fluncle FOUND these — they're RELEASE dates; VOICE.md's Found Rule). The
// newest-first ordering is SHOWN by the page (the date spine / big date stamps), never stated.

export function FreshMasthead() {
  return (
    <header className="fresh-masthead">
      <h1 className="fresh-title">Fresh</h1>
      <p className="fresh-intro">
        The freshest bangers in the sector, hot off the press. I'm still spinning my way through
        everything that's landed this past month.
      </p>
    </header>
  );
}
