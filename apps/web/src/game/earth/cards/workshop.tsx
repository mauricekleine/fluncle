import { spotifyPlaylistUrl } from "@/lib/fluncle-links";
import { CardShell, CommandBody, LinkBody, TerminalBody } from "./_chrome";
import { type CardEntry } from "./_types";

// The Workshop's custom cards — the surfaces @fluncle/registry doesn't carry
// (the recovered terminal, the Spotify channel, the CLI). The mixtapes + radio
// doors read the registry directly via SurfaceCard, so they need no card here.

// The rave terminal is advertised at this public host (also on /status).
const SSH_HOST = "rave.fluncle.com";

function TerminalCard() {
  return <TerminalBody host={SSH_HOST} />;
}

function SpotifyCard() {
  return (
    <CardShell label="Fluncle's Findings on Spotify">
      <LinkBody
        blurb="every banger I've logged, gathered into one playlist."
        cta={{ href: spotifyPlaylistUrl, label: "open on Spotify" }}
        title="Fluncle's Findings"
      />
    </CardShell>
  );
}

function CliCard() {
  return (
    <CardShell label="the fluncle CLI">
      <CommandBody
        blurb="the archive from your own terminal: read the latest, submit a track, subscribe."
        commands={["brew install fluncle", "fluncle recent"]}
        title="The fluncle CLI"
      />
    </CardShell>
  );
}

export const cards: CardEntry[] = [
  { Card: TerminalCard, id: "terminal" },
  { Card: SpotifyCard, id: "spotify" },
  { Card: CliCard, id: "cli" },
];
