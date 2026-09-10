/**
 * api/call.js — Single dispatcher endpoint.
 * Phase 1 stability hardening:
 * - consistent JSON errors
 * - request IDs + server-side error logging
 * - best-effort per-instance rate limiting
 * - basic payload validation before dispatch
 */

const crypto = require("crypto");
const { CONFIG } = require("../lib/config");
const {
  saveRoute,
  getHomeData,
  getExploreData,
  getRouteById,
  getNearbyRoutes,
  getGpxDownload,
  deleteRoute,
  initGpxUpload,
  uploadGpxChunk,
  finalizeGpxUpload
} = require("../lib/routes");
const { toggleLike, addComment, getComments } = require("../lib/social");
const { getWallet, getUnlocks, claimShareReward, claimAdReward, unlockRoute, claimUploadReward, addLikeReward, addCommentReward, claimFlyoverShare, hasFlyoverShareUnlock, chargeFlyover } = require("../lib/rewards");
const { STRAVA_AUTHORIZE, makeState, readState, resolveActivityLink, getConnection, saveConnection, getActivity, getPublicActivity, listActivities, getActivityBundle } = require('../lib/strava');

// Best-effort protection for warm Vercel instances. This is intentionally
// conservative; a durable distributed limiter should be added later if the
// site grows enough to require it.
const rateBuckets = new Map();
const RATE_LIMITS = {
  saveRoute:       { limit: 5,   windowMs: 10 * 60 * 1000 },
  initGpxUpload:   { limit: 10,  windowMs: 10 * 60 * 1000 },
  uploadGpxChunk:  { limit: 120, windowMs: 10 * 60 * 1000 },
  finalizeGpxUpload:{ limit: 5,  windowMs: 10 * 60 * 1000 },
  addComment:     { limit: 20,  windowMs: 10 * 60 * 1000 },
  toggleLike:     { limit: 60,  windowMs: 10 * 60 * 1000 },
  getGpxDownload: { limit: 60,  windowMs: 10 * 60 * 1000 },
  getComments:    { limit: 120, windowMs: 60 * 1000 },
  getHomeData:    { limit: 120, windowMs: 60 * 1000 },
  getExploreData: { limit: 120, windowMs: 60 * 1000 },
  getRouteById:   { limit: 120, windowMs: 60 * 1000 },
  getNearbyRoutes: { limit: 60, windowMs: 60 * 1000 },
  deleteRoute:    { limit: 20,  windowMs: 10 * 60 * 1000 },
  getRewards:    { limit: 120, windowMs: 60 * 1000 },
  getRewardUnlocks:{ limit: 120, windowMs: 60 * 1000 },
  claimShareReward:{ limit: 12, windowMs: 24 * 60 * 60 * 1000 },
  claimAdReward: { limit: 6, windowMs: 24 * 60 * 60 * 1000 },
  claimUploadReward: { limit: 8, windowMs: 24 * 60 * 60 * 1000 },
  addLikeReward: { limit: 240, windowMs: 24 * 60 * 60 * 1000 },
  addCommentReward: { limit: 120, windowMs: 24 * 60 * 60 * 1000 },
  claimFlyoverShare: { limit: 12, windowMs: 24 * 60 * 60 * 1000 },
  chargeFlyover: { limit: 12, windowMs: 24 * 60 * 60 * 1000 },
  unlockRoute:   { limit: 30, windowMs: 10 * 60 * 1000 }
};

function getClientKey(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  const ip = forwarded || String(req.headers["x-real-ip"] || "").trim() || "unknown";
  return ip.slice(0, 120);
}

function checkRateLimit(action, req) {
  const rule = RATE_LIMITS[action];
  if (!rule) return { allowed: true };

  const key = `${action}:${getClientKey(req)}`;
  const now = Date.now();
  let bucket = rateBuckets.get(key);
  if (!bucket || now - bucket.startedAt >= rule.windowMs) {
    bucket = { startedAt: now, count: 0 };
  }
  bucket.count += 1;
  rateBuckets.set(key, bucket);

  // Prevent the map from growing forever on a warm instance.
  if (rateBuckets.size > 2000) {
    for (const [k, v] of rateBuckets) {
      if (now - v.startedAt >= 15 * 60 * 1000) rateBuckets.delete(k);
    }
  }

  if (bucket.count > rule.limit) {
    const retryAfter = Math.max(1, Math.ceil((rule.windowMs - (now - bucket.startedAt)) / 1000));
    return { allowed: false, retryAfter };
  }
  return { allowed: true };
}

module.exports = async function handler(req, res) {
  const requestId = crypto.randomUUID();

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("X-Request-Id", requestId);
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  const cacheableReadActions = new Set(["getHomeData", "getExploreData"]);
  const isCacheableRead = req.method === "GET" && cacheableReadActions.has(String(req.query?.action || ""));

  // Strava OAuth callback is a browser GET and must be handled before the JSON dispatcher.
  if (req.method === 'GET' && String(req.query?.action || '') === 'stravaCallback') {
    try {
      const state = readState(req.query.state);
      if (req.query.error) throw new Error('Strava authorization was cancelled.');
      if (!req.query.code) throw new Error('Strava did not return an authorization code.');
      const cfg = require('../lib/config').CONFIG;
      if (!cfg.STRAVA_CLIENT_ID || !cfg.STRAVA_CLIENT_SECRET || !cfg.STRAVA_CALLBACK_URL) throw new Error('Strava OAuth is not configured on the server.');
      const body = new URLSearchParams({ client_id: cfg.STRAVA_CLIENT_ID, client_secret: cfg.STRAVA_CLIENT_SECRET, code: String(req.query.code), grant_type: 'authorization_code' });
      const tokenResp = await fetch('https://www.strava.com/oauth/token', { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body });
      const token = await tokenResp.json().catch(()=>({}));
      if (!tokenResp.ok) throw new Error(token.message || 'Strava token exchange failed.');
      await saveConnection(state.runnerId, token);
      const target = new URL(cfg.STRAVA_POST_AUTH_URL || 'https://runnershub.vercel.app/#create3d');
      target.searchParams.set('strava', 'connected');
      target.searchParams.set('athlete', String(token.athlete?.firstname || ''));
      res.status(302).setHeader('Location', target.toString());
      res.end();
      return;
    } catch (e) {
      const cfg = require('../lib/config').CONFIG;
      const target = new URL(cfg.STRAVA_POST_AUTH_URL || 'https://runnershub.vercel.app/#create3d');
      target.searchParams.set('strava', 'error');
      target.searchParams.set('message', String(e.message || 'Strava connection failed').slice(0, 180));
      res.status(302).setHeader('Location', target.toString());
      res.end();
      return;
    }
  }

  if (req.method !== "POST" && !isCacheableRead) {
    res.status(405).json({ ok: false, error: "Method not allowed", requestId });
    return;
  }

  let body;
  if (req.method === "GET") {
    let queryPayload = {};
    if (req.query?.payload) {
      try { queryPayload = JSON.parse(String(req.query.payload)); }
      catch (e) {
        res.status(400).json({ ok: false, error: "Invalid payload query", requestId });
        return;
      }
    }
    body = { action: String(req.query.action), payload: queryPayload };
  } else {
    try {
      body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    } catch (e) {
      console.error(`[API ${requestId}] invalid JSON body`, e);
      res.status(400).json({ ok: false, error: "Invalid JSON request body", requestId });
      return;
    }
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    res.status(400).json({ ok: false, error: "Request body must be a JSON object", requestId });
    return;
  }

  const action = body.action;
  const payload = body.payload && typeof body.payload === "object" ? body.payload : {};

  if (!action || typeof action !== "string") {
    res.status(400).json({ ok: false, error: "action is required", requestId });
    return;
  }

  const rate = checkRateLimit(action, req);
  if (!rate.allowed) {
    res.setHeader("Retry-After", String(rate.retryAfter));
    res.status(429).json({
      ok: false,
      error: "Too many requests. Please try again shortly.",
      requestId
    });
    return;
  }

  try {
    let result;

    switch (action) {
      case "saveRoute":
        result = await saveRoute(payload.meta, payload.base64Gpx);
        break;
      case "initGpxUpload":
        result = await initGpxUpload(payload.meta, payload.fileSize);
        break;
      case "uploadGpxChunk":
        result = await uploadGpxChunk(payload.sessionUrl, payload.base64Chunk, payload.start, payload.endExclusive, payload.totalSize);
        break;
      case "finalizeGpxUpload":
        result = await finalizeGpxUpload(payload.meta, payload.gpxFileId, payload.fileSize);
        break;
      case "getHomeData":
        result = await getHomeData();
        break;
      case "getExploreData":
        result = await getExploreData(payload || {});
        break;
      case "getRouteById":
        result = await getRouteById(payload.routeId);
        break;
      case "getNearbyRoutes":
        result = await getNearbyRoutes(payload || {});
        break;
      case "getGpxDownload":
        result = await getGpxDownload(payload.routeId, payload.runnerId);
        break;
      case "deleteRoute":
        if (!CONFIG.ADMIN_SECRET) throw new Error("deleteRoute is disabled");
        if (!payload.adminSecret || payload.adminSecret !== CONFIG.ADMIN_SECRET)
          throw new Error("Unauthorized");
        result = await deleteRoute(payload.routeId);
        break;
      case "toggleLike":
        result = await toggleLike(payload.routeId, payload.userFingerprint);
        break;
      case "addComment":
        result = await addComment(payload.routeId, payload.userName, payload.commentText);
        break;
      case "getComments":
        result = await getComments(payload.routeId);
        break;
      case "chargeFlyover": {
        const runnerId = String(payload.runnerId || "");
        const activityId = String(payload.activityId || "");
        const cost = Number(payload.pointsCost || 40);
        const wallet = await chargeFlyover(runnerId, activityId, cost);
        result = { charged: true, cost, wallet };
        break;
      }
      case "getRewards":
        result = await getWallet(payload.runnerId);
        break;
      case "getRewardUnlocks":
        result = await getUnlocks(payload.runnerId);
        break;
      case "claimShareReward":
        result = await claimShareReward(payload.runnerId, payload.routeId, payload.platform, payload.postUrl);
        break;
      case "claimUploadReward":
        result = await claimUploadReward(payload.runnerId, payload.routeId);
        break;
      case "addLikeReward":
        result = await addLikeReward(payload.runnerId, payload.routeId);
        break;
      case "addCommentReward":
        result = await addCommentReward(payload.runnerId, payload.routeId);
        break;
      case "claimAdReward":
        result = await claimAdReward(payload.runnerId);
        break;
      case "claimFlyoverShare":
        result = await claimFlyoverShare(payload.runnerId, payload.activityId, payload.platform, payload.postUrl);
        break;
      case "unlockRoute":
        result = await unlockRoute(payload.runnerId, payload.routeId);
        break;
      case "stravaConnect": {
        const runnerId = String(payload.runnerId || '');
        if (!/^[A-Za-z0-9_-]{16,80}$/.test(runnerId)) throw new Error('Invalid anonymous runner ID');
        const cfg = require('../lib/config').CONFIG;
        if (!cfg.STRAVA_CLIENT_ID || !cfg.STRAVA_CLIENT_SECRET || !cfg.STRAVA_CALLBACK_URL) throw new Error('Strava integration is not configured yet.');
        const params = new URLSearchParams({ client_id: cfg.STRAVA_CLIENT_ID, redirect_uri: cfg.STRAVA_CALLBACK_URL, response_type: 'code', approval_prompt: 'auto', scope: 'activity:read', state: makeState(runnerId) });
        result = { authorizeUrl: STRAVA_AUTHORIZE + '?' + params.toString() };
        break;
      }
      case "stravaStatus":
        result = { connected: !!(await getConnection(payload.runnerId)), connection: await getConnection(payload.runnerId) };
        if (result.connection) { delete result.connection.access_token; delete result.connection.refresh_token; delete result.connection.access_token_enc; delete result.connection.refresh_token_enc; }
        break;
      case "stravaResolveActivity":
        result = await resolveActivityLink(payload.url);
        break;
      case "stravaImportActivity": {
        const resolved = await resolveActivityLink(payload.url);
        const activity = await getActivity(payload.runnerId, resolved.activityId);
        result = { ...activity, resolvedUrl: resolved.resolvedUrl };
        break;
      }
      case "stravaPublicImportActivity": {
        result = await getPublicActivity(payload.url);
        break;
      }
      // Legitimate per-user import: only the connected athlete's own activities.
      case "stravaListActivities": {
        result = { activities: await listActivities(payload.runnerId, payload.opts || {}) };
        break;
      }
      case "stravaActivityBundle": {
        const bundle = await getActivityBundle(payload.runnerId, payload.activityId, payload.activity || null);
        result = { gpx: bundle.gpx, stats: bundle.stats };
        break;
      }
      case "prepare3dFlyover": {
        if (!CONFIG.THREE_D_RENDERER_URL) {
          result = { ready: false, message: "Final 1080×1920 MP4 renderer is not configured yet. No points were charged." };
          break;
        }
        const runnerId = String(payload.runnerId || '');
        const activityId = String(payload.activityId || '');
        if (!/^[A-Za-z0-9_-]{16,80}$/.test(runnerId)) throw new Error("Invalid anonymous runner ID");
        // Accepts Strava numeric IDs AND GPX imports ("gpx-<timestamp>").
        if (!/^[A-Za-z0-9_-]{3,120}$/.test(String(activityId || ""))) throw new Error("Valid activity ID is required");
        const cost = Number(payload.pointsCost || 40);
        const pointsEnabled = !!require('../public/config.js').points.enabled;
        let wallet = await getWallet(runnerId);
        let unlockMethod = 'share';
        if (pointsEnabled) {
          if (Number(wallet.points || 0) >= cost) {
            wallet = await chargeFlyover(runnerId, activityId, cost);
            unlockMethod = 'points';
          } else if (await hasFlyoverShareUnlock(runnerId, activityId)) {
            unlockMethod = 'share';
          } else {
            throw new Error(`You have ${Number(wallet.points || 0)} points. This export needs ${cost}. Verify a share to use the fallback unlock.`);
          }
        } else if (!(await hasFlyoverShareUnlock(runnerId, activityId))) {
          throw new Error('Points are OFF. Verify a share before generating this flyover.');
        }
        result = { ready: true, rendererUrl: CONFIG.THREE_D_RENDERER_URL, unlockMethod, wallet };
        break;
      }
      default:
        res.status(400).json({ ok: false, error: "Unknown action: " + action, requestId });
        return;
    }

    if (isCacheableRead) {
      res.setHeader("Cache-Control", "public, s-maxage=30, stale-while-revalidate=120");
      res.setHeader("Vercel-CDN-Cache-Control", "public, s-maxage=30, stale-while-revalidate=120");
    }
    res.status(200).json({ ok: true, data: result, requestId });
  } catch (e) {
    // Log the useful server-side details while returning only the safe message
    // to the browser. The request ID lets us correlate the two.
    console.error(`[API ${requestId}] action=${action} failed:`, e && e.stack ? e.stack : e);
    let safeError = 'Internal server error';
    if (e && typeof e.message === 'string' && e.message.trim()) safeError = e.message;
    else if (typeof e === 'string' && e.trim()) safeError = e;
    else if (e && typeof e === 'object') {
      try {
        const serialized = JSON.stringify(e);
        if (serialized && serialized !== '{}') safeError = serialized;
      } catch (_) {}
    }
    const statusCode = Number(e?.statusCode || (action === 'stravaPublicImportActivity' ? 422 : 500));
    res.status(statusCode >= 400 && statusCode <= 599 ? statusCode : 500).json({
      ok: false,
      error: safeError,
      requestId
    });
  }
};
