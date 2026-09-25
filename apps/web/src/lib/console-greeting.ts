import { colors } from "@fluncle/tokens";
import { telegramUrl } from "@/lib/fluncle-links";
import { fluncleAsciiLogo } from "@/lib/identity";

export function printConsoleGreeting(): void {
  console.log(
    `%c${fluncleAsciiLogo}`,
    `font: 800 10px ui-monospace, SFMono-Regular, Menlo, monospace; line-height: 1; color: ${colors.eclipseGold};`,
  );
  console.log(
    `%cFresh bangers, most nights. Tune in, junglist → ${telegramUrl}`,
    `color: ${colors.stardust}; font: 13px Oxanium, sans-serif;`,
  );
}
