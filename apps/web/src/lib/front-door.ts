export type FrontDoorCounts = {
  albums: number;
  artists: number;
  labels: number;
  tracks: number;
};

const frontDoorNumber = new Intl.NumberFormat("en-US");

export function frontDoorCount(count: number, one: string, many: string): string {
  return `${frontDoorNumber.format(count)} ${count === 1 ? one : many}`;
}
