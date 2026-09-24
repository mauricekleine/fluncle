/** One stored renderable count decides both the page's robots gate and sitemap membership. */
export function publicEntityIndexable(count: number, floor: number): boolean;
export function publicEntityIndexable(alias: string, floor: number): string;
export function publicEntityIndexable(
  countOrAlias: number | string,
  floor: number,
): boolean | string {
  return typeof countOrAlias === "number"
    ? countOrAlias >= floor
    : `${countOrAlias}.renderable_track_count >= ?`;
}
