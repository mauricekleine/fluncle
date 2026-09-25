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

  const editionsQuery = useQuery({
    initialData: initialEditions,
    queryFn: loadEditions,
    queryKey: ["rec-editions"],
    refetchOnWindowFocus: false,
    staleTime: 5 * 60_000,
  });

  const editions = editionsQuery.data;

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
