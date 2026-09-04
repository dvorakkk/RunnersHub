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

