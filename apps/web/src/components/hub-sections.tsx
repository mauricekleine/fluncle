import { ArrowRightIcon } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { type ReactNode } from "react";
import { SegmentedControl } from "@/components/segmented-control";
import { HubTilePlay, type HubTileKind } from "@/components/hub-tile-play";
import { HUB_ORDER_OPTIONS, type HubOrder } from "@/lib/hub-order";

export function HubOrderSwitch({
  onChange,
  order,
  recentReady,
}: {
  onChange: (order: HubOrder) => void;
  order: HubOrder;
  recentReady: boolean;
}): ReactNode {
  return (
    <div className="hub-order">
      <SegmentedControl
        label="Order"
        onChange={onChange}
        options={
          recentReady
            ? HUB_ORDER_OPTIONS
            : HUB_ORDER_OPTIONS.filter((option) => option.value !== "recent")
        }
        value={order}
      />
    </div>
  );
}

export function HubThisMonth({
  children,
  count,
  label,
}: {
  children: ReactNode;
  count: number;
  label: string;
}): ReactNode {
  if (count === 0) {
    return undefined;
  }

  return (
    <section aria-labelledby="hub-this-month-title" className="hub-this-month">
      <div className="hub-this-month-head">
        <h2 className="hub-this-month-title" id="hub-this-month-title">
          This month
        </h2>
        <Link className="hub-this-month-link" to="/fresh">
          All new releases
          <ArrowRightIcon aria-hidden="true" weight="bold" />
        </Link>
      </div>
      <ul aria-label={label} className="hub-this-month-row">
        {children}
      </ul>
    </section>
  );
}

export function HubTile({
  children,
  kind,
  lit,
  name,
  round,
  slug,
}: {
  children: ReactNode;
  kind: HubTileKind;
  lit: boolean;
  name: string;
  round?: boolean;
  slug: string;
}): ReactNode {
  return (
    <li className="hub-tile" data-round={round ? "" : undefined}>
      {children}
      <HubTilePlay kind={kind} lit={lit} name={name} slug={slug} />
    </li>
  );
}
