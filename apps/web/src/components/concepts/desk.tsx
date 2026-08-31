// Concept B — the Desk.
//
// The visitor QUERIES; the archive answers. Discovery here is filtering a large
// catalogue by the facets a drum & bass selector actually reads — tempo band, key,
// label, and "sounds like this record" — and Fluncle's own taste is not a separate
// list but a lit marker inside the results.
//
// ONE persistent workbench and no sub-pages. A direct arrival on a graph node is
// this same board PRE-FILLED and headed by that entity's identity, not a separate
// document. Every piece of state lives in the URL, so choosing a facet is a
// `Link` navigation rather than a client fetch, SSR always renders the true board,
// any state is a shareable link, and the browser's Back button is the undo.
//
// Register: workstation (DESIGN.md §5, The Three Areas Rule). Literal labels, no
// helper paragraphs, no nameplate, no narration, numbers contracted — and at most
// the ONE line a state genuinely needs.

import {
  CheckSquareIcon,
  MagnifyingGlassIcon,
  SlidersHorizontalIcon,
  SquareIcon,
  XIcon,
} from "@phosphor-icons/react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useId, useState } from "react";

import { Button } from "@fluncle/ui/components/button";
import { Input } from "@fluncle/ui/components/input";

import { DeskRow, EXACT_MATCH } from "@/components/concepts/desk-row";
import { Cover } from "@/components/concepts/shared";
import { type ConceptTrack, TEMPO_BANDS, billing, trackKey } from "@/concepts/discovery/model";
import { type DeskData, type DeskFacet, type DeskFilters } from "@/routes/-concepts-data";

/**
 * The tier control names what it SHOWS, with the archive's own noun. The other
 * tier is never named on this board — no badge, no heading, no noun — and this
 * one invents nothing: "finding" is the only named object in Fluncle's world
 * (DESIGN.md, The Unlit Rule; VOICE.md, The Name It Rule).
 */
const FINDINGS_ONLY = "Findings only";

/**
 * An applied facet, rendered above the board as one removable mark. `removeLabel`
 * exists only for a chip whose visible text is a sentence-case phrase rather than
 * a name the archive capitalises itself.
 */
type DeskChip = {
  label: string;
  name: string;
  removeLabel?: string;
  search: DeskFilters;
};

function tempoLabel(tempo: string): string {
  const band = TEMPO_BANDS.find((entry) => entry.id === tempo);

  if (band === undefined) {
    return tempo;
  }

  // The closed bands read "146 to 172", so the unit trails the phrase. The open
  // one reads "178 and up", where a trailing unit would land after the tail of
  // the sentence; there it goes next to the number it measures.
  return band.id === "fast" ? band.label.replace(" and up", " BPM and up") : `${band.label} BPM`;
}

/**
 * The applied state, read back in the order it narrows: what was typed, who, on
 * what, how fast, in what key, whose taste, and finally the sonic anchor — which
 * is last because it replaces the ORDER rather than trimming the set.
 */
function chipsFor(filters: DeskFilters, anchor: ConceptTrack | undefined): DeskChip[] {
  const chips: DeskChip[] = [];

  if (filters.q !== undefined) {
    chips.push({ label: filters.q, name: "q", search: { ...filters, q: undefined } });
  }

  if (filters.artist !== undefined) {
    chips.push({
      label: filters.artist,
      name: "artist",
      search: { ...filters, artist: undefined },
    });
  }

  if (filters.label !== undefined) {
    chips.push({ label: filters.label, name: "label", search: { ...filters, label: undefined } });
  }

  if (filters.tempo !== undefined) {
    chips.push({
      label: tempoLabel(filters.tempo),
      name: "tempo",
      search: { ...filters, tempo: undefined },
    });
  }

  if (filters.key !== undefined) {
    chips.push({ label: filters.key, name: "key", search: { ...filters, key: undefined } });
  }

  // Named by what it SHOWS. The other tier is never named anywhere on this board
  // (DESIGN.md, The Unlit Rule).
  if (filters.tier === "lit") {
    chips.push({
      label: FINDINGS_ONLY,
      name: "tier",
      removeLabel: "findings only",
      search: { ...filters, tier: undefined },
    });
  }

  if (filters.soundsLike !== undefined) {
    chips.push({
      label: `Sounds like ${anchor === undefined ? filters.soundsLike : billing(anchor)}`,
      name: "soundsLike",
      search: { ...filters, soundsLike: undefined },
    });
  }

  return chips;
}

function countLine(shown: number, total: number): string {
  const noun = total === 1 ? "track" : "tracks";

  return shown < total ? `${shown} of ${total} ${noun}` : `${total} ${noun}`;
}

/**
 * One facet group. Each option is a `Link` that applies it and, when it is already
 * applied, removes it — so the rail is its own undo and the board never needs a
 * client fetch. An option the board cannot reach stays plain text rather than a
 * control that would do nothing.
 */
function FacetGroup({
  active,
  facets,
  search,
  title,
}: {
  active: string | undefined;
  facets: DeskFacet[];
  search: (value: string | undefined) => DeskFilters;
  title: string;
}) {
  // A group the current board cannot reach at all drops out rather than standing
  // there as a column of zeroes.
  if (facets.every((facet) => facet.count === 0 && facet.value !== active)) {
    return null;
  }

  return (
    <div className="desk-group">
      <h2 className="desk-group-title">{title}</h2>
      <ul className="desk-facets">
        {facets.map((facet) => {
          const applied = facet.value === active;

          return (
            <li key={facet.value}>
              {facet.count === 0 && !applied ? (
                <span className="desk-facet">
                  <span className="desk-facet-label">{facet.label}</span>
                  <span className="desk-facet-count concept-display">0</span>
                </span>
              ) : (
                <Link
                  aria-current={applied ? "true" : undefined}
                  activeOptions={EXACT_MATCH}
                  className="desk-facet concept-focus"
                  search={search(applied ? undefined : facet.value)}
                  to="/concepts/desk"
                >
                  <span className="desk-facet-label">{facet.label}</span>
                  <span className="desk-facet-count concept-display">{facet.count}</span>
                </Link>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function Desk({ data }: { data: DeskData }) {
  const { anchor, entity, facets, filters, rows, sonicSeeds, total } = data;
  const navigate = useNavigate();
  const [railOpen, setRailOpen] = useState(false);
  const railId = useId();
  const titleId = useId();
  const queryId = useId();
  const seedsId = useId();
  const boardId = useId();

  const chips = chipsFor(filters, anchor);
  const seeded = new Set(
    sonicSeeds.flatMap((seed) => (seed.logId === undefined ? [] : [seed.logId])),
  );

  // The one line a state needs. A sonic query the capture cannot rank says so
  // plainly rather than pretending the board answered it.
  const orderLine =
    filters.soundsLike === undefined
      ? undefined
      : anchor === undefined
        ? "Can't match that one by sound. Showing every track."
        : `Closest in sound to ${billing(anchor)}.`;

  return (
    <main className="desk">
      <div className="desk-plate concept-plate">
        <header className="desk-head">
          {entity === undefined ? (
            <h1 className="desk-title concept-display" id={titleId}>
              Tracks
            </h1>
          ) : (
            <div className="desk-identity">
              <Cover
                alt=""
                className="desk-identity-cover"
                lit={entity.certified}
                priority
                src={entity.imageUrl}
              />
              <div className="desk-identity-text">
                <h1 className="desk-title concept-display">{entity.name}</h1>
                <p className="desk-findings">{entity.findingCount} recommended by Fluncle</p>
                {/* The factual dossier paragraph, third person, only when the
                    capture carried one. */}
                {entity.bio === undefined ? undefined : <p className="desk-bio">{entity.bio}</p>}
              </div>
            </div>
          )}

          {chips.length === 0 ? undefined : (
            <ul className="desk-chips">
              {chips.map((chip) => (
                <li key={chip.name}>
                  <Link
                    aria-label={`Remove ${chip.removeLabel ?? chip.label}`}
                    activeOptions={EXACT_MATCH}
                    className="desk-chip concept-focus"
                    search={chip.search}
                    to="/concepts/desk"
                  >
                    <span className="desk-chip-text">{chip.label}</span>
                    <XIcon aria-hidden="true" className="size-3" weight="bold" />
                  </Link>
                </li>
              ))}
            </ul>
          )}

          <div className="desk-readouts">
            <p aria-live="polite" className="desk-count">
              {countLine(rows.length, total)}
            </p>
            {chips.length > 1 ? (
              <Link
                activeOptions={EXACT_MATCH}
                className="desk-clear concept-focus"
                search={{}}
                to="/concepts/desk"
              >
                Clear filters
              </Link>
            ) : undefined}
          </div>

          {orderLine === undefined ? undefined : <p className="desk-order">{orderLine}</p>}
        </header>

        {/* The starting move for a visitor who typed nothing: the coordinates the
            archive holds a real ranking for, each one a whole board away. */}
        {sonicSeeds.length === 0 ? undefined : (
          <nav aria-labelledby={seedsId} className="desk-seeds">
            <h2 className="desk-group-title" id={seedsId}>
              Sounds like
            </h2>
            <ul className="desk-seed-list">
              {sonicSeeds.map((seed, index) => {
                const applied = seed.logId !== undefined && seed.logId === filters.soundsLike;

                return (
                  <li key={trackKey(seed, index)}>
                    <Link
                      aria-current={applied ? "true" : undefined}
                      activeOptions={EXACT_MATCH}
                      className="desk-seed concept-focus"
                      search={{ ...filters, soundsLike: applied ? undefined : seed.logId }}
                      to="/concepts/desk"
                    >
                      <Cover
                        alt=""
                        className="desk-seed-cover"
                        lit={seed.certified}
                        src={seed.coverUrl}
                      />
                      <span className="desk-seed-name">{billing(seed)}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </nav>
        )}

        <div className="desk-body">
          <nav aria-label="Filters" className="desk-rail">
            {/* On a narrow screen the rail folds into a disclosure. It opens in
                place and holds no focus, so a reader can tab straight past it into
                the board. */}
            <button
              aria-controls={railId}
              aria-expanded={railOpen}
              className="desk-rail-toggle concept-focus"
              onClick={() => setRailOpen((open) => !open)}
              type="button"
            >
              <SlidersHorizontalIcon aria-hidden="true" className="size-4" />
              Filters
            </button>

            <div className="desk-rail-body" data-open={railOpen ? "true" : "false"} id={railId}>
              {/* A real GET form, so the field works before hydration and the rest
                  of the board's state rides along in hidden fields. */}
              <form
                action="/concepts/desk"
                className="desk-search"
                method="get"
                onSubmit={(event) => {
                  event.preventDefault();
                  const typed = new FormData(event.currentTarget).get("q");
                  const q = typeof typed === "string" ? typed.trim() : "";

                  void navigate({
                    search: { ...filters, q: q === "" ? undefined : q },
                    to: "/concepts/desk",
                  });
                }}
              >
                <label className="desk-group-title" htmlFor={queryId}>
                  Search
                </label>
                <div className="desk-search-row">
                  <Input
                    defaultValue={filters.q ?? ""}
                    id={queryId}
                    key={filters.q ?? ""}
                    name="q"
                    placeholder="Artist, track, label"
                    type="search"
                  />
                  <Button type="submit">
                    <MagnifyingGlassIcon aria-hidden="true" className="size-4" />
                    Search
                  </Button>
                </div>
                {filters.artist === undefined ? undefined : (
                  <input name="artist" type="hidden" value={filters.artist} />
                )}
                {filters.key === undefined ? undefined : (
                  <input name="key" type="hidden" value={filters.key} />
                )}
                {filters.label === undefined ? undefined : (
                  <input name="label" type="hidden" value={filters.label} />
                )}
                {filters.soundsLike === undefined ? undefined : (
                  <input name="soundsLike" type="hidden" value={filters.soundsLike} />
                )}
                {filters.tempo === undefined ? undefined : (
                  <input name="tempo" type="hidden" value={filters.tempo} />
                )}
                {filters.tier === undefined ? undefined : (
                  <input name="tier" type="hidden" value={filters.tier} />
                )}
              </form>

              <Link
                aria-current={filters.tier === "lit" ? "true" : undefined}
                activeOptions={EXACT_MATCH}
                className="desk-toggle concept-focus"
                search={{ ...filters, tier: filters.tier === "lit" ? undefined : "lit" }}
                to="/concepts/desk"
              >
                {filters.tier === "lit" ? (
                  <CheckSquareIcon aria-hidden="true" className="size-4" weight="fill" />
                ) : (
                  <SquareIcon aria-hidden="true" className="size-4" />
                )}
                {FINDINGS_ONLY}
              </Link>

              <FacetGroup
                active={filters.tempo}
                facets={facets.tempos}
                search={(value) => ({
                  ...filters,
                  tempo: TEMPO_BANDS.find((band) => band.id === value)?.id,
                })}
                title="Tempo"
              />
              <FacetGroup
                active={filters.key}
                facets={facets.keys}
                search={(value) => ({ ...filters, key: value })}
                title="Key"
              />
              <FacetGroup
                active={filters.label}
                facets={facets.labels}
                search={(value) => ({ ...filters, label: value })}
                title="Label"
              />
            </div>
          </nav>

          <section
            aria-labelledby={entity === undefined ? titleId : boardId}
            className="desk-board"
          >
            {/* The superset word: true of every row under it, and the only heading
                a mixed board is allowed (DESIGN.md, The Unlit Rule). It is spoken
                only when the masthead is naming an entity instead — a board headed
                "Tracks" already carries it, and saying it twice is one heading too
                many. */}
            {entity === undefined ? undefined : (
              <h2 className="sr-only" id={boardId}>
                Tracks
              </h2>
            )}

            {rows.length === 0 ? (
              <p className="desk-empty">
                No tracks match.{" "}
                <Link
                  activeOptions={EXACT_MATCH}
                  className="concept-focus"
                  search={{}}
                  to="/concepts/desk"
                >
                  Clear filters
                </Link>
              </p>
            ) : (
              <ul className="desk-rows">
                {rows.map((row, index) => (
                  <DeskRow
                    filters={filters}
                    key={trackKey(row, index)}
                    seedable={row.logId !== undefined && seeded.has(row.logId)}
                    track={row}
                  />
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </main>
  );
}
