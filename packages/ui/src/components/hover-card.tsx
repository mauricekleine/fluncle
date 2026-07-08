import { PreviewCard as PreviewCardPrimitive } from "@base-ui/react/preview-card";

import { cn } from "#lib/utils";

// A hover card: rich content revealed on hover/focus, dismissed on leave/blur. Unlike a
// Popover (which opens on click and manages focus into the popup), base-ui's PreviewCard
// owns the hover intent + open/close delays itself — so a hover breakdown reads without the
// focus/hover fight that flickers a click-Popover driven by manual mouse handlers.
function HoverCard({ ...props }: PreviewCardPrimitive.Root.Props) {
  return <PreviewCardPrimitive.Root data-slot="hover-card" {...props} />;
}

// Snappier than the base-ui defaults (600ms open / 300ms close), which feel sluggish for an
// inline grid glyph; the delays live on the trigger.
function HoverCardTrigger({
  closeDelay = 90,
  delay = 90,
  ...props
}: PreviewCardPrimitive.Trigger.Props) {
  return (
    <PreviewCardPrimitive.Trigger
      closeDelay={closeDelay}
      data-slot="hover-card-trigger"
      delay={delay}
      {...props}
    />
  );
}

function HoverCardContent({
  align = "center",
  alignOffset = 0,
  className,
  side = "top",
  sideOffset = 6,
  ...props
}: PreviewCardPrimitive.Popup.Props &
  Pick<PreviewCardPrimitive.Positioner.Props, "align" | "alignOffset" | "side" | "sideOffset">) {
  return (
    <PreviewCardPrimitive.Portal>
      <PreviewCardPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        className="isolate z-50"
        side={side}
        sideOffset={sideOffset}
      >
        <PreviewCardPrimitive.Popup
          data-slot="hover-card-content"
          className={cn(
            "z-50 flex w-60 origin-(--transform-origin) flex-col gap-2 rounded-md bg-popover p-3 text-sm text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-hidden duration-100 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
            className,
          )}
          {...props}
        />
      </PreviewCardPrimitive.Positioner>
    </PreviewCardPrimitive.Portal>
  );
}

export { HoverCard, HoverCardContent, HoverCardTrigger };
