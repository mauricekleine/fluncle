import { bindings, defineConfig } from "cf/config";

export default defineConfig({
  worker: {
    assets: {
      runWorkerFirst: ["/llms.txt"],
    },
    compatibilityDate: "2026-06-03",
    compatibilityFlags: ["nodejs_compat"],
    entrypoint: "./src/server.ts",
    env: {
      CARTESIA_VOICE_ID: bindings.text("ca8c023f-1901-40f7-be8c-faafd7a58139"),
      CF_CACHE_PURGE_ZONE_ID: bindings.text("93b403e3d6ed70d10cdd2890c557376f"),
      OPENROUTER_CONTEXT_EFFORT: bindings.text("medium"),
      OPENROUTER_CONTEXT_MODEL: bindings.text("openai/gpt-5.6-luna"),
      OPENROUTER_REASONING_EFFORT: bindings.text("low"),
      OPENROUTER_SEARCH_MODEL: bindings.text("openai/gpt-5.6-luna"),
      R2_ACCOUNT_ID: bindings.text("0651fd3b33d9e0b2fe72a5f13e5cf65d"),
      SOURCE_AUDIO: bindings.r2({
        name: "fluncle-source-audio",
      }),
      SPOTIFY_ALBUM_TRACKS: bindings.kv({
        id: "a495cc659e554f5dbcd8246e4f9771bb",
      }),
      VIDEOS: bindings.r2({
        name: "fluncle-videos",
      }),
      VITE_FLUNCLE_SPOTIFY_PLAYLIST_URL: bindings.text(
        "https://open.spotify.com/playlist/1m5LADqpLjiBERdtqrIiL0?si=054d3c6cbcf14a36",
      ),
      VITE_FLUNCLE_TELEGRAM_URL: bindings.text("https://t.me/fluncle"),
    },
    name: "fluncle-web",
    observability: {
      enabled: true,
      headSamplingRate: 1,
      logs: {
        enabled: true,
        headSamplingRate: 1,
        invocationLogs: true,
        persist: true,
      },
      traces: {
        enabled: false,
        headSamplingRate: 1,
        persist: true,
      },
    },
    placement: {
      region: "aws:eu-west-1",
    },
  },
});
