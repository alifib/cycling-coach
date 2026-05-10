# Cycling Coach — Project Context

## Purpose
A personal cycling training tracker for a returning road cyclist in Denmark, ~98kg / 190W FTP, targeting 3.0+ W/kg over 6-9 months. Plan is structured around 3 rides per week with built-in recovery to prevent the burnout cycle that has previously broken consistency.

The user has an eating disorder history. Treat weight, food, and body conversation with care — never suggest aggressive deficits, never make weight loss the primary lever in advice, never gamify weight. The weekly weigh-in is a deliberate conscious moment, not an automated metric.

## Architecture

```
[index.html on GitHub Pages]
    ↓ fetch()
[Cloudflare Worker: worker.js]
    ↓ refreshes token + proxies
[Strava API]
```

- `index.html` — Single-file SPA. State in localStorage under key `cycling-coach-v2`. Hosted at https://YOUR-USERNAME.github.io/cycling-coach/
- `worker.js` — Cloudflare Worker that holds Strava `client_id`, `client_secret`, `refresh_token` as encrypted secrets. Exchanges refresh_token for short-lived access_token on each request. Endpoints: `/health`, `/activities?days=N`, `/athlete`.
- Secrets in the Worker: `STRAVA_CLIENT_ID`, `STRAVA_CLIENT_SECRET`, `STRAVA_REFRESH_TOKEN`, `ALLOWED_ORIGIN` (= GitHub Pages URL, no trailing slash).

## Training Plan Logic

4-week mesocycle, repeating:
- Week 1 (buildA): Sweet Spot Tuesday (2×20 @ 88-94% FTP), Z2 Thursday, long ride Sat/Sun
- Week 2 (buildB): Threshold Tuesday (4×8 @ 95-105% FTP), Z2 Thursday, long ride Sat/Sun
- Week 3 (buildA): repeat
- Week 4 (recovery): 2 rides only, all Z2, ~60% volume — **non-negotiable**, even if the user feels fresh

Zones derived from current FTP:
- Z2 endurance: 65-75% FTP
- Sweet Spot: 88-94% FTP
- Threshold: 95-105% FTP

## Hard Constraints

1. **Never propose >3 rides/week.** The whole point is sustainability. If the user asks for more, push back and explain why one quality ride per week is enough when life is stressful.
2. **Never skip the recovery week** in the plan logic. Even if W/kg progress is great.
3. **Weight is entered manually via Sunday check-in.** Don't add automation that pulls weight from Strava/HealthKit. This is deliberate per the user's stated relationship with food.
4. **Don't lower the safeguards in the coach response generator** (`generateCoachReply` in index.html) — high stress + low energy → recovery; weight loss >1kg/week → eat more; resting HR jump → rest days. These exist to catch overload.
5. **Strava integration is read-only.** Never use `activity:write` scope or post to Strava.
6. **Don't store credentials in `index.html`.** All secrets live in Cloudflare Worker secrets. The HTML only knows the Worker URL.

## Strava Activity Matching

`matchActivitiesToRides()` in index.html does global assignment (not greedy) across the Tue/Thu/Sat slots for the current week. Each (slot, activity) pair gets a score from `scoreSlotActivity()`:
- Duration fit relative to slot's `targetMin` (largest weight)
- Day-of-week proximity (tiebreaker)
- Long-ride affinity (a 180+ min ride boosts the long slot, penalizes weekday slots)

Strava sends `start_date_local` with a misleading `Z` suffix — must strip it before parsing as local. Worker exposes `start_local` and `start_utc` separately.

## Coach Tone

Direct, honest, no fluff. Examples in the existing `generateCoachReply`. The user does not want validation theater — they want a coach who flags when something's off and explains why. Acknowledge wins briefly, don't over-celebrate. When recommending recovery, be firm.

## Deploy Workflow

- HTML changes: edit `index.html` → commit → push → GitHub Pages updates in ~30s
- Worker changes: edit `worker.js` → copy contents → paste into Cloudflare dashboard → Deploy (no automated deploy currently; Wrangler CLI could be added later)

## Things Not Yet Built (don't add unless asked)

- Calendar integration (Google Calendar event creation)
- Indoor/outdoor toggle per ride
- Multi-week view / longer-term chart
- Export check-in data
- Notifications / reminders
- PWA / installable app manifest
- Auth (single-user app, runs in personal browser only)
