import { Combobox as ComboboxPrimitive } from "@base-ui/react/combobox";
import { CaretDownIcon, CheckIcon, MagnifyingGlassIcon } from "@phosphor-icons/react";

import { cn } from "#lib/utils";
import { InputGroup, InputGroupAddon } from "#components/input-group";

// The Base-UI combobox (shadcn `base-vega` registry), adapted to Fluncle's tokens and Phosphor
// iconography and pared to a SELECT-LIKE combobox: a trigger button anchors the popup, and the
// typeahead input lives INSIDE the popup (the classic Popover+Command shape). Only the parts the
// app uses are re-exported — Base-UI 1.6 ships no `Separator` part, and chips/groups are unused.
// Filtering is the caller's (`filter={null}` on the Root) so a free-typed value can be offered as
// a creatable option; keyboard access, the listbox roles, and Escape/arrow handling come from
// Base-UI unchanged.

const Combobox = ComboboxPrimitive.Root;

function ComboboxValue({ ...props }: ComboboxPrimitive.Value.Props) {
  return <ComboboxPrimitive.Value data-slot="combobox-value" {...props} />;
}

function ComboboxTrigger({ className, children, ...props }: ComboboxPrimitive.Trigger.Props) {
  return (
    <ComboboxPrimitive.Trigger
      data-slot="combobox-trigger"
      className={cn(
        "flex w-fit items-center justify-between gap-1.5 rounded-md border border-input bg-transparent py-2 pr-2 pl-2.5 text-sm whitespace-nowrap shadow-xs transition-[color,box-shadow] outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30 dark:hover:bg-input/50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    >
      {children}
      <CaretDownIcon className="pointer-events-none size-4 text-muted-foreground" />
    </ComboboxPrimitive.Trigger>
  );
}

function ComboboxContent({
  className,
  align = "start",
  alignOffset = 0,
  side = "bottom",
  sideOffset = 4,
  ...props
}: ComboboxPrimitive.Popup.Props &
  Pick<ComboboxPrimitive.Positioner.Props, "align" | "alignOffset" | "side" | "sideOffset">) {
  return (
    <ComboboxPrimitive.Portal>
      <ComboboxPrimitive.Positioner
        side={side}
        sideOffset={sideOffset}
        align={align}
        alignOffset={alignOffset}
        className="isolate z-50"
      >
        <ComboboxPrimitive.Popup
          data-slot="combobox-content"
          className={cn(
            "group/combobox-content relative flex max-h-(--available-height) w-(--anchor-width) min-w-52 origin-(--transform-origin) flex-col overflow-hidden rounded-md bg-popover text-popover-foreground shadow-md ring-1 ring-foreground/10 duration-100 data-[side=bottom]:slide-in-from-top-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
            className,
          )}
          {...props}
        />
      </ComboboxPrimitive.Positioner>
    </ComboboxPrimitive.Portal>
  );
}

function ComboboxInput({ className, ...props }: ComboboxPrimitive.Input.Props) {
  return (
    <div data-slot="combobox-input-wrapper" className="p-1 pb-0">
      <InputGroup className="h-8! rounded-lg! border-input/30 bg-input/30 shadow-none! *:data-[slot=input-group-addon]:pl-2!">
        <ComboboxPrimitive.Input
          data-slot="combobox-input"
          className={cn(
            "w-full text-sm outline-hidden disabled:cursor-not-allowed disabled:opacity-50",
            className,
          )}
          {...props}
        />
        <InputGroupAddon>
          <MagnifyingGlassIcon className="size-4 shrink-0 opacity-50" />
        </InputGroupAddon>
      </InputGroup>
    </div>
  );
}

function ComboboxList({ className, ...props }: ComboboxPrimitive.List.Props) {
  return (
    <ComboboxPrimitive.List
      data-slot="combobox-list"
      className={cn(
        "no-scrollbar max-h-72 scroll-py-1 overflow-x-hidden overflow-y-auto p-1 outline-none",
        className,
      )}
      {...props}
    />
  );
}

function ComboboxItem({ className, children, ...props }: ComboboxPrimitive.Item.Props) {
  return (
    <ComboboxPrimitive.Item
      data-slot="combobox-item"
      className={cn(
        "relative flex w-full cursor-default items-center gap-2 rounded-sm py-1.5 pr-8 pl-2 text-sm outline-hidden select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    >
      {children}
      <ComboboxPrimitive.ItemIndicator
        render={
          <span className="pointer-events-none absolute right-2 flex size-4 items-center justify-center" />
        }
      >
        <CheckIcon className="pointer-events-none" />
      </ComboboxPrimitive.ItemIndicator>
    </ComboboxPrimitive.Item>
  );
}

function ComboboxEmpty({ className, ...props }: ComboboxPrimitive.Empty.Props) {
  return (
    <ComboboxPrimitive.Empty
      data-slot="combobox-empty"
      className={cn("py-6 text-center text-sm text-muted-foreground", className)}
      {...props}
    />
  );
}

export {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxTrigger,
  ComboboxValue,
};
