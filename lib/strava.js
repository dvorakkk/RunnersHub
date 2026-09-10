const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { CONFIG, SCHEMAS } = require('./config');

// Google Sheets is a production concern only. Require it lazily so the local dev
// server can load this module without googleapis installed.
function sheets() { return require('./sheetHelpers'); }

// Local dev fallback: with no Spreadsheet configured (or STRAVA_DEV_STORE=1)
// OAuth connections are stored in an encrypted-at-rest JSON file instead.
const DEV_STORE = path.join(__dirname, '..', 'data', 'strava-dev-connections.json');
function useDevStore() { return !CONFIG.SPREADSHEET_ID || String(process.env.STRAVA_DEV_STORE || '') === '1'; }
function devRead() { try { return JSON.parse(fs.readFileSync(DEV_STORE, 'utf8')) || {}; } catch (_) { return {}; } }
function devWrite(all) { try { fs.mkdirSync(path.dirname(DEV_STORE), { recursive: true }); fs.writeFileSync(DEV_STORE, JSON.stringify(all, null, 2)); } catch (_) {} }

const STRAVA_AUTHORIZE = 'https://www.strava.com/oauth/authorize';
const STRAVA_TOKEN = 'https://www.strava.com/oauth/token';
const STRAVA_API = process.env.STRAVA_API_BASE_URL || 'https://www.strava.com/api/v3';
const STATE_TTL = 10 * 60 * 1000;

function requireConfig() {
  if (!CONFIG.STRAVA_CLIENT_ID || !CONFIG.STRAVA_CLIENT_SECRET || !CONFIG.STRAVA_CALLBACK_URL) {
    throw new Error('Strava integration is not configured on the server yet.');
  }
}
function hmac(value) { return crypto.createHmac('sha256', CONFIG.STRAVA_STATE_SECRET || CONFIG.STRAVA_CLIENT_SECRET).update(value).digest('base64url'); }
function cryptoKey() { const raw=String(CONFIG.STRAVA_TOKEN_ENCRYPTION_KEY||''); if(!raw) throw new Error('STRAVA_TOKEN_ENCRYPTION_KEY is not configured.'); const b=Buffer.from(raw,'base64'); if(b.length!==32) throw new Error('STRAVA_TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key.'); return b; }
function enc(value) { const iv=crypto.randomBytes(12), cipher=crypto.createCipheriv('aes-256-gcm',cryptoKey(),iv); const out=Buffer.concat([cipher.update(String(value||''),'utf8'),cipher.final()]); return [iv.toString('base64url'),cipher.getAuthTag().toString('base64url'),out.toString('base64url')].join('.'); }
function dec(value) { const [iv,tag,data]=String(value||'').split('.'); if(!iv||!tag||!data) throw new Error('Stored Strava token is invalid.'); const decipher=crypto.createDecipheriv('aes-256-gcm',cryptoKey(),Buffer.from(iv,'base64url')); decipher.setAuthTag(Buffer.from(tag,'base64url')); return Buffer.concat([decipher.update(Buffer.from(data,'base64url')),decipher.final()]).toString('utf8'); }
function makeState(runnerId) {
  const payload = Buffer.from(JSON.stringify({ runnerId: String(runnerId), exp: Date.now() + STATE_TTL })).toString('base64url');
  return payload + '.' + hmac(payload);
}
function readState(state) {
  const [payload, sig] = String(state || '').split('.');
  if (!payload || !sig || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(hmac(payload)))) throw new Error('Invalid Strava OAuth state');
  const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  if (!data.runnerId || Date.now() > Number(data.exp)) throw new Error('Strava OAuth state expired');
  return data;
}
function cleanRunnerId(v) {
  const s = String(v || '').trim();
  if (!/^[A-Za-z0-9_-]{16,80}$/.test(s)) throw new Error('Invalid anonymous runner ID');
  return s;
}

// Credential-free public-activity import lives in ./stravaPublic so the local
// dev server can reuse it without Google Sheets / googleapis / OAuth.
const { extractActivityId, resolveActivityLink, getPublicActivity } = require('./stravaPublic');

async function tokenRequest(params) {
  const body = new URLSearchParams(params);
  const r = await fetch(STRAVA_TOKEN, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.message || data.errors?.[0]?.message || 'Strava token request failed.');
  return data;
}

async function getConnection(runnerId) {
  const id = cleanRunnerId(runnerId);
  if (useDevStore()) {
    const row = devRead()[id] || null;
    if (!row || String(row.revoked || '') === 'true') return null;
    try {
      return { ...row, access_token: dec(row.access_token_enc), refresh_token: dec(row.refresh_token_enc) };
    } catch (_) { return null; }
  }
  const { sheetToObjects } = sheets();
  const rows = await sheetToObjects('StravaConnections');
  const row = rows.find(r => String(r.runner_id) === id && String(r.revoked || '') !== 'true') || null;
  if (row) { row.access_token = dec(row.access_token_enc); row.refresh_token = dec(row.refresh_token_enc); }
  return row;
}

async function saveConnection(runnerId, token) {
  const id = cleanRunnerId(runnerId);
  const existing = await getConnection(id);
  const now = new Date().toISOString();
  const row = {
    connection_id: existing?.connection_id || crypto.randomUUID(), runner_id: id,
    athlete_id: token.athlete?.id || '', athlete_name: [token.athlete?.firstname, token.athlete?.lastname].filter(Boolean).join(' '),
    access_token_enc: enc(token.access_token || ''), refresh_token_enc: enc(token.refresh_token || ''),
    expires_at: token.expires_at || Math.floor(Date.now()/1000) + Number(token.expires_in || 21600),
    scope: token.scope || '', revoked: 'false', created_at: existing?.created_at || now, updated_at: now
  };
  if (useDevStore()) {
    const all = devRead();
    all[id] = row;
    devWrite(all);
    return row;
  }
  const { appendRow, updateCell } = sheets();
  if (!existing) await appendRow('StravaConnections', row);
  else {
    for (const [k,v] of Object.entries(row)) if (k !== 'connection_id' && k !== 'runner_id') await updateCell('StravaConnections', 'runner_id', id, k, v);
  }
  return row;
}

async function revokeConnection(runnerId) {
  const id = cleanRunnerId(runnerId);
  if (useDevStore()) {
    const all = devRead();
    if (all[id]) { all[id].revoked = 'true'; all[id].updated_at = new Date().toISOString(); devWrite(all); }
    return { revoked: true };
  }
  const { updateCell } = sheets();
  await updateCell('StravaConnections', 'runner_id', id, 'revoked', 'true');
  return { revoked: true };
}

async function getValidAccessToken(runnerId) {
  const connection = await getConnection(runnerId);
  if (!connection) throw new Error('Connect Strava first.');
  const expiresAt = Number(connection.expires_at || 0);
  if (expiresAt > Math.floor(Date.now()/1000) + 120 && connection.access_token) return connection.access_token;
  requireConfig();
  const refreshed = await tokenRequest({ client_id: CONFIG.STRAVA_CLIENT_ID, client_secret: CONFIG.STRAVA_CLIENT_SECRET, grant_type: 'refresh_token', refresh_token: connection.refresh_token });
  await saveConnection(runnerId, refreshed);
  return refreshed.access_token;
}

async function stravaApi(path, runnerId) {
  const token = await getValidAccessToken(runnerId);
  const r = await fetch(STRAVA_API + path, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
  const data = await r.json().catch(() => ({}));
  if (r.status === 401) throw new Error('Strava authorization expired or was revoked. Please reconnect Strava.');
  if (!r.ok) throw new Error(data.message || 'Strava API request failed.');
  return data;
}

async function getActivity(runnerId, activityId) {
  const id = cleanRunnerId(runnerId);
  if (!/^\d{5,}$/.test(String(activityId))) throw new Error('Invalid Strava activity ID.');
  const activity = await stravaApi(`/activities/${activityId}`, id);
  const visibility = activity.visibility || activity.private || '';
  const route = activity.map?.summary_polyline || '';
  if (!route) throw new Error('This activity does not expose a route polyline.');
  return {
    id: String(activity.id), name: activity.name || 'Strava Activity',
    sportType: activity.sport_type || activity.type || 'Run',
    distanceKm: Number(activity.distance || 0) / 1000,
    movingTime: Number(activity.moving_time || 0), elapsedTime: Number(activity.elapsed_time || 0),
    elevationGain: Number(activity.total_elevation_gain || 0),
    startDate: activity.start_date || '', startDateLocal: activity.start_date_local || '',
    visibility, summaryPolyline: route, athleteName: activity.athlete?.firstname || '',
    source: 'strava'
  };
}


// ─── Legitimate per-user import ─────────────────────────────────────────────
// Everything below reads ONLY the activities of the athlete who authorised the
// app. Strava never exposes another athlete's heart rate, and a token cannot
// read someone else's activity at all (the API answers 404), so private metrics
// are only ever available from their owner — by design.

// Recent activities of the connected athlete that actually contain a route.
async function listActivities(runnerId, opts = {}) {
  const id = cleanRunnerId(runnerId);
  const perPage = Math.min(50, Math.max(1, Number(opts.perPage || 20)));
  const page = Math.max(1, Number(opts.page || 1));
  const rows = await stravaApi(`/athlete/activities?per_page=${perPage}&page=${page}`, id);
  return (Array.isArray(rows) ? rows : [])
    .filter(a => a && a.map && a.map.summary_polyline)
    .map(a => ({
      id: String(a.id),
      name: a.name || 'Activity',
      sportType: a.sport_type || a.type || 'Run',
      distanceKm: Number(a.distance || 0) / 1000,
      movingTime: Number(a.moving_time || 0),
      elapsedTime: Number(a.elapsed_time || 0),
      elevationGain: Number(a.total_elevation_gain || 0),
      startDateLocal: a.start_date_local || a.start_date || '',
      summaryPolyline: a.map.summary_polyline
    }));
}

// Full-resolution GPS + heart rate + pace streams for one of the athlete's own
// activities. Strava has no "download GPX" endpoint, so we rebuild the GPX from
// these streams — higher resolution than summary_polyline and it keeps HR.
async function getActivityStreams(runnerId, activityId) {
  const id = cleanRunnerId(runnerId);
  if (!/^\d{5,}$/.test(String(activityId))) throw new Error('Invalid Strava activity ID.');
  const keys = 'latlng,altitude,time,heartrate,velocity_smooth,cadence';
  const streams = await stravaApi(
    `/activities/${activityId}/streams?keys=${encodeURIComponent(keys)}&key_by_type=true`, id
  );
  return streams || {};
}

function streamStats(streams, activity) {
  const hr = (streams?.heartrate?.data || []).filter(Number.isFinite);
  const vel = (streams?.velocity_smooth?.data || []).filter(Number.isFinite);
  const dist = Number(activity?.distanceKm || 0), moving = Number(activity?.movingTime || 0);
  return {
    avgHr: hr.length ? Math.round(hr.reduce((a, b) => a + b, 0) / hr.length) : null,
    maxHr: hr.length ? Math.round(Math.max(...hr)) : null,
    avgSpeedKmh: vel.length ? Math.round((vel.reduce((a, b) => a + b, 0) / vel.length) * 3.6 * 10) / 10 : null,
    avgPaceSecPerKm: (moving > 0 && dist > 0) ? Math.round(moving / dist) : null
  };
}

function buildGpx(activity, streams) {
  const latlng = streams?.latlng?.data || [];
  const alt = streams?.altitude?.data || [];
  const time = streams?.time?.data || [];
  const hr = streams?.heartrate?.data || [];
  if (latlng.length < 2) throw new Error('This activity has no GPS stream.');
  const base = Date.parse(activity?.startDateLocal || activity?.startDate || '') || Date.now();
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const out = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="RunnersHub" xmlns="http://www.topografix.com/GPX/1/1" xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1">',
    '<trk>',
    `<name>${esc(activity?.name || 'Strava activity')}</name>`,
    '<trkseg>'
  ];
  for (let i = 0; i < latlng.length; i++) {
    const p = latlng[i];
    const la = Number(p?.[0]), ln = Number(p?.[1]);
    if (!Number.isFinite(la) || !Number.isFinite(ln)) continue;
    let pt = `<trkpt lat="${la}" lon="${ln}">`;
    if (Number.isFinite(alt[i])) pt += `<ele>${alt[i]}</ele>`;
    if (Number.isFinite(time[i])) pt += `<time>${new Date(base + time[i] * 1000).toISOString()}</time>`;
    if (Number.isFinite(hr[i])) pt += `<extensions><gpxtpx:TrackPointExtension><gpxtpx:hr>${Math.round(hr[i])}</gpxtpx:hr></gpxtpx:TrackPointExtension></extensions>`;
    out.push(pt + '</trkpt>');
  }
  out.push('</trkseg>', '</trk>', '</gpx>');
  // Guard against a stream that only contained invalid coordinates.
  if (out.length < 8) throw new Error('This activity has no usable GPS stream.');
  return out.join('\n');
}

// One call the client can use: activity + streams + generated GPX + HR/pace stats.
async function getActivityBundle(runnerId, activityId, activityMeta) {
  const streams = await getActivityStreams(runnerId, activityId);
  const gpx = buildGpx(activityMeta || {}, streams);
  return { gpx, stats: streamStats(streams, activityMeta || {}), streams };
}

module.exports = { STRAVA_AUTHORIZE, makeState, readState, resolveActivityLink, getConnection, saveConnection, revokeConnection, getValidAccessToken, getActivity, getPublicActivity, listActivities, getActivityStreams, getActivityBundle, buildGpx, streamStats };
