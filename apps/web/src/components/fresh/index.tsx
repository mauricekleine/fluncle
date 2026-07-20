// `/fresh` — the page pieces the route mounts: the marquee treatment (the one `/fresh` ships), the
// shared footer, and the empty state. The design exploration that once lived here (five variants +
// a picker) resolved to the marquee, so the dispatcher and the picker are gone.

import { Link } from "@tanstack/react-router";

export { FreshMarquee } from "./marquee";

export function FreshEmpty({ windowDays }: { windowDays: number }) {
  return (
    <div className="fresh-stage">
      <header className="fresh-masthead">
        <h1 className="fresh-title">Fresh</h1>
      </header>
      <p className="fresh-empty empty-scanlines">No new releases in the last {windowDays} days.</p>
    </div>
  );
}

export function FreshFooter() {
  return (
    <footer className="fresh-footer">
      <Link to="/log">The whole log</Link>
      <Link to="/">Home</Link>
    </footer>
  );
}
