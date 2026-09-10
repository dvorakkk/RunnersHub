# Phase 5F v11 — Modular 3D Flyover

- Create 3D is isolated under `public/3dflyover/`.
- `3dflyover.js` orchestrates UI and map lifecycle.
- `route-simplifier.js` creates a separate camera path using distance resampling, RDP simplification and spline sampling. Raw GPX remains untouched.
- `camera.js` handles cinematic camera position/look-at smoothing.
- `3dflyover.css` contains module-specific overrides.
- TEST MODE: `points.enabled=false`, `shareUnlock.enabled=false`, `threeD.pointsCost=0`, `threeD.fallbackModes=[]`.
- Production can restore points cost 40 by config only.
