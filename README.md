# RunnersHub Phase 5D — Route Clustering & Focus Mode

Based on the latest Phase 5C mobile menu + filter fixes.

## Changes
- Explore map now uses geographic/screen-space route clustering instead of country/province grouping.
- Cluster markers show the **number of routes in that area**.
- Cluster color indicates dominant route type: orange Trail, blue Road, purple Mixed.
- Clicking a cluster zooms into the area; individual routes appear at zoom 13+.
- Clicking an individual route activates Focus Mode: selected route is emphasized, other routes are dimmed.
- Added `✕ Clear Focus` map control.
- Clicking a route also scrolls/highlights its route card.
- Cluster counts are recalculated from the current filtered Explore route set.
- Existing Phase 5C mobile navigation, filter Close/Apply, rewards, AdSense, upload, caching and other features are retained.

## Notes
- Clustering is screen-space based, so it represents geographic density rather than administrative regions.
- Route count is based on the current filtered dataset, not the total database.
- At zoom 13+ individual route polylines are rendered.

## Color consistency patch
- Trail: orange #fc5200 across badges, hero highlights, type selector, cluster markers and upload preview.
- Road: blue #38bdf8.
- Mixed cluster: purple #8b5cf6.
- Upload preview updates immediately when Trail/Road selection changes.
- All Phase 5D clustering, focus mode, clear-focus control, route-card sync, and Phase 5C mobile/filter fixes are preserved.

## Phase 5E release mode

The browser-facing release switches live in `public/config.js`. The file contains a short usage guide at the top. Initial release is configured as:

- `download.unlockMode: "share"`
- points/rewards UI disabled
- display ads enabled
- rewarded ads disabled
- share unlock limited to 3 new route unlocks per anonymous runner per UTC day

The same config is loaded server-side so changing the browser UI alone cannot bypass the download gate. Do not put secrets in `public/config.js`.


## Phase 5F — 3D Flyover Preview & Export Foundation

- Adds a browser 3D-style flyover preview from the stored route/elevation profile.
- Preview is free; no points are charged.
- Final export target: MP4, 1080x1920, 9:16, 30 FPS, default 20 seconds.
- Final export is gated by `config.js` (`threeD.pointsCost = 40`) and requires rewards to be enabled.
- The final MP4 renderer is intentionally not faked. Set the Vercel environment variable `THREE_D_RENDERER_URL` only after a real renderer is deployed. Until then Generate reports that no points were charged.
- The preview includes customizable finish statistics and custom display time/pace/date fields.


### Important implementation note
The browser preview is functional and free. The final MP4 renderer is deliberately not simulated. Final export is only allowed to proceed after `THREE_D_RENDERER_URL` points to a real rendering service. Until then, the Generate button will not charge points and will report that the renderer is not configured.

## Phase 5F Revision — Create 3D + Strava OAuth

### Product behavior
- Points are ON by default in `public/config.js` via `points.enabled = true`.
- Rewards/Points navigation is derived from that one master switch.
- Download uses points when available; verified Share remains the fallback.
- Create 3D is a standalone navigation item and is not launched from Route Details.
- Create 3D requires Connect with Strava before the activity URL input appears.
- Supports normal Strava activity URLs and `strava.app.link/...` share links.
- The browser preview uses MapLibre GL JS with real raster DEM terrain.
- Final video target: 1080x1920, 9:16, 30 FPS, 20 seconds, with RunnersHub watermark and statistics outro.
- Final flyover costs 40 points when points are enabled. If points are insufficient, verified Share can be used as the configured fallback.

### Required Vercel environment variables
- `SPREADSHEET_ID`
- `GOOGLE_SERVICE_ACCOUNT_KEY_B64` or the existing Google OAuth variables already used by this project
- `STRAVA_CLIENT_ID`
- `STRAVA_CLIENT_SECRET`
- `STRAVA_CALLBACK_URL` — exact callback URL registered in Strava, e.g. `https://runnershub.vercel.app/api/call?action=stravaCallback`
- `STRAVA_STATE_SECRET` — long random secret used to sign OAuth state
- `STRAVA_TOKEN_ENCRYPTION_KEY` — base64-encoded 32-byte key used to encrypt Strava tokens before storing them in Sheets
- `STRAVA_POST_AUTH_URL` — usually `https://runnershub.vercel.app/#create3d`
- optional `STRAVA_API_BASE_URL` — keep `https://www.strava.com/api/v3` until the planned API base transition
- optional `THREE_D_TERRAIN_URL` — DEM TileJSON URL; default is `https://tiles.mapterhorn.com/tilejson.json`
- `THREE_D_RENDERER_URL` — required before final MP4 generation can charge points

### Spreadsheet sheets created automatically
`StravaConnections` and `FlyoverShareUnlocks` are provisioned by the existing Sheets helper.
Strava access/refresh tokens are encrypted before being written to the spreadsheet.

### Important
The Connect with Strava flow uses Strava OAuth and requests `activity:read` only. The API token is never sent to the browser. Public/allowed activities are loaded server-side and normalized for the 3D page.

For production, use Strava's official Connect with Strava button asset/branding rules rather than recreating their logo/button artwork.
