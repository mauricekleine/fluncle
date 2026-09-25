export function stripSsml(text: string): string {
  return text
    .replace(/<[^>]*>/g, " ")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}
