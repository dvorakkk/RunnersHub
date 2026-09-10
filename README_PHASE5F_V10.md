# RunnersHub Phase 5F v10 — Spline Camera + Look-at Smoothing

## Base
Built from Phase 5F v9.1. Existing marker, pause/resume, scrubber, 3D terrain, satellite mode, terrain validation, points/rewards, and Strava/GPX flows are preserved.

## Camera changes
- Distance-parameterized Catmull-Rom route spline for continuous camera/marker motion.
- Local lon/lat scaling for more stable interpolation.
- Segment corridor clamping to reduce spline overshoot on sharp corners.
- Look-at bearing is derived from a forward/backward route window, not a single GPX vertex.
- Bearing is smoothed with shortest-angle interpolation.
- Preview time uses smoothstep easing.
- Camera uses a cinematic pitch profile and follows the spline position.
- Scrubber uses the same spline/camera solver, so dragging to a point does not snap to a raw GPX vertex.

## Important
This is still a browser preview implementation. Final MP4 rendering remains gated by the production renderer and 40-point charge rules already present in the project.
