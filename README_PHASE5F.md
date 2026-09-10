# RunnersHub Phase 5F — Public Activity Import + GPX Fallback

## What changed
- Create 3D accepts a public Strava activity URL without requiring Strava API credentials.
- Supports `strava.app.link/...` links by following redirects and inspecting the public page.
- Public import is best-effort: if Strava does not expose route geometry in the public HTML, the UI asks the user to use the GPX fallback.
- GPX fallback is parsed entirely in the browser; the GPX file is not uploaded to RunnersHub.
- Existing Strava OAuth remains available as an optional connection, but is not required for public-link import.
- Points are ON by default in this phase. Rewards navigation is shown automatically when `points.enabled` is true and hidden when false.
- Download/export fallback remains controlled by the existing share/ad configuration.
- 3D preview remains free; flyover export is configured at 40 points.

## Config
`public/config.js` is the only public feature switch file.

```js
points: { enabled: true }
```
Set `false` to hide Rewards/Points UI and disable points earning/spending. Do not put secrets in this file.

For the importer:
```js
stravaImport: {
  mode: "public-first",
  allowPublicActivityScrape: true,
  gpxFallback: true,
  requireOAuthForPublicImport: false
}
```

## Important limitation
Public-link extraction is intentionally not presented as a guaranteed Strava integration. Strava can change its public HTML or block automated requests. For reliable route geometry, the GPX fallback is the production-safe path until an official API integration is available and permitted for the intended use.

## v7/v8 3D engine note
The Create 3D map uses MapLibre terrain with Terrarium elevation tiles, a dedicated moving runner marker, distance-based camera following, and Terrain/Satellite basemap switching. GPX parsing remains local to the browser.
