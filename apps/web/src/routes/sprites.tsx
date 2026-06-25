import { createFileRoute } from "@tanstack/react-router";
import { SURFACES } from "@fluncle/registry";

// The Sprite System — a plain, internal inventory of EVERY pixel sprite across the
// Galaxy in one place, so we can inspect them side by side and judge consistency. It
// holds three collections: the registry surfaces (each with its assigned sprite, or an
// empty placeholder where one is still missing), the Galaxy game sprites, and the Earth
// overworld props. This is step one toward a real, consistent sprite system — a shared
// set of guidelines (and, later, a generation pipeline) so new sprites never drift.
//
// noindex: an internal design/tooling surface, deliberately NOT in the registry, the
// sitemap, or any nav. (A future admin-gated Gemini generation flow lives here too.)

// The current surface -> sprite assignment, lifted from the Earth overworld game (the
// only place that has depicted these so far). A flat map for now; if the system lands,
// `sprite` becomes a canonical field on the @fluncle/registry `Surface` type and this
// map dissolves into the catalog itself.
const SPRITE_BY_SURFACE: Record<string, string> = {
  "cron.newsletter": "/earth/comms_mailbox.png",
  "dns.zone": "/earth/edge_switchboard.png",
  "mcp.server": "/earth/edge_terminal.png",
  "ssh.rave": "/earth/crt.png",
  "subdomain.dig": "/earth/edge_switchboard.png",
  "subdomain.galaxy": "/earth/launch_rocket.png",
  "subdomain.onion": "/earth/edge_onion.png",
  "subdomain.radio": "/earth/radio.png",
  "subdomain.status": "/earth/edge_fusebox.png",
  "web.about": "/earth/landing_board.png",
  "web.galaxy": "/earth/launch_rocket.png",
  "web.home": "/earth/landing_monolith.png",
  "web.log": "/earth/landing_logbook.png",
  "web.mixtapes": "/earth/turntable.png",
  "web.newsletter": "/earth/comms_mailbox.png",
  "web.radio": "/earth/radio.png",
  "web.status": "/earth/edge_fusebox.png",
};

// The Galaxy game's sprite set (the first-person /galaxy). The raw collection.
const GALAXY_SPRITES = ["earth", "asteroid", "roadster", "ship", "ufo"];

// The Earth overworld game's prop set — the source pool the registry sprites are drawn
// from. The raw collection (includes props not yet bound to any surface).
const EARTH_SPRITES = [
  "boombox",
  "comms_camcorder",
  "comms_mailbox",
  "comms_pager",
  "comms_polaroids",
  "comms_robot",
  "crt",
  "edge_fusebox",
  "edge_onion",
  "edge_switchboard",
  "edge_terminal",
  "floppy",
  "landing_board",
  "landing_lens",
  "landing_logbook",
  "landing_monolith",
  "landing_nokia",
  "launch_rocket",
  "radio",
  "turntable",
];

const SECTION_HEADING =
  "mb-5 flex items-baseline gap-2 border-b border-border pb-2 text-sm font-semibold uppercase tracking-wide text-foreground";

// One inspector cell: a uniform framed square holding the pixel sprite (crisp, never
// smoothed), or a dashed placeholder where a sprite is still missing, with the name
// beneath. Uniform cells make the grid read as a sprite sheet, so style drift and the
// coverage gap are both obvious at a glance.
function SpriteTile({ name, src }: { name: string; src?: string }) {
  return (
    <figure className="flex flex-col items-center gap-1.5">
      <div
        className={`flex aspect-square w-full items-center justify-center rounded-md border ${
          src ? "border-border bg-card/40" : "border-dashed border-border/50 bg-transparent"
        }`}
      >
        {src ? (
          <img
            alt=""
            aria-hidden="true"
            className="size-16 [image-rendering:pixelated]"
            src={src}
          />
        ) : (
          <span className="text-lg text-muted-foreground/40">+</span>
        )}
      </div>
      <figcaption
        className="w-full truncate text-center text-[11px] text-muted-foreground"
        title={name}
      >
        {name}
      </figcaption>
    </figure>
  );
}

function SpriteGrid({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-3 gap-4 sm:grid-cols-4 md:grid-cols-6">{children}</div>;
}

function SpritesPage() {
  const mapped = SURFACES.filter((surface) => SPRITE_BY_SURFACE[surface.name]).length;

  return (
    <main className="log-plate-stage">
      <article className="log-plate text-foreground">
        <header className="log-masthead">
          <p className="log-nameplate">Fluncle's Findings</p>
          <h1 className="log-coordinate log-index-title">Sprite System</h1>
          <p className="mt-2 max-w-prose text-sm text-muted-foreground">
            Every pixel sprite across the Galaxy in one place — the registry surfaces and their
            icons, plus the Galaxy and Earth sprite collections — so we can inspect them together
            and hold them to one consistent style.
          </p>
        </header>

        <section>
          <h2 className={SECTION_HEADING}>
            Registry surfaces
            <span className="font-normal normal-case tracking-normal text-muted-foreground">
              {mapped} / {SURFACES.length} have a sprite
            </span>
          </h2>
          <SpriteGrid>
            {SURFACES.map((surface) => (
              <SpriteTile
                key={surface.name}
                name={surface.name}
                src={SPRITE_BY_SURFACE[surface.name]}
              />
            ))}
          </SpriteGrid>
        </section>

        <section>
          <h2 className={SECTION_HEADING}>
            Galaxy
            <span className="font-normal normal-case tracking-normal text-muted-foreground">
              the first-person game
            </span>
          </h2>
          <SpriteGrid>
            {GALAXY_SPRITES.map((name) => (
              <SpriteTile key={name} name={name} src={`/galaxy/${name}.png`} />
            ))}
          </SpriteGrid>
        </section>

        <section>
          <h2 className={SECTION_HEADING}>
            Earth overworld
            <span className="font-normal normal-case tracking-normal text-muted-foreground">
              the prop set
            </span>
          </h2>
          <SpriteGrid>
            {EARTH_SPRITES.map((name) => (
              <SpriteTile key={name} name={name} src={`/earth/${name}.png`} />
            ))}
          </SpriteGrid>
        </section>
      </article>
    </main>
  );
}

export const Route = createFileRoute("/sprites")({
  component: SpritesPage,
  head: () => ({ meta: [{ content: "noindex, nofollow", name: "robots" }] }),
});
