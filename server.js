const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
// ─── Dev-only .env loader (Vercel provides env vars itself) ─────────────────
// Lets you keep STRAVA_CLIENT_ID / SECRET etc. in a local .env instead of
// exporting them in every shell. Existing process env always wins.
(function loadDotEnv() {
  try {
    const envPath = path.join(__dirname, '.env');
    if (!fs.existsSync(envPath)) return;
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/i);
      if (!m || m[1].startsWith('#')) continue;
      if (process.env[m[1]] !== undefined) continue;
      process.env[m[1]] = String(m[2]).replace(/^['"]|['"]$/g, '').trim();
    }
  } catch (_) {}
})();



const MIME_TYPES = {
  '.html': 'text/html; charset=UTF-8',
  '.js': 'application/javascript; charset=UTF-8',
  '.mjs': 'application/javascript; charset=UTF-8',
  '.css': 'text/css; charset=UTF-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=UTF-8'
};

// ─── Local mock of the /api/call dispatcher ──────────────────────────────────
// In production the app is deployed to Vercel, where api/call.js is mounted at
// `/api/call` and talks to Google Sheets/Drive/Strava. The static dev server has
// no backend, so we answer the same JSON contract locally: { ok:true, data } /
// { ok:false, error }. This keeps the UI working in test mode — in particular
// Create 3D → Generate reports the graceful "renderer not configured" message
// instead of failing with "API returned non-JSON (404): 404 Not Found: /api/call".
function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=UTF-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

// ─── Local in-memory backend ─────────────────────────────────────────────────
// Mirrors the cloud API contract so the whole UI works while debugging locally:
// Create 3D, Upload → Publish, browse/explore, likes, comments and GPX download
// all get real answers. Data is intentionally ephemeral — restarting the server
// resets it.
const crypto = require('crypto');
const db = {
  routes: [],
  gpxFiles: new Map(),
  sessions: new Map(),
  likes: new Map(),
  comments: new Map(),
  wallets: new Map(),
  unlocks: new Map(),
  // Mirrors the server-side reward bookkeeping (lib/rewards.js) closely enough
  // for local testing: once-per-route events and verified share unlocks.
  rewardEvents: new Set(),
  shareUnlocks: new Set()
};
function todayKey(){ return new Date().toISOString().slice(0, 10); }
function newWallet(runnerId){
  return { runner_id: String(runnerId), points: 0, ad_rewards_today: 0, share_rewards_today: 0,
           upload_rewards_today: 0, day_key: todayKey(), created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
}
function walletFor(runnerId){
  const key = String(runnerId || 'anonymous');
  if (!db.wallets.has(key)) db.wallets.set(key, newWallet(key));
  return db.wallets.get(key);
}
// Dev mock mirrors the real point values from public/config.js.
function pointsCfg(){ return require('./public/config.js').points || {}; }
function downloadCost(){ return Number(pointsCfg().costs?.download ?? 15); }
function earnPts(kind, fallback){ return Number(pointsCfg().earn?.[kind]?.points ?? fallback); }
// Once-per-route (and no self-reward) bookkeeping, like lib/rewards.js does.
function rewardKey(runnerId, kind, routeId){ return String(runnerId) + ':' + kind + ':' + String(routeId); }
function isOwnRoute(runnerId, routeId){
  return db.routes.some(r => String(r.route_id) === String(routeId) && String(r.uploader_runner_id || '') === String(runnerId));
}
function localUuid(prefix){ return (prefix || 'local') + '_' + crypto.randomBytes(8).toString('hex'); }
function cleanName(s){ return String(s || 'route').replace(/[^a-zA-Z0-9._\- ]+/g, '_').slice(0, 60); }
function decodeB64(b64){
  const str = String(b64 || '');
  const idx = str.indexOf('base64,');
  return Buffer.from(idx >= 0 ? str.slice(idx + 7) : str, 'base64');
}
function routePoints(route){
  try {
    const v = JSON.parse(route.polyline_json || '');
    return v && Array.isArray(v.p) ? v.p : (Array.isArray(v) ? v : []);
  } catch (_) { return []; }
}
function haversineKm(lat1, lng1, lat2, lng2){
  const R = 6371, dLat = (lat2 - lat1) * Math.PI / 180, dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}
function distBucketOk(d, bucket){
  switch (bucket) {
    case '<5k': return d < 5;
    case '5-10k': return d >= 5 && d < 10;
    case '10-21k': return d >= 10 && d < 22;
    case '22-50k': return d >= 22 && d < 50;
    case '>50k': return d >= 50;
    default: return true;
  }
}
function forRead(r){
  const route = Object.assign({}, r);
  route.likes_count = Number(route.likes_count || 0);
  route.comments_count = (db.comments.get(route.route_id) || []).length;
  return route;
}
function buildRoute(meta, routeId, gpxHash){
  const now = new Date().toISOString();
  return {
    route_id: routeId,
    route_name: String(meta.route_name || '').trim().slice(0, 120),
    type: meta.type === 'Road' ? 'Road' : 'Trail',
    is_map_art: meta.is_map_art ? 'true' : 'false',
    distance_km: Math.round(Number(meta.distance_km || 0) * 100) / 100,
    elev_gain: Math.max(0, Math.round(Number(meta.elev_gain || 0))),
    level: String(meta.level || '').slice(0, 40),
    itra_display: String(meta.itra_display || '').slice(0, 60),
    country: String(meta.country || '').trim().slice(0, 80),
    province: String(meta.province || '').trim().slice(0, 80),
    regency: String(meta.regency || '').trim().slice(0, 80),
    likes_count: 0,
    gpx_file_id: routeId,
    polyline_json: meta.polyline_json || '',
    details: String(meta.details || '').trim().slice(0, 2000),
    timestamp: now,
    gpx_hash: gpxHash,
    uploader_runner_id: String(meta.uploader_runner_id || '')
  };
}

async function mockApiResult(action, payload) {
  switch (action) {
    case 'prepare3dFlyover': {
      // Same contract as api/call.js: without a real renderer we never fake a
      // completed MP4 and never charge points.
      if (process.env.THREE_D_RENDERER_URL) {
        return { ready: true, rendererUrl: process.env.THREE_D_RENDERER_URL, unlockMethod: 'points', wallet: { points: 0 } };
      }
      return { ready: false, message: 'Final 1080×1920 MP4 renderer is not configured yet. No points were charged.' };
    }
    // ─── Strava OAuth (real API — free, needs Client ID/Secret in .env) ─────
    case 'stravaStatus': {
      const { getConnection } = require('./lib/strava');
      const c = await getConnection(payload.runnerId);
      if (!c) return { connected: false };
      return { connected: true, connection: { athlete_name: c.athlete_name, athlete_id: c.athlete_id, scope: c.scope, expires_at: c.expires_at } };
    }
    case 'stravaConnect': {
      const { CONFIG } = require('./lib/config');
      const { makeState } = require('./lib/strava');
      if (!CONFIG.STRAVA_CLIENT_ID || !CONFIG.STRAVA_CLIENT_SECRET || !CONFIG.STRAVA_CALLBACK_URL) {
        throw new Error('Strava OAuth is not configured yet. Copy .env.example to .env and fill in STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET, STRAVA_CALLBACK_URL and STRAVA_TOKEN_ENCRYPTION_KEY, then restart the server.');
      }
      const params = new URLSearchParams({
        client_id: CONFIG.STRAVA_CLIENT_ID,
        redirect_uri: CONFIG.STRAVA_CALLBACK_URL,
        response_type: 'code',
        approval_prompt: 'auto',
        scope: 'activity:read',
        state: makeState(payload.runnerId)
      });
      return { authorizeUrl: `https://www.strava.com/oauth/authorize?${params}` };
    }
    case 'stravaDisconnect': {
      const { revokeConnection } = require('./lib/strava');
      await revokeConnection(payload.runnerId);
      return { connected: false };
    }
    case 'initGpxUpload': {
      const meta = payload.meta || {};
      if (!meta.route_name) throw new Error('route_name is required');
      if (!meta.uploader_runner_id) throw new Error('uploader_runner_id is required');
      if (!['Trail', 'Road'].includes(meta.type)) throw new Error("type must be 'Trail' or 'Road'");
      const size = Number(payload.fileSize);
      if (!Number.isInteger(size) || size <= 0) throw new Error('Invalid GPX file size');
      if (size > 10 * 1024 * 1024) throw new Error('GPX file exceeds 10 MB limit');
      const routeId = 'local_' + Date.now().toString(36) + '_' + crypto.randomBytes(6).toString('hex');
      const sessionUrl = 'local-session:' + routeId;
      db.sessions.set(sessionUrl, { routeId, meta, chunks: [], size, done: false });
      return { routeId, sessionUrl, maxBytes: 10 * 1024 * 1024 };
    }
    case 'uploadGpxChunk': {
      const session = payload.sessionUrl ? db.sessions.get(payload.sessionUrl) : null;
      if (!session) throw new Error('Upload session not found or expired');
      const chunk = decodeB64(payload.base64Chunk);
      const start = Number(payload.start) || 0;
      const totalSize = Number(payload.totalSize) || session.size;
      if (chunk && chunk.length) session.chunks.push(chunk);
      const received = Math.min(session.size, start + (chunk ? chunk.length : 0));
      if (received >= session.size || (Number(payload.endExclusive) >= totalSize && totalSize > 0)) {
        session.done = true;
        const bytes = Buffer.concat(session.chunks).subarray(0, session.size);
        db.gpxFiles.set(session.routeId, bytes);
        db.likes.set(session.routeId, new Set());
        db.comments.set(session.routeId, []);
        return { done: true, fileId: session.routeId };
      }
      return { done: false, nextOffset: received };
    }
    case 'finalizeGpxUpload': {
      const meta = payload.meta || {};
      if (!meta.route_name) throw new Error('route_name is required');
      if (!meta.uploader_runner_id) throw new Error('uploader_runner_id is required');
      const routeId = String(payload.gpxFileId || meta.route_id || '');
      const bytes = db.gpxFiles.get(routeId);
      if (!bytes) throw new Error('GPX file is missing for this upload session');
      const expected = Number(payload.fileSize || bytes.length);
      if (expected !== bytes.length) throw new Error('Uploaded GPX size does not match the selected file');
      const gpxHash = crypto.createHash('sha256').update(bytes).digest('hex');
      const dup = db.routes.find(r => r.gpx_hash === gpxHash);
      if (dup) throw new Error(`This GPX has already been uploaded as "${dup.route_name}"`);
      const route = buildRoute(meta, routeId, gpxHash);
      db.routes.unshift(route);
      return { ...forRead(route), reward: { uploadReward: false, rewardsDisabled: true } };
    }
    case 'saveRoute': {
      const meta = payload.meta || {};
      if (!meta.route_name) throw new Error('route_name is required');
      if (!meta.uploader_runner_id) throw new Error('uploader_runner_id is required');
      const bytes = decodeB64(payload.base64Gpx);
      if (!bytes.length) throw new Error('base64Gpx is required');
      const routeId = 'local_' + Date.now().toString(36) + '_' + crypto.randomBytes(6).toString('hex');
      db.gpxFiles.set(routeId, bytes);
      const gpxHash = crypto.createHash('sha256').update(bytes).digest('hex');
      const dup = db.routes.find(r => r.gpx_hash === gpxHash);
      if (dup) throw new Error(`This GPX has already been uploaded as "${dup.route_name}"`);
      const route = buildRoute(meta, routeId, gpxHash);
      db.routes.unshift(route);
      db.likes.set(routeId, new Set());
      db.comments.set(routeId, []);
      return { ...forRead(route), reward: { uploadReward: false, rewardsDisabled: true } };
    }
    case 'getHomeData': {
      const mapArt = db.routes.filter(r => r.is_map_art === 'true').map(forRead);
      const popular = db.routes.filter(r => r.is_map_art !== 'true')
        .sort((a, b) => (Number(b.likes_count) - Number(a.likes_count)) || (new Date(b.timestamp) - new Date(a.timestamp)))
        .map(forRead);
      const countries = new Set(db.routes.map(r => r.country).filter(Boolean));
      return {
        mapArt,
        popular,
        stats: {
          total: db.routes.length,
          totalTrail: db.routes.filter(r => r.type === 'Trail').length,
          totalRoad: db.routes.filter(r => r.type === 'Road').length,
          countries: countries.size
        }
      };
    }
    case 'getExploreData': {
      const f = payload || {};
      let routes = db.routes.map(forRead);
      if (f.type && f.type !== 'All') routes = routes.filter(r => r.type === f.type);
      if (f.country && f.country !== 'All') routes = routes.filter(r => r.country === f.country);
      if (f.province && f.province !== 'All') routes = routes.filter(r => r.province === f.province);
      if (f.regency && f.regency !== 'All') routes = routes.filter(r => r.regency === f.regency);
      if (f.distBucket && f.distBucket !== 'All') routes = routes.filter(r => distBucketOk(Number(r.distance_km), f.distBucket));
      if (f.search) {
        const q = String(f.search).toLowerCase();
        routes = routes.filter(r => (r.route_name || '').toLowerCase().includes(q) || (r.country || '').toLowerCase().includes(q));
      }
      routes.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
      const unique = arr => [...new Set(arr.filter(Boolean))].sort();
      return {
        routes,
        filterOptions: {
          countries: unique(db.routes.map(r => r.country)),
          provinces: unique(db.routes.map(r => r.province)),
          regencies: unique(db.routes.map(r => r.regency))
        }
      };
    }
    case 'getRouteById': {
      const r = db.routes.find(x => String(x.route_id) === String(payload.routeId));
      if (!r) throw new Error('Route not found');
      return forRead(r);
    }
    case 'getNearbyRoutes': {
      const lat = Number(payload.lat), lng = Number(payload.lng);
      const radiusKm = Math.min(100, Math.max(1, Number(payload.radiusKm) || 10));
      if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lng) || lng < -180 || lng > 180) {
        throw new Error('A valid location is required');
      }
      let routes = db.routes.map(forRead);
      if (payload.type && payload.type !== 'All') routes = routes.filter(r => r.type === payload.type);
      routes = routes.map(r => {
        const pts = routePoints(r);
        const d = pts.length ? haversineKm(lat, lng, Number(pts[0][1]), Number(pts[0][0])) : radiusKm;
        return { ...r, _distance_from_user_km: Math.round(d * 10) / 10 };
      }).filter(r => r._distance_from_user_km <= radiusKm);
      routes.sort((a, b) => a._distance_from_user_km - b._distance_from_user_km);
      return { routes: routes.slice(0, 50), radiusKm, origin: { lat, lng } };
    }
    case 'getComments': {
      return db.comments.get(String(payload.routeId || '')) || [];
    }
    case 'getGpxDownload': {
      const routeId = String(payload.routeId || '');
      const runnerId = String(payload.runnerId || '');
      const r = db.routes.find(x => String(x.route_id) === routeId);
      if (!r) throw new Error('Route not found: ' + routeId);
      // Same gate as production: owner always allowed, otherwise a paid unlock
      // must exist (share first, then points).
      const isOwner = String(r.uploader_runner_id || '') === runnerId;
      if (!isOwner && !(db.unlocks.get(runnerId) || new Set()).has(routeId)) {
        throw new Error('Route is locked. Share the route, then spend ' + downloadCost() + ' points to download the GPX.');
      }
      const bytes = db.gpxFiles.get(r.gpx_file_id);
      if (!bytes) throw new Error('This route has no GPX file attached');
      return { filename: cleanName(r.route_name) + '.gpx', base64: bytes.toString('base64') };
    }
    case 'getRewards':
      return walletFor(payload.runnerId);
    case 'getRewardUnlocks': {
      return Array.from(db.unlocks.get(String(payload.runnerId || '')) || []).map(id => ({ route_id: id }));
    }
    case 'toggleLike': {
      const routeId = String(payload.routeId || '');
      const fp = String(payload.userFingerprint || '');
      if (!db.likes.has(routeId)) db.likes.set(routeId, new Set());
      const set = db.likes.get(routeId);
      const liked = !set.has(fp);
      if (liked) set.add(fp); else set.delete(fp);
      const r = db.routes.find(x => String(x.route_id) === routeId);
      if (r) r.likes_count = set.size;
      return { liked, likes_count: set.size };
    }
    case 'addComment': {
      const routeId = String(payload.routeId || '');
      if (!db.comments.has(routeId)) db.comments.set(routeId, []);
      const c = {
        comment_id: localUuid('c3'),
        route_id: routeId,
        user_name: String(payload.userName || 'Runner').slice(0, 60),
        comment_text: String(payload.commentText || '').slice(0, 500),
        timestamp: new Date().toISOString()
      };
      db.comments.get(routeId).push(c);
      return c;
    }
    case 'unlockRoute': {
      const runnerId = String(payload.runnerId || '');
      const routeId = String(payload.routeId || '');
      if (!db.unlocks.has(runnerId)) db.unlocks.set(runnerId, new Set());
      if ((db.unlocks.get(runnerId) || new Set()).has(routeId)) {
        return { wallet: walletFor(runnerId), unlocked: true, alreadyUnlocked: true, cost: 0 };
      }
      // Share is mandatory first, then the GPX costs points.
      if (!db.shareUnlocks.has(rewardKey(runnerId, 'share', routeId))) {
        throw new Error('Share this route first, then spend ' + downloadCost() + ' points to download the GPX.');
      }
      const w = walletFor(runnerId);
      const cost = downloadCost();
      if (Number(w.points || 0) < cost) {
        throw new Error(`You need ${cost} points to unlock this GPX. You have ${Number(w.points || 0)}.`);
      }
      w.points = Number(w.points || 0) - cost;
      db.unlocks.get(runnerId).add(routeId);
      return { wallet: w, unlocked: true, alreadyUnlocked: false, cost };
    }
    case 'claimShareReward': {
      const runnerId = String(payload.runnerId || '');
      const routeId = String(payload.routeId || '');
      db.shareUnlocks.add(rewardKey(runnerId, 'share', routeId));
      const w = walletFor(runnerId);
      const pts = earnPts('share', 15);
      w.points = Number(w.points || 0) + pts;
      return { wallet: w, unlocked: true, unlockMethod: 'share', claimed: true };
    }
    case 'claimUploadReward': {
      const runnerId = String(payload.runnerId || '');
      const routeId = String(payload.routeId || '');
      const key = rewardKey(runnerId, 'upload', routeId);
      if (db.rewardEvents.has(key)) return { ...walletFor(runnerId), uploadReward: false, alreadyRewarded: true };
      db.rewardEvents.add(key);
      const w = walletFor(runnerId);
      const pts = earnPts('upload', 70);
      w.points = Number(w.points || 0) + pts;
      return { ...w, uploadReward: true, uploadPoints: pts };
    }
    case 'addLikeReward':
    case 'addCommentReward': {
      const runnerId = String(payload.runnerId || '');
      const routeId = String(payload.routeId || '');
      const kind = (action === 'addLikeReward') ? 'like' : 'comment';
      const pts = earnPts(kind, kind === 'like' ? 2 : 5);
      if (isOwnRoute(runnerId, routeId)) return { ...walletFor(runnerId), reward: false, selfReward: true };
      const key = rewardKey(runnerId, kind, routeId);
      if (db.rewardEvents.has(key)) return { ...walletFor(runnerId), reward: false, alreadyRewarded: true };
      db.rewardEvents.add(key);
      const w = walletFor(runnerId);
      w.points = Number(w.points || 0) + pts;
      return { ...w, reward: true, points: pts, likeReward: kind === 'like', commentReward: kind === 'comment' };
    }
    case 'claimAdReward':
    case 'claimFlyoverShare':
      return { ...walletFor(payload.runnerId), claimed: true, uploadReward: false, rewardsDisabled: true };
    case 'deleteRoute': {
      const routeId = String(payload.routeId || '');
      db.routes = db.routes.filter(r => String(r.route_id) !== routeId);
      db.gpxFiles.delete(routeId);
      db.likes.delete(routeId);
      db.comments.delete(routeId);
      return { deleted: routeId };
    }
    // ─── Strava ────────────────────────────────────────────────────────────
    // The PUBLIC import path needs no credentials at all (it reads the public
    // activity page), so it works locally. The OAuth path needs a real
    // deployment with STRAVA_CLIENT_ID / SECRET, so it stays disabled here.
    case 'stravaPublicImportActivity': {
      const { getPublicActivity } = require('./lib/stravaPublic');
      if (!payload.url) throw new Error('Paste a public Strava activity link first.');
      return await getPublicActivity(payload.url);
    }
    case 'stravaResolveActivity': {
      const { resolveActivityLink } = require('./lib/stravaPublic');
      if (!payload.url) throw new Error('Paste a public Strava activity link first.');
      return await resolveActivityLink(payload.url);
    }
    // Legitimate per-user import: only the connected athlete's own activities.
    case 'stravaListActivities': {
      const { listActivities } = require('./lib/strava');
      return { activities: await listActivities(payload.runnerId, payload.opts || {}) };
    }
    case 'stravaActivityBundle': {
      const { getActivityBundle } = require('./lib/strava');
      const bundle = await getActivityBundle(payload.runnerId, payload.activityId, payload.activity || null);
      return { gpx: bundle.gpx, stats: bundle.stats };
    }
    case 'stravaImportActivity': {
      // Official API path: works for the connected athlete's own activities
      // (including private ones) — no scraping, so no 403 from Strava.
      const { resolveActivityLink, getActivity } = require('./lib/strava');
      if (!payload.url) throw new Error('Paste a Strava activity link first.');
      const resolved = await resolveActivityLink(payload.url);
      return await getActivity(payload.runnerId, resolved.activityId);
    }
    default: {
      const err = new Error('Unknown action: ' + action);
      err.statusCode = 400;
      throw err;
    }
  }
}

const MAX_API_BODY = 4 * 1024 * 1024; // only tiny JSON metadata goes through /api/call

// Strava redirects the browser back to /api/call?action=stravaCallback&code=…
// after the athlete approves the app. That is a real page navigation, so it must
// answer with HTML (not JSON), exchange the code for tokens, store them, then
// send the user back into the app.
async function handleStravaCallback(res, url) {
  const page = (title, body, ok = true) => {
    res.writeHead(ok ? 200 : 400, { 'Content-Type': 'text/html; charset=UTF-8', 'Cache-Control': 'no-store' });
    res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>` +
      `<meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#071018;color:#e6edf5;` +
      `font:15px/1.6 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;text-align:center;padding:24px}` +
      `.card{max-width:420px;padding:28px;border-radius:16px;background:#0f1b28;border:1px solid rgba(148,163,184,.18)}` +
      `b{display:block;font-size:34px;margin-bottom:10px}a{color:#38bdf8}</style></head>` +
      `<body><div class="card">${body}</div></body></html>`);
  };
  try {
    const { CONFIG } = require('./lib/config');
    const { readState, saveConnection } = require('./lib/strava');
    if (url.searchParams.get('error')) throw new Error('Strava authorization was cancelled or denied.');
    const code = url.searchParams.get('code');
    if (!code) throw new Error('Strava did not return an authorization code.');
    if (!CONFIG.STRAVA_CLIENT_ID || !CONFIG.STRAVA_CLIENT_SECRET) {
      throw new Error('STRAVA_CLIENT_ID / STRAVA_CLIENT_SECRET are missing. Add them to .env and restart the server.');
    }
    const state = readState(url.searchParams.get('state'));
    const body = new URLSearchParams({
      client_id: CONFIG.STRAVA_CLIENT_ID,
      client_secret: CONFIG.STRAVA_CLIENT_SECRET,
      code: String(code),
      grant_type: 'authorization_code'
    });
    const r = await fetch('https://www.strava.com/oauth/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.access_token) throw new Error(data.message || 'Strava token exchange failed.');
    await saveConnection(state.runnerId, data);
    const name = [data.athlete?.firstname, data.athlete?.lastname].filter(Boolean).join(' ') || 'Strava';
    page('Strava connected', `<b>✓</b><p>Connected as <strong>${name}</strong>.<br>Returning to Create 3D…</p>` +
      `<p><a href="/#create3d">Click here if nothing happens</a></p>` +
      `<script>setTimeout(() => { location.replace('/#create3d'); }, 1200);</script>`);
  } catch (e) {
    page('Strava connection failed',
      `<b>✕</b><p>${String(e?.message || 'Could not complete the Strava connection.')}</p>` +
      `<p><a href="/#create3d">Back to Create 3D</a></p>`, false);
  }
}

async function handleApiCall(req, res, url) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end();
    return;
  }

  if (req.method === 'GET' && String(url.searchParams.get('action') || '') === 'stravaCallback') {
    await handleStravaCallback(res, url);
    return;
  }

  const respond = async body => {
    if (!body || typeof body !== 'object' || typeof body.action !== 'string') {
      json(res, 400, { ok: false, error: 'Invalid JSON request body', requestId: null });
      return;
    }
    const payload = body.payload && typeof body.payload === 'object' ? body.payload : {};
    try {
      json(res, 200, { ok: true, data: await mockApiResult(body.action, payload) });
    } catch (e) {
      const status = Number.isInteger(e && e.statusCode) && e.statusCode >= 400 && e.statusCode <= 599 ? e.statusCode : 500;
      json(res, status, { ok: false, error: (e && e.message) || 'Internal server error', requestId: null });
    }
  };

  if (req.method === 'GET') {
    let payload = {};
    try { payload = JSON.parse(url.searchParams.get('payload') || '{}'); } catch (_) {}
    respond({ action: url.searchParams.get('action') || '', payload });
    return;
  }
  if (req.method !== 'POST') {
    json(res, 405, { ok: false, error: 'Method not allowed', requestId: null });
    return;
  }

  const chunks = [];
  let size = 0;
  let finished = false;
  req.on('data', c => {
    if (finished) return;
    size += c.length;
    if (size > MAX_API_BODY) {
      finished = true;
      json(res, 413, { ok: false, error: 'Payload too large', requestId: null });
      return;
    }
    chunks.push(c);
  });
  req.on('end', () => {
    if (finished) return;
    finished = true;
    try {
      const text = Buffer.concat(chunks).toString('utf-8');
      respond(text.trim() ? JSON.parse(text) : {});
    } catch (_) {
      respond(null);
    }
  });
}

const server = http.createServer((req, res) => {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch (_) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('400 Bad Request');
    return;
  }

  if (url.pathname === '/api/call') {
    handleApiCall(req, res, url).catch(() => {});
    return;
  }
  const cleanUrl = url.pathname === '/' || url.pathname === '' ? '/index.html' : url.pathname;

  const safeSuffix = path.normalize(cleanUrl).replace(/^(\.\.[\/\\])+/, '');
  const filePath = path.join(PUBLIC_DIR, safeSuffix);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('403 Forbidden');
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 Not Found: ' + cleanUrl);
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    res.writeHead(200, {
      'Content-Type': contentType,
      'Access-Control-Allow-Origin': '*',
      // Dev server: never hand back a stale asset. The service worker is
      // network-first, but without this header the browser HTTP cache can still
      // reuse an old 3dflyover.css/js, which makes a deployed fix look like it
      // "did not apply" (the classic fix for: why is that dot still there?).
      'Cache-Control': (ext === '.html' || cleanUrl === '/') ? 'no-store' : 'no-cache'
    });
    fs.createReadStream(filePath).pipe(res);
  });
});

server.listen(PORT, () => {
  console.log(`\n======================================================`);
  console.log(`  RunnersHub 3D Flyover Dev Server Berjalan!`);
  console.log(`  URL: http://localhost:${PORT}/#create3d`);
  console.log(`  /api/call: local mock active (test mode).`);
  console.log(`======================================================\n`);
});
