/**
 * driveHelpers.js — Google Drive folder provisioning and GPX file storage.
 * Node.js port of DriveHelpers.gs using the Drive API v3 (googleapis).
 *
 * Folder hierarchy (unchanged): Root / Country / {routeId}_{routeName} / routeName.gpx
 *
 * IMPORTANT: because this now runs as a Service Account (not "you" the
 * script owner), the Service Account is the actual owner of any folder it
 * creates. Files it creates live in the Service Account's own Drive quota
 * unless you point ROOT_FOLDER_ID at a folder that lives in a Shared Drive,
 * or a folder that has been explicitly shared with the service account as
 * Editor. See README.md.
 */

const { getDriveClient, getAuth } = require("./googleAuth");
const { CONFIG } = require("./config");

const FOLDER_MIME = "application/vnd.google-apps.folder";

// ─── ROOT FOLDER ────────────────────────────────────────────────────────────

let rootFolderIdCache = null;

/**
 * Returns the root Drive folder ID, creating it if absent.
 * Prefers CONFIG.ROOT_FOLDER_ID if set; otherwise searches by name.
 */
async function getRootFolderId() {
  if (rootFolderIdCache) return rootFolderIdCache;

  const drive = await getDriveClient();

  if (CONFIG.ROOT_FOLDER_ID) {
    rootFolderIdCache = CONFIG.ROOT_FOLDER_ID;
    return rootFolderIdCache;
  }

  const q = `name='${escapeQ(CONFIG.ROOT_FOLDER_NAME)}' and mimeType='${FOLDER_MIME}' and trashed=false`;
  const list = await drive.files.list({
    q,
    fields: "files(id,name)",
    supportsAllDrives: true,
    includeItemsFromAllDrives: true
  });

  if (list.data.files && list.data.files.length) {
    rootFolderIdCache = list.data.files[0].id;
    return rootFolderIdCache;
  }

  const created = await drive.files.create({
    requestBody: { name: CONFIG.ROOT_FOLDER_NAME, mimeType: FOLDER_MIME },
    fields: "id",
    supportsAllDrives: true
  });
  rootFolderIdCache = created.data.id;
  return rootFolderIdCache;
}

// ─── FOLDER UTILITIES ───────────────────────────────────────────────────────

function escapeQ(str) {
  return String(str).replace(/'/g, "\\'");
}

/**
 * Gets or creates a sub-folder by name inside a parent folder.
 * Trims the name; falls back to "Unknown" if blank.
 */
async function getOrCreateSubFolder(parentId, name) {
  const drive = await getDriveClient();
  const safe = (name || "Unknown").trim() || "Unknown";

  const q = `name='${escapeQ(safe)}' and mimeType='${FOLDER_MIME}' and '${parentId}' in parents and trashed=false`;
  const list = await drive.files.list({
    q,
    fields: "files(id,name)",
    supportsAllDrives: true,
    includeItemsFromAllDrives: true
  });
  if (list.data.files && list.data.files.length) return list.data.files[0].id;

  const created = await drive.files.create({
    requestBody: { name: safe, mimeType: FOLDER_MIME, parents: [parentId] },
    fields: "id",
    supportsAllDrives: true
  });
  return created.data.id;
}

/**
 * Strips characters that are illegal in Drive folder/file names.
 * Truncates to 100 characters.
 */
function sanitize(str) {
  return String(str).replace(/[\/\\:*?"<>|]/g, "_").substring(0, 100);
}

// ─── RESUMABLE BROWSER UPLOAD ────────────────────────────────────────────────
async function createGpxResumableSession(routeId, routeName, country, fileSize) {
  const drive = await getDriveClient();
  const rootId = await getRootFolderId();
  const cFolderId = await getOrCreateSubFolder(rootId, country || "Unknown");
  const rFolderId = await getOrCreateSubFolder(cFolderId, sanitize(routeId + "_" + routeName));
  const fname = sanitize(routeName) + ".gpx";
  const auth = getAuth();
  const tokenResult = await auth.getAccessToken();
  const accessToken = typeof tokenResult === "string" ? tokenResult : tokenResult?.token;
  if (!accessToken) throw new Error("Could not obtain Google Drive access token");
  const endpoint = "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true";
  const resp = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Content-Type": "application/json; charset=UTF-8",
      "X-Upload-Content-Type": "application/gpx+xml",
      "X-Upload-Content-Length": String(fileSize)
    },
    body: JSON.stringify({ name: fname, parents: [rFolderId], mimeType: "application/gpx+xml" })
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Google Drive upload session failed (${resp.status})${text ? `: ${text.slice(0, 300)}` : ""}`);
  }
  const sessionUrl = resp.headers.get("location");
  if (!sessionUrl) throw new Error("Google Drive did not return a resumable upload URL");
  return { sessionUrl, fileName: fname, folderId: rFolderId };
}

// ─── GPX FILE STORAGE ───────────────────────────────────────────────────────

/**
 * Saves a GPX string to Drive under:
 *   GPX_Run_Database / country / {routeId}_{routeName} / routeName.gpx
 *
 * @param {string} routeId      UUID of the route
 * @param {string} routeName    Human-readable route name
 * @param {string} country      Used as the top-level sub-folder
 * @param {string} gpxContent   Raw GPX XML string
 * @returns {string}            Drive file ID of the saved .gpx file
 */
async function saveGpxToDrive(routeId, routeName, country, gpxContent) {
  const drive = await getDriveClient();
  const rootId = await getRootFolderId();
  const cFolderId = await getOrCreateSubFolder(rootId, country || "Unknown");
  const rFolderId = await getOrCreateSubFolder(cFolderId, sanitize(routeId + "_" + routeName));
  const fname = sanitize(routeName) + ".gpx";

  const created = await drive.files.create({
    requestBody: { name: fname, parents: [rFolderId] },
    media: { mimeType: "application/gpx+xml", body: gpxContent },
    fields: "id",
    supportsAllDrives: true
  });

  return created.data.id;
}



/**
 * Uploads one chunk to a Google Drive resumable session from the server.
 * This is intentionally server-side: Google Drive's resumable session URL does
 * not reliably expose CORS headers for browser PUT requests.
 */
async function uploadGpxChunkToDrive(sessionUrl, base64Chunk, start, endExclusive, totalSize) {
  if (!sessionUrl || typeof sessionUrl !== "string") throw new Error("Upload session URL is missing");
  if (!base64Chunk || typeof base64Chunk !== "string") throw new Error("Upload chunk is missing");

  const startByte = Number(start);
  const endByteExclusive = Number(endExclusive);
  const total = Number(totalSize);
  if (!Number.isInteger(startByte) || startByte < 0) throw new Error("Invalid chunk start");
  if (!Number.isInteger(endByteExclusive) || endByteExclusive <= startByte) throw new Error("Invalid chunk end");
  if (!Number.isInteger(total) || total <= 0 || endByteExclusive > total) throw new Error("Invalid total file size");

  const bytes = Buffer.from(base64Chunk, "base64");
  const expectedLength = endByteExclusive - startByte;
  if (bytes.length !== expectedLength) throw new Error("Upload chunk size does not match Content-Range");
  if (bytes.length > 2 * 1024 * 1024) throw new Error("Upload chunk exceeds 2 MB server limit");

  const endInclusive = endByteExclusive - 1;
  const resp = await fetch(sessionUrl, {
    method: "PUT",
    headers: {
      "Content-Length": String(bytes.length),
      "Content-Range": `bytes ${startByte}-${endInclusive}/${total}`,
      "Content-Type": "application/gpx+xml"
    },
    body: bytes
  });

  if (resp.status === 200 || resp.status === 201) {
    let data = {};
    try { data = await resp.json(); } catch (_) {}
    if (!data.id) throw new Error("Google Drive completed the upload without returning a file ID");
    return { done: true, fileId: data.id, nextOffset: total };
  }

  if (resp.status === 308) {
    const range = resp.headers.get("range") || resp.headers.get("Range") || "";
    const match = range.match(/bytes=0-(\d+)/i);
    const nextOffset = match ? Number(match[1]) + 1 : endByteExclusive;
    return { done: false, nextOffset };
  }

  const text = await resp.text().catch(() => "");
  throw new Error(`Google Drive chunk upload failed (${resp.status})${text ? `: ${text.slice(0, 300)}` : ""}`);
}

/** Fetches raw file bytes (as a Buffer) for a given Drive file ID. */
async function getFileBuffer(fileId) {
  const drive = await getDriveClient();
  const resp = await drive.files.get(
    { fileId, alt: "media", supportsAllDrives: true },
    { responseType: "arraybuffer" }
  );
  return Buffer.from(resp.data);
}

/** Trashes (soft-deletes) a Drive file. Swallows errors, matching the GAS original. */
async function trashFile(fileId) {
  try {
    const drive = await getDriveClient();
    await drive.files.update({
      fileId,
      requestBody: { trashed: true },
      supportsAllDrives: true
    });
  } catch (e) { /* ignore, matches original try/catch */ }
}

module.exports = { saveGpxToDrive, createGpxResumableSession, uploadGpxChunkToDrive, getFileBuffer, trashFile, sanitize };
