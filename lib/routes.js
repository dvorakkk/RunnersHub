/**
 * routes.js — API handlers for route CRUD and data retrieval.
 * Node.js port of Routes.gs. Logic is intentionally kept close to the
 * original so behavior matches exactly.
 */

const crypto = require("crypto");
const zlib = require("zlib");
const { CONFIG } = require("./config");
const { sheetToObjects, appendRow, deleteRowById, deleteRowsByIds } = require("./sheetHelpers");
const { saveGpxToDrive, getFileBuffer, trashFile, sanitize, uploadGpxChunkToDrive } = require("./driveHelpers");

function uuid() {
  return crypto.randomUUID();
}

// Phase 4A: short-lived server-side cache for expensive public route views.
// Vercel functions are ephemeral, so this is an optimization, not the source
// of truth. Writes invalidate it immediately on the warm instance.
const ROUTE_READ_CACHE_TTL_MS = 30 * 1000;
const routeReadCache = new Map();

function routeCacheGet(key) {
  const hit = routeReadCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.createdAt >= ROUTE_READ_CACHE_TTL_MS) {
    routeReadCache.delete(key);
    return null;
  }
  return JSON.parse(JSON.stringify(hit.value));
}

function routeCacheSet(key, value) {
  routeReadCache.set(key, { createdAt: Date.now(), value: JSON.parse(JSON.stringify(value)) });
  if (routeReadCache.size > 60) {
    const oldest = [...routeReadCache.entries()]
      .sort((a, b) => a[1].createdAt - b[1].createdAt)[0];
    if (oldest) routeReadCache.delete(oldest[0]);
  }
}

function invalidateRouteReadCache() {
  routeReadCache.clear();
}

// ─── saveRoute ──────────────────────────────────────────────────────────────

/**
 * Creates a new route record.
 *
 * @param {Object} meta        Route metadata from the frontend form
 * @param {string} base64Gpx   Base64-encoded GPX XML string (may be empty)
 * @returns {Object}           The saved route object (mirrors the sheet row)
 */
async function saveRoute(meta, base64Gpx) {
  if (!meta || !meta.route_name) throw new Error("route_name is required");
  if (!meta.uploader_runner_id) throw new Error("uploader_runner_id is required");
  if (!["Trail", "Road"].includes(meta.type))
    throw new Error("type must be 'Trail' or 'Road'");

  const routeId = uuid();
  meta.type = normalizeRouteType(meta.type);
  let gpxFileId = "";
  const name = String(meta.route_name).trim().substring(0, 120);
  if (!name) throw new Error("route_name is required");

  let validation = null;
  let gpxHash = "";

  if (base64Gpx) {
    validation = validateGpxBase64(base64Gpx, meta.gpx_encoding);
    gpxHash = validation.sha256;

    // Exact duplicate detection. This uses the GPX bytes, not the route name,
    // so the same file cannot silently create multiple route records.
    const existing = await findRouteByGpxHash(gpxHash);
    if (existing) {
      throw new Error(`This GPX has already been uploaded as "${existing.route_name}"`);
    }
  }

  let polylineJson = capPolylineJson(meta.polyline_json);

  // Distance is authoritative from the GPX when a GPX is supplied. This
  // prevents the browser form value from drifting away from the actual file.
  const distanceKm = validation
    ? validation.distanceKm
    : resolveDistanceKm(meta);

  if (!(distanceKm > 0)) {
    throw new Error("A valid route distance could not be determined");
  }

  // If every GPX point has elevation, use the server-validated elevation gain.
  // If elevation is incomplete, preserve the browser-calculated value.
  const elevGain = validation && validation.hasCompleteElevation
    ? validation.elevationGainM
    : normalizeElevation(meta.elev_gain);
  const computedStats = computeRouteStatsServer(meta.type, distanceKm, elevGain);

  // Decode and store GPX file in Drive only after all validation/duplicate
  // checks have passed, so invalid uploads do not leave orphaned Drive files.
  if (base64Gpx) {
    gpxFileId = await saveGpxToDrive(
      routeId,
      name,
      meta.country,
      validation.text
    );
  }

  const route = {
    route_id: routeId,
    route_name: name,
    type: meta.type,
    is_map_art: meta.is_map_art ? "true" : "false",
    distance_km: distanceKm,
    elev_gain: elevGain,
    level: String(computedStats.level || "").substring(0, 40),
    itra_display: String(computedStats.itra_display || "").substring(0, 60),
    country: (meta.country || "").trim().substring(0, 80),
    province: (meta.province || "").trim().substring(0, 80),
    regency: (meta.regency || "").trim().substring(0, 80),
    likes_count: 0,
    gpx_file_id: gpxFileId,
    polyline_json: polylineJson,
    details: (meta.details || "").trim().substring(0, 2000),
    timestamp: new Date().toISOString(),
    gpx_hash: gpxHash
  };

  try {
    await appendRow("Routes", route);
    invalidateRouteReadCache();
  } catch (e) {
    if (gpxFileId) await trashFile(gpxFileId);
    throw e;
  }
  return route;
}

function normalizeElevation(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : 0;
}

/**
 * Safely validates a GPX without introducing a third-party XML parser.
 * We deliberately use a small, tolerant GPX reader here because GPX point
 * elements are simple and this endpoint must remain dependency-free.
 */
function validateGpxBase64(base64, encoding = 'identity') {
  let bytes;
  try {
    bytes = Buffer.from(String(base64), "base64");
  } catch (e) {
    throw new Error("GPX payload is not valid base64");
  }
  if (String(encoding).toLowerCase() === 'gzip') {
    try { bytes = zlib.gunzipSync(bytes); }
    catch (e) { throw new Error('Compressed GPX payload could not be decompressed'); }
  } else if (String(encoding).toLowerCase() !== 'identity' && encoding) {
    throw new Error('Unsupported GPX encoding');
  }
  return validateGpxBytes(bytes);
}

function validateGpxBytes(bytes) {
  if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes || []);
  if (!bytes.length) throw new Error("GPX file is empty");
  if (bytes.length > 10 * 1024 * 1024) throw new Error("GPX file exceeds 10 MB limit");

  const text = bytes.toString("utf8");
  if (!/<gpx(?:\s|>)/i.test(text)) throw new Error("Invalid GPX: <gpx> root element not found");

  const pointRe = /<(?:[A-Za-z_][\w.-]*:)?(?:trkpt|rtept|wpt)\b([^>]*)>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?(?:trkpt|rtept|wpt)\s*>|<(?:[A-Za-z_][\w.-]*:)?(?:trkpt|rtept|wpt)\b([^>]*)\/>/gi;
  const points = [];
  let match;

  while ((match = pointRe.exec(text))) {
    const attrs = match[1] || match[3] || "";
    const inner = match[2] || "";
    const lat = parseAttr(attrs, "lat");
    const lon = parseAttr(attrs, "lon");
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      throw new Error("GPX contains an invalid latitude/longitude");
    }
    const eleRaw = parseElementText(inner, "ele");
    const ele = eleRaw === null ? null : Number(eleRaw);
    if (eleRaw !== null && !Number.isFinite(ele)) throw new Error("GPX contains an invalid elevation value");
    points.push({ lat, lon, ele });
  }

  if (points.length < 2) throw new Error("GPX has fewer than 2 valid route points");
  if (points.length > 250000) throw new Error("GPX contains too many route points (maximum 250,000)");

  let distanceKm = 0;
  for (let i = 1; i < points.length; i++) {
    const segment = haversineKmServer(points[i - 1].lat, points[i - 1].lon, points[i].lat, points[i].lon);
    if (!Number.isFinite(segment)) throw new Error("GPX contains an invalid route segment");
    if (segment > 200) throw new Error("GPX contains an abnormal coordinate jump (>200 km)");
    distanceKm += segment;
  }
  if (!(distanceKm > 0) || !Number.isFinite(distanceKm)) throw new Error("GPX route distance is zero or invalid");
  if (distanceKm > 5000) throw new Error("GPX route distance exceeds the 5,000 km safety limit");

  const hasCompleteElevation = points.every(p => p.ele !== null);
  let elevationGainM = 0;
  if (hasCompleteElevation) elevationGainM = computeElevationGainServer(points.map(p => p.ele), 3);

  return {
    text,
    bytes,
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    pointCount: points.length,
    distanceKm: Math.round(distanceKm * 100) / 100,
    elevationGainM,
    hasCompleteElevation
  };
}

async function initGpxUpload(meta, fileSize) {
  if (!meta || !meta.route_name) throw new Error("route_name is required");
  if (!meta.uploader_runner_id) throw new Error("uploader_runner_id is required");
  if (!['Trail', 'Road'].includes(normalizeRouteType(meta.type))) throw new Error("type must be 'Trail' or 'Road'");
  const size = Number(fileSize);
  if (!Number.isInteger(size) || size <= 0) throw new Error("Invalid GPX file size");
  if (size > 10 * 1024 * 1024) throw new Error("GPX file exceeds 10 MB limit");

  const name = String(meta.route_name).trim().substring(0, 120);
  if (!name) throw new Error("route_name is required");
  const routeId = uuid();
  const { createGpxResumableSession } = require("./driveHelpers");
  const session = await createGpxResumableSession(routeId, name, meta.country, size);
  return { routeId, ...session, maxBytes: 10 * 1024 * 1024 };
}


async function uploadGpxChunk(sessionUrl, base64Chunk, start, endExclusive, totalSize) {
  return await uploadGpxChunkToDrive(sessionUrl, base64Chunk, start, endExclusive, totalSize);
}

async function finalizeGpxUpload(meta, gpxFileId, fileSize) {
  if (!meta || !meta.route_name) throw new Error("route_name is required");
  if (!meta.uploader_runner_id) throw new Error("uploader_runner_id is required");
  if (!gpxFileId) throw new Error("gpxFileId is required");
  const expectedSize = Number(fileSize);
  if (!Number.isInteger(expectedSize) || expectedSize <= 0 || expectedSize > 10 * 1024 * 1024) throw new Error("Invalid GPX file size");

  let validation;
  try {
    const bytes = await getFileBuffer(gpxFileId);
    if (bytes.length !== expectedSize) throw new Error("Uploaded GPX size does not match the selected file");
    validation = validateGpxBytes(bytes);

    const existing = await findRouteByGpxHash(validation.sha256);
    if (existing) throw new Error(`This GPX has already been uploaded as "${existing.route_name}"`);

    const type = normalizeRouteType(meta.type);
    const distanceKm = validation.distanceKm;
    const elevGain = validation.hasCompleteElevation ? validation.elevationGainM : normalizeElevation(meta.elev_gain);
    const computedStats = computeRouteStatsServer(type, distanceKm, elevGain);
    const route = {
      route_id: String(meta.route_id || uuid()),
      uploader_runner_id: String(meta.uploader_runner_id || "").trim(),
      route_name: String(meta.route_name).trim().substring(0, 120),
      type,
      is_map_art: meta.is_map_art ? "true" : "false",
      distance_km: distanceKm,
      elev_gain: elevGain,
      level: String(computedStats.level || "").substring(0, 40),
      itra_display: String(computedStats.itra_display || "").substring(0, 60),
      country: (meta.country || "").trim().substring(0, 80),
      province: (meta.province || "").trim().substring(0, 80),
      regency: (meta.regency || "").trim().substring(0, 80),
      likes_count: 0,
      gpx_file_id: gpxFileId,
      polyline_json: capPolylineJson(meta.polyline_json),
      details: (meta.details || "").trim().substring(0, 2000),
      timestamp: new Date().toISOString(),
      gpx_hash: validation.sha256
    };

    try {
      await appendRow("Routes", route);
      invalidateRouteReadCache();
    } catch (e) {
      await trashFile(gpxFileId);
      throw e;
    }

    // Reward is best-effort after a successful publish. A reward-sheet failure
    // must never turn a valid published route into a false upload failure.
    let reward = null;
    try {
      const { claimUploadReward } = require("./rewards");
      reward = await claimUploadReward(route.uploader_runner_id, route.route_id);
    } catch (rewardErr) {
      console.error("[Rewards] upload reward failed after successful publish:", rewardErr);
      reward = { uploadReward: false, error: rewardErr.message };
    }

    return { route, reward };
  } catch (e) {
    // If validation/finalization fails, the Drive file is an orphan and should
    // be removed. The browser never needs to know this cleanup detail.
    await trashFile(gpxFileId);
    throw e;
  }
}

function parseAttr(attrs, name) {
  const re = new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, "i");
  const m = attrs.match(re);
  return m ? Number(m[2]) : NaN;
}

function parseElementText(inner, name) {
  const re = new RegExp(`<(?:(?:[A-Za-z_][\\w.-]*):)?${name}\\b[^>]*>([\\s\\S]*?)<\\/(?:(?:[A-Za-z_][\\w.-]*):)?${name}\\s*>`, "i");
  const m = inner.match(re);
  return m ? String(m[1]).trim() : null;
}

function haversineKmServer(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
}

function computeElevationGainServer(elevations, threshold) {
  if (!elevations || elevations.length < 2) return 0;
  let gain = 0;
  let baseline = elevations[0];
  for (let i = 1; i < elevations.length; i++) {
    const diff = elevations[i] - baseline;
    if (diff >= threshold) {
      gain += diff;
      baseline = elevations[i];
    } else if (diff <= -threshold) {
      baseline = elevations[i];
    }
  }
  return Math.round(gain);
}

async function findRouteByGpxHash(hash) {
  if (!hash) return null;
  const routes = await sheetToObjects("Routes");
  return routes.find(r => String(r.gpx_hash || "") === hash) || null;
}

/**
 * Resolve distance without reparsing the GPX on the server. The browser already
 * calculates it from the uploaded GPX. If that value is missing, use the stored
 * route profile as a safe fallback.
 */
function resolveDistanceKm(meta) {
  const client = Number(meta && meta.distance_km);
  if (Number.isFinite(client) && client > 0) {
    return Math.round(client * 100) / 100;
  }

  const fromProfile = distanceFromPolyline(meta && meta.polyline_json);
  if (fromProfile > 0) return fromProfile;

  return 0;
}

function distanceFromPolyline(raw) {
  try {
    const v = typeof raw === "string" ? JSON.parse(raw || "[]") : raw;
    if (!v || !Array.isArray(v.profile) || v.profile.length < 2) return 0;
    const last = Number(v.profile[v.profile.length - 1][0]);
    return Number.isFinite(last) && last > 0
      ? Math.round(last * 100) / 100
      : 0;
  } catch (e) {
    return 0;
  }
}

// ─── ROUTE DIFFICULTY ALGORITHMS ──────────────────────────────────────────────
// ITRA Endurance Points follow the published km-effort formula. The difficulty
// label is Runnershub's own model and must not be presented as an official ITRA
// difficulty rating.
function calcITRAServer(distKm, elevGainM) {
  const d = Math.max(0, Number(distKm) || 0);
  const e = Math.max(0, Number(elevGainM) || 0);
  const ke = d + e / 100;
  let points, label;
  if      (ke < 25)  { points = 0; label = 'XXS'; }
  else if (ke < 45)  { points = 1; label = 'XS'; }
  else if (ke < 75)  { points = 2; label = 'S'; }
  else if (ke < 115) { points = 3; label = 'M'; }
  else if (ke < 155) { points = 4; label = 'L'; }
  else if (ke < 210) { points = 5; label = 'XL'; }
  else               { points = 6; label = 'XXL'; }

  const density = d > 0 ? e / d : 0;
  const terrain = density < 10 ? 'Flat'
    : density < 25 ? 'Rolling'
    : density < 50 ? 'Hilly'
    : 'Mountainous';
  const score = Math.round(Math.min(60, ke * 1.2) + Math.min(40, density * 0.5));
  const level = score < 25 ? 'Easy' : score < 45 ? 'Moderate' : score < 70 ? 'Hard' : 'Very Hard';

  return {
    km_effort: Math.round(ke * 10) / 10,
    itra_points: points,
    itra_label: label,
    itra_display: `${points} ITRA (${label})`,
    level,
    difficulty_score: score,
    terrain_label: terrain,
    elevation_density: Math.round(density * 10) / 10
  };
}

function calcRoadServer(distKm, elevGainM) {
  const d = Math.max(0, Number(distKm) || 0);
  const e = Math.max(0, Number(elevGainM) || 0);
  const density = d > 0 ? e / d : 0;
  const terrain = density < 10 ? 'Flat Course'
    : density < 25 ? 'Rolling Course'
    : density < 50 ? 'Hilly Course'
    : 'Very Hilly Course';

  // Road distance category is a Runnershub classification, not an official
  // race category. Do not classify a 14 km route as Half Marathon simply
  // because it falls below 21.1 km. Use explicit distance bands with
  // intermediate/custom labels so the displayed category stays honest.
  const distCat = d < 1 ? 'Custom Run'
    : d <= 6.5 ? '5K / Fun Run'
    : d <= 12.5 ? '10K'
    : d <= 18 ? '10K+'
    : d <= 25 ? 'Half Marathon'
    : d <= 35 ? 'Half Marathon+'
    : d <= 50 ? 'Marathon'
    : d <= 60 ? 'Marathon+'
    : 'Ultra Road';

  const distanceScore = d <= 6.5 ? 6
    : d <= 12.5 ? 12
    : d <= 18 ? 17
    : d <= 25 ? 22
    : d <= 35 ? 29
    : d <= 50 ? 36
    : d <= 60 ? 45
    : 55;
  const terrainScore = density < 10 ? 0 : density < 25 ? 8 : density < 50 ? 18 : 28;
  const score = distanceScore + terrainScore;
  const level = score < 20 ? 'Easy' : score < 35 ? 'Moderate' : score < 55 ? 'Hard' : 'Very Hard';

  return {
    grade_label: terrain,
    terrain_label: terrain,
    dist_category: distCat,
    itra_display: distCat,
    level,
    difficulty_score: score,
    elevation_density: Math.round(density * 10) / 10
  };
}

function computeRouteStatsServer(type, distKm, elevGainM) {
  return String(type || '').trim().toLowerCase() === 'trail'
    ? calcITRAServer(distKm, elevGainM)
    : calcRoadServer(distKm, elevGainM);
}

function normalizeRouteType(type) {
  const t = String(type || '').trim().toLowerCase();
  return t === 'trail' ? 'Trail' : t === 'road' ? 'Road' : String(type || '').trim();
}

function normalizeRouteDistance(route) {
  if (!route) return route;
  route.type = normalizeRouteType(route.type);

  const current = Number(route.distance_km);
  if (Number.isFinite(current) && current > 0) {
    route.distance_km = Math.round(current * 100) / 100;
  } else {
    const fallback = distanceFromPolyline(route.polyline_json);
    if (fallback > 0) route.distance_km = fallback;
  }

  const d = Number(route.distance_km);
  const e = Number(route.elev_gain);
  if (d > 0 && Number.isFinite(d)) {
    const stats = computeRouteStatsServer(route.type, d, Number.isFinite(e) && e >= 0 ? e : 0);
    route.level = stats.level;
    route.itra_display = stats.itra_display;
    route.terrain_label = stats.terrain_label;
    route.difficulty_score = stats.difficulty_score;
    route.elevation_density = stats.elevation_density;
    if (route.type === 'Trail') route.km_effort = stats.km_effort;
  }
  return route;
}

function normalizeRoutes(routes) {
  return (routes || []).map(normalizeRouteDistance);
}

/** Keeps polyline JSON under the Sheets cell size limit. */
function capPolylineJson(raw) {
  const max = CONFIG.MAX_POLYLINE_JSON || 45000;
  let str = raw == null || raw === "" ? "[]" : String(raw);
  if (str.length <= max) {
    try {
      const parsed = JSON.parse(str);
      if (Array.isArray(parsed) || (parsed && Array.isArray(parsed.p))) return str;
    } catch (e) {}
    return "[]";
  }
  try {
    const parsed = JSON.parse(str);
    const pts = Array.isArray(parsed) ? parsed : (parsed && parsed.p) || [];
    const ele = (!Array.isArray(parsed) && parsed && parsed.e) || [];
    const keep = Math.max(2, Math.floor(pts.length * max / str.length));
    const step = Math.max(1, Math.floor(pts.length / keep));
    const p = pts.filter((_, i) => i % step === 0 || i === pts.length - 1);
    const e = ele.length ? ele.filter((_, i) => i % step === 0 || i === ele.length - 1) : [];
    const out = JSON.stringify(e.length ? { p: p, e: e } : p);
    return out.length <= max ? out : JSON.stringify({ p: p.slice(0, 40), e: e.slice(0, 40) });
  } catch (e) {
    return "[]";
  }
}

// ─── COMMENT COUNTS ─────────────────────────────────────────────────────────

async function attachCommentCounts(routes) {
  if (!routes || !routes.length) return routes;
  const comments = await sheetToObjects("Comments");
  const counts = {};
  comments.forEach(c => {
    counts[c.route_id] = (counts[c.route_id] || 0) + 1;
  });
  routes.forEach(r => { r.comments_count = counts[r.route_id] || 0; });
  return routes;
}

// ─── getHomeData ────────────────────────────────────────────────────────────

async function getHomeData() {
  const cached = routeCacheGet("home");
  if (cached) return cached;

  const routes = normalizeRoutes(await sheetToObjects("Routes"));
  try { await attachCommentCounts(routes); } catch (e) {
    console.error("[getHomeData] comment counts unavailable; rendering routes without counts", e);
  }

  const mapArt = routes
    .filter(r => r.is_map_art === "true" || r.is_map_art === true)
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
    .slice(0, 6);

  const popular = [...routes]
    .sort((a, b) => {
      const diff = Number(b.likes_count) - Number(a.likes_count);
      if (diff !== 0) return diff;
      return a.route_id < b.route_id ? -1 : 1;
    })
    .slice(0, 12);

  const stats = {
    total: routes.length,
    totalTrail: routes.filter(r => r.type === "Trail").length,
    totalRoad: routes.filter(r => r.type === "Road").length,
    countries: new Set(routes.map(r => r.country).filter(Boolean)).size
  };

  const result = { mapArt, popular, stats };
  routeCacheSet("home", result);
  return result;
}

// ─── ROUTE GEOMETRY HELPERS ───────────────────────────────────────────────────
function routeSamplePoints(route) {
  try {
    const raw = typeof route?.polyline_json === "string"
      ? JSON.parse(route.polyline_json || "[]")
      : route?.polyline_json;
    if (raw && Array.isArray(raw.profile) && raw.profile.length) {
      return raw.profile.map(p => [Number(p[2]), Number(p[3])])
        .filter(p => Number.isFinite(p[0]) && Number.isFinite(p[1]));
    }
    const pts = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.p) ? raw.p : []);
    return pts.map(p => [Number(p[0]), Number(p[1])])
      .filter(p => Number.isFinite(p[0]) && Number.isFinite(p[1]));
  } catch (e) {
    return [];
  }
}

function routeStartPoint(route) {
  const pts = routeSamplePoints(route);
  return pts.length ? pts[0] : null;
}

function routeDistanceFromPoint(route, lat, lng) {
  const pts = routeSamplePoints(route);
  if (!pts.length) return Infinity;
  let best = Infinity;
  for (const p of pts) {
    const d = haversineKmServer(lat, lng, p[0], p[1]);
    if (Number.isFinite(d) && d < best) best = d;
  }
  return best;
}

function normalizeSearchText(value) {
  return String(value || "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9.]+/g, " ").trim();
}

function parseDistanceQuery(tokens) {
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    let m = t.match(/^(\d+(?:\.\d+)?)(k|km)$/i);
    if (m) out.push(Number(m[1]));
    else if (/^\d+(?:\.\d+)?$/.test(t) && tokens[i + 1] === "km") out.push(Number(t));
  }
  return out.filter(n => Number.isFinite(n) && n > 0 && n <= 5000);
}

function searchRoutesWeighted(routes, query) {
  const normalizedQuery = normalizeSearchText(query);
  const rawTokens = normalizedQuery.split(/\s+/).filter(Boolean);
  const aliases = {
    jogja: "yogyakarta", yogya: "yogyakarta", diy: "yogyakarta",
    jkt: "jakarta", sby: "surabaya", bdg: "bandung", smg: "semarang"
  };
  const tokens = rawTokens.map(t => aliases[t] || t);
  if (!tokens.length) return routes;

  const distanceQueries = parseDistanceQuery(tokens);
  const typeWords = new Set(["trail", "trails", "hiking", "mountain"]);
  const roadWords = new Set(["road", "street", "urban", "jalan"]);

  return routes.map(route => {
    const fields = {
      name: normalizeSearchText(route.route_name),
      regency: normalizeSearchText(route.regency),
      province: normalizeSearchText(route.province),
      country: normalizeSearchText(route.country),
      type: normalizeSearchText(route.type),
      details: normalizeSearchText(route.details),
      itra: normalizeSearchText(route.itra_display)
    };
    const haystack = Object.values(fields).join(" ");
    let score = 0;
    let matched = 0;

    if (normalizedQuery.length >= 3 && fields.name.includes(normalizedQuery)) score += 40;
    if (normalizedQuery.length >= 3 && haystack.includes(normalizedQuery)) score += 12;

    for (const token of tokens) {
      if (/^\\d+(?:\\.\\d+)?$/.test(token) || token === "km" || token === "k") continue;
      let tokenScore = 0;
      if (fields.name.includes(token)) tokenScore += 14;
      if (fields.regency.includes(token)) tokenScore += 10;
      if (fields.province.includes(token)) tokenScore += 9;
      if (fields.country.includes(token)) tokenScore += 7;
      if (fields.type.includes(token)) tokenScore += 8;
      if (fields.itra.includes(token)) tokenScore += 5;
      if (fields.details.includes(token)) tokenScore += 2;
      if (tokenScore > 0) { matched++; score += tokenScore; }
      if (typeWords.has(token) && fields.type === "trail") score += 10;
      if (roadWords.has(token) && fields.type === "road") score += 10;
    }

    if (distanceQueries.length) {
      const d = Number(route.distance_km);
      if (Number.isFinite(d) && d > 0) {
        const best = Math.min(...distanceQueries.map(q => Math.abs(d - q)));
        if (best <= Math.max(1, distanceQueries[0] * 0.1)) score += 15;
        else if (best <= Math.max(2, distanceQueries[0] * 0.25)) score += 5;
      }
    }

    return { route, score, matched };
  })
    .filter(x => x.matched > 0 || x.score >= 12)
    .sort((a, b) => b.score - a.score || b.matched - a.matched ||
      new Date(b.route.timestamp) - new Date(a.route.timestamp))
    .map(x => x.route);
}

// ─── getRouteById ────────────────────────────────────────────────────────────
async function getRouteById(routeId) {
  if (!routeId) throw new Error("routeId is required");
  const routes = normalizeRoutes(await sheetToObjects("Routes"));
  const route = routes.find(r => String(r.route_id) === String(routeId));
  if (!route) throw new Error("Route not found");
  await attachCommentCounts([route]);
  return route;
}

// ─── getNearbyRoutes ─────────────────────────────────────────────────────────
async function getNearbyRoutes(params) {
  params = params || {};
  const lat = Number(params.lat), lng = Number(params.lng);
  const radiusKm = Math.min(100, Math.max(1, Number(params.radiusKm) || 10));
  if (!Number.isFinite(lat) || lat < -90 || lat > 90 ||
      !Number.isFinite(lng) || lng < -180 || lng > 180) {
    throw new Error("A valid location is required");
  }

  let routes = normalizeRoutes(await sheetToObjects("Routes"));
  await attachCommentCounts(routes);
  if (params.type && params.type !== "All") routes = routes.filter(r => r.type === params.type);
  if (params.country && params.country !== "All") routes = routes.filter(r => r.country === params.country);
  if (params.province && params.province !== "All") routes = routes.filter(r => r.province === params.province);
  if (params.regency && params.regency !== "All") routes = routes.filter(r => r.regency === params.regency);
  if (params.distBucket && params.distBucket !== "All") {
    routes = routes.filter(r => {
      const d = Number(r.distance_km);
      switch (params.distBucket) {
        case "<5k": return d < 5;
        case "5-10k": return d >= 5 && d < 10;
        case "10-21k": return d >= 10 && d < 22;
        case "22-50k": return d >= 22 && d < 50;
        case ">50k": return d >= 50;
        default: return true;
      }
    });
  }

  routes = routes.map(route => {
    const d = routeDistanceFromPoint(route, lat, lng);
    if (!Number.isFinite(d)) return null;
    if (!Number.isFinite(d) || d > radiusKm) return null;
    route._distance_from_user_km = Math.round(d * 10) / 10;
    return route;
  }).filter(Boolean);

  if (params.search) routes = searchRoutesWeighted(routes, params.search);
  routes.sort((a, b) => a._distance_from_user_km - b._distance_from_user_km);
  routes = routes.slice(0, 50);

  return { routes, radiusKm, origin: { lat, lng } };
}

// ─── getExploreData ─────────────────────────────────────────────────────────

async function getExploreData(filters) {
  filters = filters || {};
  const cacheKey = "explore:" + JSON.stringify({
    type: filters.type || "All",
    country: filters.country || "All",
    province: filters.province || "All",
    regency: filters.regency || "All",
    distBucket: filters.distBucket || "All",
    search: filters.search || ""
  });
  const cached = routeCacheGet(cacheKey);
  if (cached) return cached;

  const all = normalizeRoutes(await sheetToObjects("Routes"));
  await attachCommentCounts(all);
  let routes = all;

  if (filters.type && filters.type !== "All")
    routes = routes.filter(r => r.type === filters.type);

  if (filters.country && filters.country !== "All")
    routes = routes.filter(r => r.country === filters.country);

  if (filters.province && filters.province !== "All")
    routes = routes.filter(r => r.province === filters.province);

  if (filters.regency && filters.regency !== "All")
    routes = routes.filter(r => r.regency === filters.regency);

  if (filters.distBucket && filters.distBucket !== "All") {
    routes = routes.filter(r => {
      const d = Number(r.distance_km);
      switch (filters.distBucket) {
        case "<5k": return d < 5;
        case "5-10k": return d >= 5 && d < 10;
        case "10-21k": return d >= 10 && d < 22;
        case "22-42k":
        case "22-50k": return d >= 22 && d < 50;
        case ">50k": return d >= 50;
        default: return true;
      }
    });
  }

  let searched = false;
  if (filters.search) {
    searched = true;
    routes = searchRoutesWeighted(routes, filters.search);
  }

  const sortedRoutes = searched
    ? routes
    : routes.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  const unique = arr => [...new Set(arr.filter(Boolean))].sort();

  const result = {
    routes: sortedRoutes,
    filterOptions: {
      countries: unique(all.map(r => r.country)),
      provinces: unique(all.map(r => r.province)),
      regencies: unique(all.map(r => r.regency))
    }
  };
  routeCacheSet(cacheKey, result);
  return result;
}

// ─── getGpxDownload ─────────────────────────────────────────────────────────

async function getGpxDownload(routeId, runnerId) {
  if (!routeId) throw new Error("routeId is required");
  if (!runnerId) throw new Error("runnerId is required");

  // Full gate (share first, then points) — never trust the client here, the
  // download endpoint is the thing people try to call directly.
  const { canDownload } = require("./rewards");
  const gate = await canDownload(runnerId, routeId).catch(() => ({ ok: false, reason: "Route is locked." }));
  if (!gate.ok) throw new Error(gate.reason || "Route is locked.");

  const routes = await sheetToObjects("Routes");
  const route = routes.find(r => String(r.route_id) === String(routeId));
  if (!route) throw new Error("Route not found: " + routeId);
  if (!route.gpx_file_id) throw new Error("This route has no GPX file attached");

  let bytes;
  try {
    bytes = await getFileBuffer(route.gpx_file_id);
  } catch (e) {
    throw new Error("GPX file is no longer available in Drive");
  }

  return {
    filename: sanitize(route.route_name || "route") + ".gpx",
    base64: bytes.toString("base64")
  };
}

// ─── deleteRoute ────────────────────────────────────────────────────────────

// Admin-only (protected by ADMIN_SECRET in api/call.js). NOTE: this used to
// reference an undefined `runnerId`, so every delete threw before doing anything.
async function deleteRoute(routeId) {
  if (!routeId) throw new Error("routeId is required");

  const routes = await sheetToObjects("Routes");
  const route = routes.find(r => r.route_id === routeId);
  if (route && route.gpx_file_id) await trashFile(route.gpx_file_id);

  await deleteRowById("Routes", "route_id", routeId);

  const commentIds = (await sheetToObjects("Comments"))
    .filter(c => c.route_id === routeId)
    .map(c => c.comment_id);
  await deleteRowsByIds("Comments", "comment_id", commentIds);

  const likeIds = (await sheetToObjects("Likes"))
    .filter(l => l.route_id === routeId)
    .map(l => l.like_id);
  await deleteRowsByIds("Likes", "like_id", likeIds);
  invalidateRouteReadCache();

  return { deleted: routeId };
}

module.exports = {
  saveRoute,
  initGpxUpload,
  uploadGpxChunk,
  finalizeGpxUpload,
  getHomeData,
  getExploreData,
  getRouteById,
  getNearbyRoutes,
  getGpxDownload,
  deleteRoute,
  invalidateRouteReadCache
};
