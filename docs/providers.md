# Third-Party Providers

A running ledger of the third-party services Fluncle depends on — what each is for, the plan and cost, the account it runs under, and how it's billed. Keep it current whenever a subscription is added, changed, or cancelled.

**No secrets here.** Card numbers, API keys, tokens, and passwords live in 1Password (the Fluncle vault), never in this file. This is the map of what we pay for and under which account — not the keys.

| Provider                     | Purpose                                                                                                                                                                                             | Plan / Cost           | Account         | Billing                                 | Notes                                                                                                                                                                                                 |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- | --------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Postiz](https://postiz.com) | Social publishing — pushes a track's video to TikTok (later YouTube Shorts / Instagram Reels) as a reviewable draft through one API, so the Worker holds a single key instead of per-platform OAuth | Hosted, **$29/month** | hey@fluncle.com | Mastercard — The Automation Bureau B.V. | `POSTIZ_API_KEY` lives on the Worker (1Password → Fluncle vault). Holds the per-platform channel connections. See the `fluncle-publish` skill and [track-lifecycle.md](./track-lifecycle.md) Phase 3. |

## Still to document

Services known to be in use whose plan / account / billing details aren't captured here yet — fill these in as confirmed (do not guess the numbers):

- **Cloudflare** — Workers (`apps/web`), R2 (the videos bucket), Workers Builds (CI/deploy)
- **Turso** — the libSQL production database
- **Hetzner** — VPS hosting (the `ssh rave.fluncle.com` app)
- **Loops** — newsletter sending (the Friday newsletter agent)
- **Firecrawl** — discovery crawling for the newsletter agent
- **Spotify**, **Telegram**, **Deezer / iTunes** — API access for metadata, posting, and preview audio
- **1Password** — secret storage (the Fluncle vault)
