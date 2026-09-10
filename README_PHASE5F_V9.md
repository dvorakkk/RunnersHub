# RunnersHub Phase 5F v9 — Playback, Marker & Terrain Elevation Validation

Built on Phase 5F v8.

## Changes
- Persistent runner position marker on the 3D map.
- Marker selector: Default dot or 🏃 Runner icon.
- Preview playback controls: Preview, Pause, Resume, progress percentage.
- Pause preserves the exact elapsed preview position; Resume continues from that point.
- Route-following camera remains based on cumulative route distance and look-ahead bearing.
- Terrain elevation validation samples MapLibre's loaded terrain via `queryTerrainElevation()` with retries while DEM tiles arrive.
- When GPX elevation exists, validation reports mean/max difference against the loaded DEM.
- When GPX has no elevation, validation reports terrain sample range instead of comparing against fake zero values.
- GPX elevation parsing now preserves missing elevation as null.
- Satellite/Terrain mode remains available.

## Points
- Preview remains free.
- Final export remains 40 points when points mode is enabled.

## Important
Terrain validation is a diagnostic comparison. GPX elevation and DEM elevation may differ substantially because they come from different sources and processing methods.
