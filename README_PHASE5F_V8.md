# Phase 5F v8 — Real 3D Terrain + Route Following

This patch fixes the Create 3D preview behavior:
- Uses MapLibre GL JS 4.7.1 browser build.
- Uses global Terrarium elevation tiles instead of the MapLibre demo DEM tiles.
- Enables real MapLibre terrain with stronger 3D pitch and terrain exaggeration.
- Adds a moving runner marker.
- Follows the route by cumulative distance, not raw GPX point index.
- Smooths camera bearing and looks ahead along the route to reduce camera jitter.
- Keeps Terrain/Satellite basemap switching while retaining 3D terrain.
- GPX parsing remains entirely local to the browser.
- Preview remains free; points are not charged by preview.

## Test order
1. Deploy this version.
2. Open Create 3D.
3. Upload a mountain/trail GPX with elevation.
4. Wait for `3D preview ready`.
5. Confirm terrain has visible relief.
6. Click `Preview Flyover`.
7. Confirm the orange runner marker follows the route and the camera follows smoothly.
8. Switch Terrain/Satellite during idle preview and reset view.

## Production note
The Terrarium elevation endpoint is a public elevation source for prototype/early validation. Before a public production launch, review tile usage, attribution, rate limits and choose a production DEM/tile provider appropriate for expected traffic.
