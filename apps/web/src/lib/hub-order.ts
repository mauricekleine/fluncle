export type HubOrder = "az" | "most" | "recent";

export const HUB_ORDER_OPTIONS: readonly { label: string; value: HubOrder }[] = [
  { label: "Most tracks", value: "most" },
  { label: "Recently active", value: "recent" },
  { label: "A–Z", value: "az" },
];

export function hubOrderParam(value: unknown): "az" | "recent" | undefined {
  return value === "az" || value === "recent" ? value : undefined;
}

export function hubHref(
  path: "/albums" | "/artists" | "/labels",
  state: { order?: HubOrder; page?: number; q?: string },
): string {
  const params = new URLSearchParams();

  if (state.q !== undefined) {
    params.set("q", state.q);
  }
  if (state.order !== undefined && state.order !== "most") {
    params.set("order", state.order);
  }
  if (state.page !== undefined && state.page > 1) {
    params.set("page", String(state.page));
  }

  const query = params.toString();

  return query ? `${path}?${query}` : path;
}
