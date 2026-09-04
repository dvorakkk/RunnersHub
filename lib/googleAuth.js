/**
 * googleAuth.js — Builds authenticated Sheets & Drive API clients.
 *
 * Supports TWO auth modes:
 *
 *   1. OAuth2 (recommended for personal Gmail accounts): authenticates as
 *      YOUR OWN Google account via a refresh token, so Drive uploads use
 *      your personal storage quota. Required if you don't have Google
 *      Workspace / Shared Drives — a plain service account cannot create
 *      files in a personal "My Drive" (it has 0 byte storage quota).
 *
 *   2. Service Account (legacy): works fine for Sheets, and for Drive IF
 *      the destination folder lives inside a Shared Drive (Workspace only).
 *
 * OAuth2 is used automatically if GOOGLE_OAUTH_REFRESH_TOKEN is set;
 * otherwise falls back to the service account. See README.md for setup.
 */

const { google } = require("googleapis");
const { CONFIG } = require("./config");

const SCOPES = [
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/drive"
];

let cachedAuth = null;

function getCredentials() {
  if (!CONFIG.GOOGLE_SERVICE_ACCOUNT_KEY_B64) {
    throw new Error(
      "GOOGLE_SERVICE_ACCOUNT_KEY_B64 is not set. See README.md for setup instructions."
    );
  }
  const jsonStr = Buffer
    .from(CONFIG.GOOGLE_SERVICE_ACCOUNT_KEY_B64, "base64")
    .toString("utf8");
  return JSON.parse(jsonStr);
}

function getAuth() {
  if (cachedAuth) return cachedAuth;

  if (CONFIG.GOOGLE_OAUTH_REFRESH_TOKEN) {
    if (!CONFIG.GOOGLE_OAUTH_CLIENT_ID || !CONFIG.GOOGLE_OAUTH_CLIENT_SECRET) {
      throw new Error(
        "GOOGLE_OAUTH_REFRESH_TOKEN is set but GOOGLE_OAUTH_CLIENT_ID / " +
        "GOOGLE_OAUTH_CLIENT_SECRET are missing. See README.md for setup instructions."
      );
    }
    const oauth2Client = new google.auth.OAuth2(
      CONFIG.GOOGLE_OAUTH_CLIENT_ID,
      CONFIG.GOOGLE_OAUTH_CLIENT_SECRET
    );
    oauth2Client.setCredentials({ refresh_token: CONFIG.GOOGLE_OAUTH_REFRESH_TOKEN });
    cachedAuth = oauth2Client;
    return cachedAuth;
  }

  const credentials = getCredentials();
  cachedAuth = new google.auth.GoogleAuth({
    credentials,
    scopes: SCOPES
  });
  return cachedAuth;
}

async function getSheetsClient() {
  const auth = getAuth();
  return google.sheets({ version: "v4", auth });
}

async function getDriveClient() {
  const auth = getAuth();
  return google.drive({ version: "v3", auth });
}

module.exports = { getAuth, getSheetsClient, getDriveClient };
