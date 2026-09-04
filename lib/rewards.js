/**
 * rewards.js — Anonymous RunnersHub Points wallet.
 *
 * Points are server-side. The browser only keeps an anonymous runner ID.
 * Daily limits reset at 00:00 UTC.
 */
const crypto = require('crypto');
const { sheetToObjects, appendRow } = require('./sheetHelpers');
const { CONFIG } = require('./config');

const SHARE_POINTS = 15;
const AD_POINTS = 20;
const DOWNLOAD_COST = 15;
const MAX_AD_REWARDS_PER_DAY = 3;
const MAX_SHARE_REWARDS_PER_DAY = 3;
const UPLOAD_POINTS = 30;
const MAX_UPLOAD_REWARDS_PER_DAY = 2;

function uuid() { return crypto.randomUUID(); }
function dayKey() { return new Date().toISOString().slice(0, 10); }
function cleanRunnerId(v) {
  const s = String(v || '').trim();
  if (!/^[A-Za-z0-9_-]{16,80}$/.test(s)) throw new Error('Invalid anonymous runner ID');
  return s;
}
function cleanRouteId(v) {
  const s = String(v || '').trim();
  if (!s || s.length > 120) throw new Error('Invalid route ID');
  return s;
}

async function getWallet(runnerId) {
  const id = cleanRunnerId(runnerId);
  const rows = await sheetToObjects('RewardWallets');
  const found = rows.find(r => String(r.runner_id) === id);
  const today = dayKey();
  if (!found) {
    const now = new Date().toISOString();
    const wallet = {
      runner_id: id, points: 0, ad_rewards_today: 0, share_rewards_today: 0, upload_rewards_today: 0,
      day_key: today, created_at: now, updated_at: now
    };
    await appendRow('RewardWallets', wallet);
    return wallet;
  }
  if (found.day_key !== today) {
    return {
      ...found, ad_rewards_today: 0, share_rewards_today: 0, upload_rewards_today: 0,
      day_key: today
    };
  }
  return found;
}

async function getUnlocks(runnerId) {
  const id = cleanRunnerId(runnerId);
  const rows = await sheetToObjects('RouteUnlocks');
  return rows.filter(r => String(r.runner_id) === id).map(r => String(r.route_id));
}

async function hasUnlock(runnerId, routeId) {
  const id = cleanRunnerId(runnerId);
  const rid = cleanRouteId(routeId);
  const rows = await sheetToObjects('RouteUnlocks');
  return rows.some(r => String(r.runner_id) === id && String(r.route_id) === rid);
}

async function findWalletRow(runnerId) {
  const rows = await sheetToObjects('RewardWallets');
  return rows.find(r => String(r.runner_id) === String(runnerId));
}

// updateCell is intentionally required lazily to keep this module easy to load.
async function updateWallet(runnerId, changes) {
  const { updateCell } = require('./sheetHelpers');
  for (const [key, value] of Object.entries(changes)) {
    await updateCell('RewardWallets', 'runner_id', runnerId, key, value);
  }
}

async function rewardEventExists(runnerId, type, routeId, day) {
  const rows = await sheetToObjects('RewardEvents');
  return rows.some(r => String(r.runner_id) === String(runnerId)
    && String(r.event_type) === String(type)
    && String(r.route_id || '') === String(routeId || '')
    && String(r.day_key) === String(day));
}

function validateShareUrl(platform, urlStr) {
  const meta = {
    x: { domains: ['twitter.com', 'x.com'], re: /\/status\//i },
    facebook: { domains: ['facebook.com', 'm.facebook.com', 'fb.watch'], re: null },
    threads: { domains: ['threads.net', 'threads.com'], re: /\/post\//i },
    instagram: { domains: ['instagram.com'], re: /\/(p|reel|stories)\//i },
    whatsapp: { domains: ['wa.me', 'whatsapp.com'], re: null },
    telegram: { domains: ['t.me', 'telegram.me', 'telegram.org'], re: null },
    linkedin: { domains: ['linkedin.com'], re: /\/(posts|feed\/update)\//i },
    reddit: { domains: ['reddit.com', 'www.reddit.com'], re: /\/(r\/[^/]+\/comments|comments)\//i }
  }[platform];
  if (!meta) throw new Error('Unsupported share platform');
  let u;
  try { u = new URL(String(urlStr || '').trim()); } catch (_) { throw new Error('Invalid share link'); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Invalid share link protocol');
  const host = u.hostname.replace(/^www\./i, '').toLowerCase();
  if (!meta.domains.includes(host)) throw new Error('Share link does not match the selected platform');
  if (meta.re && !meta.re.test(u.pathname)) throw new Error('Share link does not look like a public post link');
  return u.toString();
}

async function claimShareReward(runnerId, routeId, platform, postUrl) {
  if (!CONFIG.REWARDS_ENABLED) throw new Error('Points rewards are currently disabled');
  const id = cleanRunnerId(runnerId);
  const rid = cleanRouteId(routeId);
  const normalizedPlatform = String(platform || '').trim().toLowerCase();
  const normalizedUrl = validateShareUrl(normalizedPlatform, postUrl);
  const today = dayKey();

  const wallet = await getWallet(id);
  const shareCount = Number(wallet.share_rewards_today || 0);
  if (shareCount >= MAX_SHARE_REWARDS_PER_DAY) {
    throw new Error('Daily share reward limit reached (3/day)');
  }

  // One reward per route per day and per runner. The broader route unlock history
  // is separate, so a route can still be shared on a later day if desired.
  if (await rewardEventExists(id, 'share', rid, today)) {
    throw new Error('You already earned a share reward for this route today');
  }

  const now = new Date().toISOString();
  await appendRow('RewardEvents', {
    event_id: uuid(), runner_id: id, event_type: 'share', points: SHARE_POINTS,
    route_id: rid, platform: normalizedPlatform, external_ref: normalizedUrl.slice(0, 500),
    day_key: today, timestamp: now
  });
  const nextPoints = Number(wallet.points || 0) + SHARE_POINTS;
  await updateWallet(id, {
    points: nextPoints, share_rewards_today: shareCount + 1,
    day_key: today, updated_at: now
  });
  return await getWallet(id);
}

async function claimShareUnlock(runnerId, routeId, platform, postUrl) {
  const id = cleanRunnerId(runnerId);
  const rid = cleanRouteId(routeId);
  const normalizedPlatform = String(platform || '').trim().toLowerCase();
  const normalizedUrl = validateShareUrl(normalizedPlatform, postUrl);
  if (await hasUnlock(id, rid)) {
    return { unlocked: true, alreadyUnlocked: true, unlockMethod: 'share' };
  }
  const today = dayKey();
  const events = await sheetToObjects('RewardEvents');
  const shareCount = events.filter(r => String(r.runner_id) === id && String(r.event_type) === 'share_unlock' && String(r.day_key) === today).length;
  if (shareCount >= MAX_SHARE_REWARDS_PER_DAY) {
    throw new Error('Daily share unlock limit reached (3/day)');
  }
  const now = new Date().toISOString();
  await appendRow('RouteUnlocks', {
    unlock_id: uuid(), runner_id: id, route_id: rid,
    unlock_method: 'share', points_spent: 0, timestamp: now
  });
  await appendRow('RewardEvents', {
    event_id: uuid(), runner_id: id, event_type: 'share_unlock', points: 0,
    route_id: rid, platform: normalizedPlatform, external_ref: normalizedUrl.slice(0, 500),
    day_key: today, timestamp: now
  });
  return { unlocked: true, alreadyUnlocked: false, unlockMethod: 'share' };
}

async function claimUploadReward(runnerId, routeId) {
  if (!CONFIG.REWARDS_ENABLED) return { uploadReward: false, disabled: true };
  const id = cleanRunnerId(runnerId);
  const rid = cleanRouteId(routeId);
  const today = dayKey();
  const routes = await sheetToObjects('Routes');
  const route = routes.find(r => String(r.route_id) === rid);
  if (!route) throw new Error('Published route not found for reward');
  if (String(route.uploader_runner_id || '') !== id) {
    throw new Error('This route is not associated with your anonymous runner');
  }

  // A published route can earn its uploader reward only once, even if the
  // browser retries the completion call.
  const events = await sheetToObjects('RewardEvents');
  if (events.some(r => String(r.runner_id) === id && String(r.event_type) === 'upload' && String(r.route_id || '') === rid)) {
    return await getWallet(id);
  }

  const wallet = await getWallet(id);
  const uploadCount = Number(wallet.upload_rewards_today || 0);
  if (uploadCount >= MAX_UPLOAD_REWARDS_PER_DAY) {
    return { ...wallet, uploadReward: false, uploadRewardLimitReached: true };
  }

  const now = new Date().toISOString();
  await appendRow('RewardEvents', {
    event_id: uuid(), runner_id: id, event_type: 'upload', points: UPLOAD_POINTS,
    route_id: rid, platform: '', external_ref: '', day_key: today, timestamp: now
  });
  const nextPoints = Number(wallet.points || 0) + UPLOAD_POINTS;
  await updateWallet(id, {
    points: nextPoints, upload_rewards_today: uploadCount + 1,
    day_key: today, updated_at: now
  });
  return { ...(await getWallet(id)), uploadReward: true, uploadPoints: UPLOAD_POINTS };
}

/**
 * Reserved for a future verified rewarded-ad integration. Do NOT expose a
 * client-side "claim +20" endpoint: AdSense Offerwall's standard rewarded
 * choice grants content access and does not expose a browser callback that
 * RunnersHub can safely treat as proof of completion. The actual +20 reward
 * should be wired when a verified rewarded-ad/Ad Manager custom-choice flow
 * is available.
 */
async function claimAdReward() {
  if (!CONFIG.REWARDS_ENABLED) throw new Error('Points rewards are currently disabled');
  throw new Error('Rewarded ads are not connected to the points wallet yet');
}

async function unlockRoute(runnerId, routeId) {
  if (!CONFIG.REWARDS_ENABLED) {
    if (await hasUnlock(runnerId, routeId)) return { unlocked: true, alreadyUnlocked: true, cost: 0, wallet: await getWallet(runnerId) };
    throw new Error('Points unlock is currently disabled. Share the route to unlock the GPX.');
  }
  const id = cleanRunnerId(runnerId);
  const rid = cleanRouteId(routeId);
  if (await hasUnlock(id, rid)) {
    return { unlocked: true, alreadyUnlocked: true, cost: 0, wallet: await getWallet(id) };
  }
  const wallet = await getWallet(id);
  const points = Number(wallet.points || 0);
  if (points < DOWNLOAD_COST) {
    throw new Error(`You need ${DOWNLOAD_COST} points to unlock this GPX. You have ${points}.`);
  }
  const now = new Date().toISOString();
  await appendRow('RouteUnlocks', {
    unlock_id: uuid(), runner_id: id, route_id: rid,
    unlock_method: 'points', points_spent: DOWNLOAD_COST, timestamp: now
  });
  await updateWallet(id, {
    points: points - DOWNLOAD_COST, updated_at: now, day_key: dayKey()
  });
  await appendRow('RewardEvents', {
    event_id: uuid(), runner_id: id, event_type: 'unlock', points: -DOWNLOAD_COST,
    route_id: rid, platform: '', external_ref: '', day_key: dayKey(), timestamp: now
  });
  return { unlocked: true, alreadyUnlocked: false, cost: DOWNLOAD_COST, wallet: await getWallet(id) };
}

module.exports = {
  SHARE_POINTS, AD_POINTS, DOWNLOAD_COST,
  MAX_AD_REWARDS_PER_DAY, MAX_SHARE_REWARDS_PER_DAY, UPLOAD_POINTS, MAX_UPLOAD_REWARDS_PER_DAY,
  getWallet, getUnlocks, hasUnlock, claimShareReward, claimShareUnlock, claimUploadReward, claimAdReward, unlockRoute
};
