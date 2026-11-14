# Web browsing (Kitesurf)

The agent can read public web pages with one read-only tool, `browse_page`. Pages are rendered by
[Kitesurf](https://developers.cloudflare.com/browser-run/kitesurf/), Cloudflare's Workers-based
browser engine for agents, through the Browser Run binding. Kitesurf is in beta and **free behind
per-account limits** (Cloudflare docs, Nov 13, 2026). Talorys does **not** self-host Kitesurf: the
open-source engine (github.com/cloudflare/kitesurf, Apache 2.0) needs Dynamic Workers, which are part
of the Workers Paid plan.

Code: `apps/agent/src/browsing/` (engine, URL guard, text shaping, usage counters, tool, routes).

## The tool

`browse_page { url, start?, max_chars?, include_links? }` returns:

| field | meaning |
| --- | --- |
| `title`, `status`, `final_url` | page title, the site's HTTP status, URL after redirects |
| `engine` | `kitesurf`, `chromium` or `fetch` — which engine produced the text |
| `note` | which engines failed before it and why (only when there was a fallback) |
| `content` | compact Markdown: link targets and images removed, at most `max_chars` (default 8,000, max 20,000) |
| `total_chars`, `next_start` | paging: call again with `start = next_start` to read on |
| `links` | up to 40 distinct http(s) links, only when `include_links: true` |

It is a `read` tool, so scheduled runs can use it too. At most 3 calls per turn.

No screenshot tool: tool results reach the model as text only (no image parts in the message
pipeline), so a screenshot would be bytes the model cannot see. `extract_json` was left out too —
Browser Run's `json` action runs a Workers AI model on the account, so it is not free.

## Engines, in order

1. **Kitesurf** — `env.BROWSER.quickAction("markdown", { url, browser: "kitesurf", gotoOptions, cacheTTL: 300 })`.
2. **Chromium** (optional) — the same call without `browser`. Only when Settings → `browsing.chromiumFallback`
   is on and today's Chromium count is under `browsing.maxChromiumPerDay` (default 10). Off by default:
   Chromium uses the account's Browser Run time (Workers Free: 10 browser minutes a day).
   Skipped after a Browser Run 429, since both engines share the account's Quick Action rate.
3. **Plain fetch** — a Worker `fetch()` with a rough HTML → Markdown conversion (no JavaScript). This is
   the only engine when the Worker has no `BROWSER` binding, and the last resort otherwise.

A Kitesurf attempt counts as failed (and falls through) when Browser Run errors or times out, when
the site answers 401/403/429/503 (usually a bot wall Kitesurf cannot pass — it has no real TLS
fingerprint), or when the page renders empty. A real 404 is returned as-is with a `warning`.

Kitesurf cannot yet play video, render WebGL, pass bot challenges or keep long authenticated
sessions (Cloudflare docs). `links`, `scrape` and `snapshot` Quick Actions reject the Kitesurf backend
(workers-types), so links are taken from the Markdown instead of a second request.

## Safety

- **http(s) only**, standard ports (80, 443, 8080, 8443), no `user:pass@` URLs.
- **No private or internal hosts** (`url-guard.ts`): loopback, RFC 1918, CGNAT, link-local and
  cloud-metadata (169.254.x), IPv6 ULA/link-local/mapped, `localhost`, `.local`, `.internal`, `.lan`,
  single-label names. Checked on the requested URL, on every plain-fetch redirect hop (manual
  redirects, max 3), and on the browser's `finalUrl`. Not covered: a public name that resolves to a
  private IP (DNS rebinding); both engines run on Cloudflare's network, not the owner's LAN.
- **Timeouts**: 25 s per browser attempt (navigation 20 s), 15 s for plain fetch; plain fetch reads at most 2 MB.
- **No cookies, no sign-in, no forms.** Page text is data, never instructions (the system prompt says so).
- **Daily caps** (UTC day, same reset as Browser Run's free allowance): `maxPagesPerDay` (default 100)
  for all engines together, `maxChromiumPerDay` (default 10). Counters live in `tal_settings` key
  `browsing.usage`, including the `X-Browser-Ms-Used` browser time Browser Run reports.
- Errors reach the model as plain reasons ("This address is not opened because it points to a
  private or local network address.", "The daily browsing limit … is reached.", "The page could not
  be read (kitesurf: …; fetch: …)").

## Settings

Server-side, shared by web and mobile (`settings.browsing`):

```json
{ "enabled": true, "chromiumFallback": false, "maxPagesPerDay": 100, "maxChromiumPerDay": 10 }
```

Settings stored before this feature read as these defaults (on). The web Settings → AI tab has one
switch, “Web browsing (Kitesurf)” (`enabled`); the other fields are changed with `PATCH /api/settings`.
Backups do not import `browsing` (like `limits`).

## API

- `GET /api/browsing/status` — settings, whether the `BROWSER` binding exists, the primary engine, today's counters.
- `POST /api/browsing/test { url, chromium? }` — reads one page the way the tool does (no model), with
  per-engine timings. Counts against the same caps. For checking a deploy or whether a site works on Kitesurf.

Both need the owner session like every other route.

## Deploying

`deploy/agent.wrangler.jsonc` has `"browser": { "binding": "BROWSER" }` (`quickAction()` needs a
compatibility date of 2026-03-24 or later). The binding needs no API token at runtime. The token
that runs `wrangler deploy` needs account-level **Workers Scripts: Edit** and **Browser Rendering
(Browser Run): Edit**.

`apps/agent/wrangler.jsonc` (local dev and tests) has no browser binding, so dev uses plain fetch.
To try Kitesurf under `wrangler dev`, add `"browser": { "binding": "BROWSER", "remote": true }` —
Kitesurf is not available in local mode.

## Limits and cost (as of Nov 14, 2026)

| | Workers Free | Workers Paid |
| --- | --- | --- |
| Kitesurf via Browser Run | free in beta, per-account limits | free in beta, per-account limits |
| Browser time (Chromium) | 10 min/day | 10 h/month, then $0.09/h |
| Quick Action requests | 1 every 10 s | 30/s |
| Browser timeout | 60 s | 60 s |

Sources: <https://developers.cloudflare.com/browser-run/kitesurf/>,
<https://developers.cloudflare.com/browser-run/limits/>,
<https://developers.cloudflare.com/browser-run/pricing/>,
<https://developers.cloudflare.com/changelog/post/2026-11-12-kitesurf-open-source/>.

The docs do not say whether Kitesurf calls count against the Workers Free Quick Action rate
(1 request per 10 s) or the 10 browser minutes; if they do, a second page within 10 s gets a 429 and
is read with plain fetch instead. `GET /api/browsing/status` shows the browser time Browser Run reported.
