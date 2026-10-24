import { beforeEach, describe, expect, mock, test } from "bun:test";

const opened: string[] = [];

await mock.module("../open-external", () => ({
  openExternal: async (target: string) => {
    opened.push(target);
  },
}));

const { openPlaylistCommand, openTelegramCommand } = await import("./open");

beforeEach(() => {
  opened.length = 0;
});

describe("fluncle open playlist", () => {
  test("opens the playlist page in the browser", async () => {
    await openPlaylistCommand("browser");

    expect(opened).toEqual([
      "https://open.spotify.com/playlist/1m5LADqpLjiBERdtqrIiL0?si=054d3c6cbcf14a36",
    ]);
  });

  test.each(["app", "default"] as const)("hands the %s mode the Spotify app URI", async (mode) => {
    await openPlaylistCommand(mode);

    expect(opened).toEqual(["spotify:playlist:1m5LADqpLjiBERdtqrIiL0"]);
  });
});

describe("fluncle open telegram", () => {
  test("opens the channel page in the browser", async () => {
    await openTelegramCommand("browser");

    expect(opened).toEqual(["https://t.me/fluncle"]);
  });

  test.each(["app", "default"] as const)("hands the %s mode the Telegram app URI", async (mode) => {
    await openTelegramCommand(mode);

    expect(opened).toEqual(["tg://resolve?domain=fluncle"]);
  });
});
