export function buildSaveSetBody(
  name: string,
  serializedSet: string,
  serializedTaste: string,
): { name: string; set: string; taste: string } {
  return { name: name.trim(), set: serializedSet, taste: serializedTaste };
}

export function canSaveSet({ chainLength, name }: { chainLength: number; name: string }): boolean {
  return chainLength > 0 && name.trim().length > 0;
}
