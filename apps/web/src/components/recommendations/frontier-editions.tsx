// THE PAST-EDITIONS CONTROL — the quiet archive-browse on the /recommendations masthead.
// Fluncle full-replaces the Frontier playlist every week, so a great track that scrolled
// past is gone once the list turns over. This dropdown reaches back to any past edition's
// frozen tracklist (the edition dialog does the rendering); the reader can still open a
// track in Spotify or save it into their own list.
//
// A ghost control, never gold (Quiet Surface + One Sun — the door's single sun is already
// spent on "Get playlist"), heating toward the gold veil on hover (the Ignition Rule). It
// seeds off the loader's editions summary and refetches only after a real playlist refresh
// mints a new one; it renders nothing until there is at least one past edition to reach.

import { CaretDownIcon } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@fluncle/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@fluncle/ui/components/dropdown-menu";
import { formatDateLong } from "@/lib/format";
import { EditionDialog } from "./edition-dialog";
import {
  type FrontierEditionDetail,
  type FrontierEditionSummary,
  resolveOpenSummary,
} from "./shared";

export function FrontierEditions({
  csrfToken,
  initialEditions,
  loadEdition,
  loadEditions,
}: {
  csrfToken: string;
  initialEditions: FrontierEditionSummary[];
  loadEdition: (number: number) => Promise<FrontierEditionDetail | null>;
  loadEditions: () => Promise<FrontierEditionSummary[]>;
}) {
  const [openNumber, setOpenNumber] = useState<number | null>(null);

  // Seeded from the loader (SSR) and never refetched on focus — this is a public surface,
  // not the admin board. The staleTime is LOAD-BEARING: without it react-query treats the
  // seed as already stale and re-fetches on mount, defeating the SSR seed. Freshness rides
  // the mint (a real refresh invalidates ["rec-editions"]), never the clock.
  const editionsQuery = useQuery({
    initialData: initialEditions,
    queryFn: loadEditions,
    queryKey: ["rec-editions"],
    refetchOnWindowFocus: false,
    staleTime: 5 * 60_000,
  });

  const editions = editionsQuery.data;

  // Nothing to reach back to yet — the first edition lands with next week's refresh.
  if (editions.length === 0) {
    return null;
  }

  const openSummary = resolveOpenSummary(editions, openNumber);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button size="sm" variant="ghost" />}>
          Past editions
          <CaretDownIcon aria-hidden="true" weight="bold" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {editions.map((edition) => (
            <DropdownMenuItem key={edition.number} onClick={() => setOpenNumber(edition.number)}>
              {formatDateLong(edition.refreshedAt)}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <EditionDialog
        csrfToken={csrfToken}
        loadEdition={loadEdition}
        onClose={() => setOpenNumber(null)}
        summary={openSummary}
      />
    </>
  );
}
