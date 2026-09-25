import { Button } from "@fluncle/ui/components/button";
import { Input } from "@fluncle/ui/components/input";

const IDENTITY_FIELD_LABEL =
  "A Spotify or Deezer link, an ISRC, a MusicBrainz recording id, or a Log ID";

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

          defaultValue=""
          id="identity-key"
          name="key"
          spellCheck={false}
          type="text"
        />

        <Button type="submit" variant="outline">
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
