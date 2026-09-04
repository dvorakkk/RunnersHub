/**
 * social.js — Likes and Comments API handlers.
 * Node.js port of Social.gs.
 *
 * NOTE on concurrency: the original used LockService.getScriptLock() to
 * serialize toggleLike() calls. Vercel serverless functions are stateless
 * and can run as multiple concurrent instances, so there is no equivalent
 * process-wide lock available. In practice this only matters if the exact
 * same user double-clicks "like" at the exact same millisecond from two
 * different requests — a rare, low-stakes race. If you need strict
 * correctness, consider Sheets' row-level optimistic locking or an
 * external lock (e.g. Vercel KV / Upstash Redis) — not included here to
 * keep the migration minimal.
 */

const crypto = require("crypto");
const { sheetToObjects, appendRow, deleteRowById, updateCell } = require("./sheetHelpers");
const { invalidateRouteReadCache } = require("./routes");

function uuid() {
  return crypto.randomUUID();
}

// ─── toggleLike ─────────────────────────────────────────────────────────────

/**
 * Toggles a like for a route by a specific user fingerprint.
 * If the user has already liked the route, the like is removed (unlike).
 * likes_count is derived from the Likes rows.
 *
 * @param {string} routeId         UUID of the route
 * @param {string} userFingerprint Anonymous browser identifier from localStorage
 * @returns {{ liked: boolean, likes_count: number }}
 */
async function toggleLike(routeId, userFingerprint) {
  if (!routeId || !userFingerprint)
    throw new Error("routeId and userFingerprint are required");

  const routes = await sheetToObjects("Routes");
  const route = routes.find(r => String(r.route_id) === String(routeId));
  if (!route) throw new Error("Route not found: " + routeId);

  const likes = await sheetToObjects("Likes");
  const existing = likes.find(
    l => String(l.route_id) === String(routeId) &&
         String(l.user_fingerprint) === String(userFingerprint)
  );

  let newCount = likes.filter(l => String(l.route_id) === String(routeId)).length;

  if (existing) {
    await deleteRowById("Likes", "like_id", existing.like_id);
    newCount = Math.max(0, newCount - 1);
  } else {
    await appendRow("Likes", {
      like_id: uuid(),
      route_id: routeId,
      user_fingerprint: String(userFingerprint).substring(0, 80),
      timestamp: new Date().toISOString()
    });
    newCount += 1;
  }

  await updateCell("Routes", "route_id", routeId, "likes_count", newCount);
  invalidateRouteReadCache();

  return { liked: !existing, likes_count: newCount };
}

// ─── addComment ─────────────────────────────────────────────────────────────

async function addComment(routeId, userName, commentText) {
  if (!routeId) throw new Error("routeId is required");
  const text = String(commentText || "").trim();
  if (!text) throw new Error("commentText is required");

  const route = (await sheetToObjects("Routes")).find(r => String(r.route_id) === String(routeId));
  if (!route) throw new Error("Route not found: " + routeId);

  const comment = {
    comment_id: uuid(),
    route_id: routeId,
    user_name: String(userName || "Anonymous").trim().substring(0, 60) || "Anonymous",
    comment_text: text.substring(0, 1000),
    timestamp: new Date().toISOString()
  };
  await appendRow("Comments", comment);
  invalidateRouteReadCache();
  return comment;
}

// ─── getComments ────────────────────────────────────────────────────────────

async function getComments(routeId) {
  if (!routeId) throw new Error("routeId is required");
  const comments = await sheetToObjects("Comments");
  return comments
    .filter(c => c.route_id === routeId)
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
    .slice(0, 50);
}

module.exports = { toggleLike, addComment, getComments };
