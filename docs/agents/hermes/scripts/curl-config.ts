export function curlUrlConfig(url: string): string {
  const escaped = url
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r");

  return `url = "${escaped}"\n`;
}
