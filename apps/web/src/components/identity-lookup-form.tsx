// The identity lookup field — one text box and one button, shared by the door (`/identity`) and the
// answer page (`/identity/<key>`), so looking up a second recording is the same control in the same
// words wherever you are (VOICE.md's Chrome Rule: one action, one label).
//
// A PLAIN GET FORM, deliberately. It submits to `/identity?key=…` and that route redirects onto the
// `/identity/<key>` path, which means the whole surface works with JavaScript switched off and a
// crawler can see a real `<form>` rather than a click handler. The redirect is also what puts every
// arrival on the canonical, normalized URL: `gb-abc-12-34567` and `GBABC1234567` are the same
// recording, and only one of them is a page.
//
// Reference-register chrome on a catalogue page: quiet, bordered, no gold but the focus ring
// (DESIGN.md's One Sun Rule).

import { Button } from "@fluncle/ui/components/button";
import { Input } from "@fluncle/ui/components/input";

/** The field's accessible name — literal, and the one string that names what a caller may type. */
export const IDENTITY_FIELD_LABEL = "An ISRC, a MusicBrainz recording id, or a Log ID";

export function IdentityLookupForm({ submitLabel = "Look up" }: { submitLabel?: string }) {
  return (
    <form action="/identity" className="identity-lookup" method="get">
      <label className="identity-lookup-label" htmlFor="identity-key">
        {IDENTITY_FIELD_LABEL}
      </label>
      <div className="identity-lookup-row">
        <Input
          autoComplete="off"
          className="identity-lookup-input"
          // An explicit empty default: left undefined, the underlying field treats the input as
          // uninitialized and paints a client-only `caret-color: transparent` the server never
          // rendered, which React reports as a hydration mismatch. Stating the empty value makes
          // the two passes agree, and changes nothing about the JS-off form.
          defaultValue=""
          id="identity-key"
          name="key"
          spellCheck={false}
          type="text"
        />
        {/* `outline`, not the gold `default`: the plate is a quiet reference surface and the page
            already sits under the header's one gold CTA (DESIGN.md's One Sun Rule). The border
            matches the field's, so the pair reads as one control. */}
        <Button type="submit" variant="outline">
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
