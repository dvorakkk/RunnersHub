# RunnersHub Phase 5F v12 — Continuous Marker + Dynamic Cinematic Camera

## Testing mode
- Points: OFF
- Share unlock: OFF
- 3D preview: ON
- Video export: ON
- Video export cost: 0 points

## Camera
- Uses the V11 simplified camera route.
- Continuous distance-parameterized runner marker uses raw route geometry.
- Dynamic heading with damped angular response.
- Heading is calculated from a wide look-behind/look-ahead window.
- Curvature-aware pitch/zoom changes are smoothly damped.
- Sharp turns/hairpins are not followed vertex-by-vertex.

## Important
The raw GPX is never simplified for statistics or validation. Only the camera path is simplified.
Final video generation calls the existing `prepare3dFlyover` API with `pointsCost: 0` for testing. A real renderer must still be configured server-side; the client does not fake a completed MP4.
