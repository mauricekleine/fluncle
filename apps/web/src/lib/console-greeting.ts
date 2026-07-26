import { colors } from "@fluncle/tokens";
import { telegramUrl } from "@/lib/fluncle-links";
import { fluncleAsciiLogo } from "@/lib/identity";

/**
 * The DELIBERATE console output on the homepage: the ASCII wordmark in Eclipse
 * Gold, then the Telegram invite. Anyone who opens devtools on a music site is
 * curious, and curiosity gets a door — this is the only place Fluncle speaks to
 * the console, and it is a greeting, never a debug leftover.
 *
 * Called once from the homepage mount effect, so it never runs during SSR.
 */
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
