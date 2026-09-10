/**
 * rewards.js — Anonymous RunnersHub Points wallet.
 *
 * Points are server-side. The browser only keeps an anonymous runner ID.
 * Daily limits reset at 00:00 UTC.
 */
const crypto = require('crypto');
const { sheetToObjects, appendRow } = require('./sheetHelpers');
const RELEASE_CONFIG = require('../public/config.js');

const SHARE_POINTS = Number(RELEASE_CONFIG.points?.earn?.share?.points ?? 15);
const LIKE_POINTS = Number(RELEASE_CONFIG.points?.earn?.like?.points ?? 5);
const COMMENT_POINTS = Number(RELEASE_CONFIG.points?.earn?.comment?.points ?? 10);
const AD_POINTS = Number(RELEASE_CONFIG.points?.earn?.rewardedAd?.points ?? 20);
const DOWNLOAD_COST = Number(RELEASE_CONFIG.points?.costs?.download ?? 15);
const MAX_AD_REWARDS_PER_DAY = Number(RELEASE_CONFIG.points?.earn?.rewardedAd?.dailyLimit ?? 3);
const MAX_SHARE_REWARDS_PER_DAY = Number(RELEASE_CONFIG.points?.earn?.share?.dailyLimit ?? 3);
const MAX_LIKE_REWARDS_PER_DAY = Number(RELEASE_CONFIG.points?.earn?.like?.dailyLimit ?? 10);
const MAX_COMMENT_REWARDS_PER_DAY = Number(RELEASE_CONFIG.points?.earn?.comment?.dailyLimit ?? 5);
const UPLOAD_POINTS = Number(RELEASE_CONFIG.points?.earn?.upload?.points ?? 40);
const MAX_UPLOAD_REWARDS_PER_DAY = Number(RELEASE_CONFIG.points?.earn?.upload?.dailyLimit ?? 2);

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
      runner_id: id, points: 0, ad_rewards_today: 0, share_rewards_today: 0, upload_rewards_today: 0, like_rewards_today: 0, comment_rewards_today: 0,
      day_key: today, created_at: now, updated_at: now
    };
    await appendRow('RewardWallets', wallet);
    return wallet;
  }
  if (found.day_key !== today) {
    return {
      ...found, ad_rewards_today: 0, share_rewards_today: 0, upload_rewards_today: 0, like_rewards_today: 0, comment_rewards_today: 0,
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
  const id = cleanRunnerId(runnerId);
  const rid = cleanRouteId(routeId);
  const normalizedPlatform = String(platform || '').trim().toLowerCase();
  const normalizedUrl = validateShareUrl(normalizedPlatform, postUrl);
  const today = dayKey();
  const wallet = await getWallet(id);

  // Initial release: sharing unlocks the GPX directly. No points are awarded.
  // The verification rules stay server-side so the browser cannot self-award an unlock.
  if (RELEASE_CONFIG.download.unlockMode === 'share' && RELEASE_CONFIG.shareUnlock.enabled && !RELEASE_CONFIG.rewards.enabled) {
    if (await hasUnlock(id, rid)) {
      return { ...(await getWallet(id)), unlocked: true, alreadyUnlocked: true, unlockMethod: 'share' };
    }
    const shareCount = Number(wallet.share_rewards_today || 0);
    if (shareCount >= Number(RELEASE_CONFIG.shareUnlock.dailyLimit || 3)) {
      throw new Error(`Daily share unlock limit reached (${RELEASE_CONFIG.shareUnlock.dailyLimit || 3}/day)`);
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
    await updateWallet(id, {
      share_rewards_today: shareCount + 1,
      day_key: today, updated_at: now
    });
    return { ...(await getWallet(id)), unlocked: true, alreadyUnlocked: false, unlockMethod: 'share' };
  }

  // Points mode (kept for later releases).
  const shareCount = Number(wallet.share_rewards_today || 0);
  if (shareCount >= MAX_SHARE_REWARDS_PER_DAY) {
    throw new Error('Daily share reward limit reached (3/day)');
  }
  if (await rewardEventExists(id, 'share', rid, today)) {
    throw new Error('You already earned a share reward for this route today');
  }
  const now = new Date().toISOString();
  if (!(await hasUnlock(id, rid))) {
    await appendRow('RouteUnlocks', { unlock_id: uuid(), runner_id: id, route_id: rid, unlock_method: 'share', points_spent: 0, timestamp: now });
  }
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
  return { ...(await getWallet(id)), unlocked: true, unlockMethod: 'share' };
}
async function claimUploadReward(runnerId, routeId) {
  if (!RELEASE_CONFIG.rewards.enabled || !RELEASE_CONFIG.rewards.upload.enabled) {
    return { ...(await getWallet(runnerId)), uploadReward: false, rewardsDisabled: true };
  }
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
};

// Points for interacting are real money-equivalent value, so every award is
// checked three ways server-side:
//   1. the runner is not the route owner (no self-reward loop),
//   2. the route has never paid this runner for this type of interaction,
//   3. the daily cap for that interaction is not reached.
// The browser can call these endpoints as often as it likes — it still gets paid
// at most once per route, and only up to the daily limit.
async function interactionReward(runnerId, routeId, type, points, dailyMax, counterField) {
  const id = cleanRunnerId(runnerId);
  const rid = cleanRouteId(routeId);
  if (!RELEASE_CONFIG.points?.enabled) {
    return { ...(await getWallet(id)), reward: false, rewardsDisabled: true };
  }
  const cfg = RELEASE_CONFIG.points?.earn?.[type];
  if (cfg && cfg.enabled === false) {
    return { ...(await getWallet(id)), reward: false, disabled: true };
  }

  const routes = await sheetToObjects('Routes');
  const route = routes.find(r => String(r.route_id) === rid);
  if (!route) throw new Error('Route not found for reward');
  if (String(route.uploader_runner_id || '') === id) {
    // Liking/commenting your own route must not mint points.
    return { ...(await getWallet(id)), reward: false, selfReward: true };
  }

  const events = await sheetToObjects('RewardEvents');
  const alreadyPaid = events.some(r => String(r.runner_id) === id
    && String(r.event_type) === type
    && String(r.route_id || '') === rid);
  if (alreadyPaid) {
    return { ...(await getWallet(id)), reward: false, alreadyRewarded: true };
  }

  const wallet = await getWallet(id);
  const today = dayKey();
  const usedToday = Number(wallet[counterField] || 0);
  if (usedToday >= dailyMax) {
    return { ...wallet, reward: false, limitReached: true };
  }

  const now = new Date().toISOString();
  await appendRow('RewardEvents', {
    event_id: uuid(), runner_id: id, event_type: type, points,
    route_id: rid, platform: '', external_ref: '', day_key: today, timestamp: now
  });
  const nextPoints = Number(wallet.points || 0) + points;
  await updateWallet(id, {
    points: nextPoints, [counterField]: usedToday + 1,
    day_key: today, updated_at: now
  });
  return { ...(await getWallet(id)), reward: true, points: points };
}

// Add points for liking a route (+2 by default)
async function addLikeReward(id, route_id) {
  const r = await interactionReward(id, route_id, 'like', LIKE_POINTS, MAX_LIKE_REWARDS_PER_DAY, 'like_rewards_today');
  return { ...r, likeReward: !!r.reward, likePoints: r.points || 0 };
}

// Add points for commenting on a route (+5 by default)
async function addCommentReward(id, route_id) {
  const r = await interactionReward(id, route_id, 'comment', COMMENT_POINTS, MAX_COMMENT_REWARDS_PER_DAY, 'comment_rewards_today');
  return { ...r, commentReward: !!r.reward, commentPoints: r.points || 0 };
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
  throw new Error('Rewarded ads are not connected to the points wallet yet');
}

async function chargeFlyover(runnerId, activityId, cost) {
  const id = cleanRunnerId(runnerId);
  const aid = String(activityId || '').trim();
  if (!/^\d{5,}$/.test(aid)) throw new Error('Invalid activity ID');
  const wallet = await getWallet(id);
  const points = Number(wallet.points || 0);
  const c = Number(cost || 40);
  if (points < c) throw new Error(`You need ${c} points to export this flyover. You have ${points}.`);
  const now = new Date().toISOString();
  await updateWallet(id, { points: points - c, updated_at: now, day_key: dayKey() });
  await appendRow('RewardEvents', { event_id: uuid(), runner_id: id, event_type: 'three_d_flyover', points: -c, route_id: aid, platform: '', external_ref: '', day_key: dayKey(), timestamp: now });
  return await getWallet(id);
}

async function claimFlyoverShare(runnerId, activityId, platform, postUrl) {
  if (!RELEASE_CONFIG.shareUnlock.enabled) throw new Error('Share unlock is disabled.');
  const id = cleanRunnerId(runnerId);
  const aid = String(activityId || '').trim();
  if (!/^\d{5,}$/.test(aid)) throw new Error('Invalid activity ID for share unlock');
  const normalizedPlatform = String(platform || '').trim().toLowerCase();
  const normalizedUrl = validateShareUrl(normalizedPlatform, postUrl);
  const rows = await sheetToObjects('FlyoverShareUnlocks');
  if (rows.some(r => String(r.runner_id) === id && String(r.activity_id) === aid)) return { unlocked: true, alreadyUnlocked: true };
  const now = new Date().toISOString();
  await appendRow('FlyoverShareUnlocks', { unlock_id: uuid(), runner_id: id, activity_id: aid, platform: normalizedPlatform, external_ref: normalizedUrl.slice(0,500), timestamp: now });
  return { unlocked: true, alreadyUnlocked: false };
}

async function hasFlyoverShareUnlock(runnerId, activityId) {
  const rows = await sheetToObjects('FlyoverShareUnlocks');
  return rows.some(r => String(r.runner_id) === String(runnerId) && String(r.activity_id) === String(activityId));
}

// A route counts as "shared" when a verified share reward/unlock was recorded
// for that runner + route (claimShareReward writes one of these rows).
async function hasShareUnlock(runnerId, routeId) {
  const id = cleanRunnerId(runnerId);
  const rid = cleanRouteId(routeId);
  const events = await sheetToObjects('RewardEvents');
  if (events.some(r => String(r.runner_id) === id && String(r.route_id || '') === rid
    && ['share', 'share_unlock'].includes(String(r.event_type)))) return true;
  const unlocks = await sheetToObjects('RouteUnlocks');
  return unlocks.some(r => String(r.runner_id) === id && String(r.route_id) === rid
    && String(r.unlock_method) === 'share');
}

/**
 * Server-side gate for a GPX download. Returns why a download is blocked so the
 * client can show the right message instead of a generic failure.
 */
async function canDownload(runnerId, routeId) {
  const id = cleanRunnerId(runnerId);
  const rid = cleanRouteId(routeId);
  if (RELEASE_CONFIG.download?.unlockMode === 'free') return { ok: true, reason: 'free' };
  const routes = await sheetToObjects('Routes');
  const route = routes.find(r => String(r.route_id) === rid);
  // The uploader always has access to their own file.
  if (route && String(route.uploader_runner_id || '') === id) return { ok: true, reason: 'owner' };
  if (await hasUnlock(id, rid)) return { ok: true, reason: 'unlocked' };
  if (RELEASE_CONFIG.download?.requireShareBeforePoints !== false && !(await hasShareUnlock(id, rid))) {
    return { ok: false, needsShare: true, reason: 'Share this route first, then spend ' + DOWNLOAD_COST + ' points to download the GPX.' };
  }
  const wallet = await getWallet(id);
  if (Number(wallet.points || 0) < DOWNLOAD_COST) {
    return { ok: false, needsPoints: true, cost: DOWNLOAD_COST, points: Number(wallet.points || 0),
      reason: `You need ${DOWNLOAD_COST} points to download this GPX. You have ${Number(wallet.points || 0)}.` };
  }
  return { ok: false, needsPayment: true, cost: DOWNLOAD_COST, reason: 'Unlock required' };
}

async function unlockRoute(runnerId, routeId) {
  const id = cleanRunnerId(runnerId);
  const rid = cleanRouteId(routeId);
  if (await hasUnlock(id, rid)) {
    return { unlocked: true, alreadyUnlocked: true, cost: 0, wallet: await getWallet(id) };
  }
  // Sharing stays mandatory: points are the price, not a way around the gate.
  if (RELEASE_CONFIG.download?.requireShareBeforePoints !== false && !(await hasShareUnlock(id, rid))) {
    throw new Error('Share this route first, then spend ' + DOWNLOAD_COST + ' points to download the GPX.');
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

module.exports = { claimFlyoverShare, hasFlyoverShareUnlock, chargeFlyover,
  SHARE_POINTS, LIKE_POINTS, COMMENT_POINTS, AD_POINTS, DOWNLOAD_COST,
  MAX_AD_REWARDS_PER_DAY, MAX_SHARE_REWARDS_PER_DAY, MAX_LIKE_REWARDS_PER_DAY, MAX_COMMENT_REWARDS_PER_DAY, UPLOAD_POINTS, MAX_UPLOAD_REWARDS_PER_DAY,
  getWallet, getUnlocks, hasUnlock, hasShareUnlock, canDownload, claimShareReward, claimUploadReward, addLikeReward, addCommentReward, claimAdReward, unlockRoute
};
