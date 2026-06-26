import { createFileRoute } from "@tanstack/react-router";
import { SURFACES } from "@fluncle/registry";
import { SPRITE_BY_SURFACE, SPRITES, spriteUrl } from "@fluncle/sprites";

// The Sprite System — a plain, internal inventory of EVERY pixel sprite across the
// Galaxy in one place, so we can inspect them side by side and judge consistency. It
// holds three collections: the registry surfaces (each with its assigned sprite, or an
// empty placeholder where one is still missing), the Galaxy game sprites, and the Earth
// overworld props. This is step one toward a real, consistent sprite system — a shared
// set of guidelines (and, later, a generation pipeline) so new sprites never drift.
//
// noindex: an internal design/tooling surface, deliberately NOT in the registry, the
// sitemap, or any nav. (A future admin-gated Gemini generation flow lives here too.)

// All sprite data — the surface→sprite assignment + the collections — comes from
// @fluncle/sprites (the single source of truth: assets, manifest, and the resolver).

const SECTION_HEADING =
  "mb-5 flex items-baseline gap-2 border-b border-border pb-2 text-sm font-semibold uppercase tracking-wide text-foreground";

// The registry section shows only USER-FACING surfaces — the places a human actually
// visits or uses (web pages, sibling-host subdomains, the SSH terminal, the browser
// extension). The machine/infra surfaces (api, feed, discovery, dns, mcp, cli, cron) are
// real but not pages anyone lands on, so they earn no sprite slot here. `pending` (dark,
// pre-staged) surfaces are excluded too.
const USER_FACING_KINDS = new Set(["web_route", "subdomain", "ssh", "extension"]);

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
  const surfaces = SURFACES.filter(
    (surface) => USER_FACING_KINDS.has(surface.kind) && surface.pending !== true,
  );
  const mapped = surfaces.filter((surface) => SPRITE_BY_SURFACE[surface.name]).length;

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
              user-facing — {mapped} / {surfaces.length} have a sprite
            </span>
          </h2>
          <SpriteGrid>
            {surfaces.map((surface) => {
              const ref = SPRITE_BY_SURFACE[surface.name];
              return (
                <SpriteTile
                  key={surface.name}
                  name={surface.name}
                  src={ref ? spriteUrl(ref) : undefined}
                />
              );
            })}
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
            {SPRITES.galaxy.map((id) => (
              <SpriteTile key={id} name={id} src={spriteUrl({ collection: "galaxy", id })} />
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
            {SPRITES.earth.map((id) => (
              <SpriteTile key={id} name={id} src={spriteUrl({ collection: "earth", id })} />
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
