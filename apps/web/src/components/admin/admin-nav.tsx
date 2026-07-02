import { FilmStripIcon, GearSixIcon, SignOutIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { type KeyNotation, useKeyNotation } from "@/lib/key-notation";

// Shared chrome for the authenticated admin surface: the board is `/admin` (the
// operator's home, the pipeline view of every finding — it absorbed the old Posts
// and Tag pages), the mixtape builder, the cross-set clip library, and the
// newsletter, plus the display-settings cog and sign out. Rendered inside
// AdminShell's header.
const LINKS = [
  { key: "board", label: "Board", to: "/admin" },
  { key: "mixtapes", label: "Mixtapes", to: "/admin/mixtapes" },
  { key: "clips", label: "Clip library", to: "/admin/clips" },
  { key: "newsletter", label: "Newsletter", to: "/admin/newsletter" },
] as const;

export type AdminNavCurrent = (typeof LINKS)[number]["key"];

export function AdminNav({ current }: { current: AdminNavCurrent }) {
  return (
    <nav aria-label="Admin" className="flex shrink-0 items-center gap-1">
      {LINKS.map((link) => (
        <Button
          key={link.key}
          nativeButton={false}
          render={<a href={link.to} />}
          size="sm"
          variant={current === link.key ? "secondary" : "ghost"}
        >
          {link.key === "clips" ? <FilmStripIcon aria-hidden="true" /> : undefined}
          {link.label}
        </Button>
      ))}
      <KeyNotationCog />
      <Button
        aria-label="Sign out"
        nativeButton={false}
        render={<a href="/api/admin/logout" />}
        size="icon-sm"
        variant="ghost"
      >
        <SignOutIcon aria-hidden="true" />
      </Button>
    </nav>
  );
}

// The admin display-settings cog (the Studio's SettingsCog pattern): a quiet gear
// that opens a popover of per-operator display preferences. Today it holds the
// key-notation toggle — musical scales (default) vs the Camelot wheel DJs mix by —
// which flips every admin key readout live via the useKeyNotation store.
const NOTATION_OPTIONS: { label: string; value: KeyNotation }[] = [
  { label: "Scales", value: "scales" },
  { label: "Camelot", value: "camelot" },
];

function KeyNotationCog() {
  const { notation, setNotation } = useKeyNotation();

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button aria-label="Display settings" size="icon-sm" variant="ghost">
            <GearSixIcon aria-hidden="true" />
          </Button>
        }
      />
      <PopoverContent align="end" className="w-64 space-y-3">
        <div className="space-y-1.5">
          <Label>Key notation</Label>
          <div className="flex gap-1.5">
            {NOTATION_OPTIONS.map((option) => (
              <Button
                key={option.value}
                aria-pressed={notation === option.value}
                className="flex-1"
                onClick={() => setNotation(option.value)}
                size="sm"
                variant={notation === option.value ? "secondary" : "outline"}
              >
                {option.label}
              </Button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            How keys read across the admin. Camelot is the wheel for harmonic mixing.
          </p>
        </div>
      </PopoverContent>
    </Popover>
  );
}
