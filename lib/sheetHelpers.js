/**
 * sheetHelpers.js — Low-level Google Sheets CRUD utilities.
 * Node.js port of the original SheetHelpers.gs, using the Sheets API v4
 * (googleapis) with a Service Account instead of the implicit GAS
 * SpreadsheetApp binding.
 *
 * Behavior mirrors the original 1:1 — same function names/signatures
 * wherever practical — so Routes.gs / Social.gs logic ports over almost
 * unchanged.
 */

const { getSheetsClient } = require("./googleAuth");
const { CONFIG, SCHEMAS } = require("./config");

// Simple in-memory cache of sheetId (numeric) per sheet name, valid for the
// lifetime of a warm serverless function instance. Cheap to rebuild on a
// cold start.
let sheetIdCache = null;

// Phase 4A: short-lived in-process cache for read-heavy Google Sheets data.
// Sheets remains the source of truth; writes invalidate the affected sheet.
const SHEET_CACHE_TTL_MS = 30 * 1000;
const sheetDataCache = new Map();
const schemaCheckedCache = new Set();

function invalidateSheetCache(sheetName) {
  if (sheetName) sheetDataCache.delete(sheetName);
}

function cloneRows(rows) {
  return (rows || []).map(row => ({ ...row }));
}

function columnLetter(index /* 0-based */) {
  let n = index + 1;
  let s = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// ─── SPREADSHEET / SHEET PROVISIONING ──────────────────────────────────────

async function loadSheetIdCache(sheets) {
  const meta = await sheets.spreadsheets.get({
    spreadsheetId: CONFIG.SPREADSHEET_ID
  });
  const cache = {};
  (meta.data.sheets || []).forEach(s => {
    cache[s.properties.title] = s.properties.sheetId;
  });
  return cache;
}

/**
 * Ensures the named sheet exists (creating it with the correct header row
 * if it doesn't) and returns its numeric sheetId.
 */
async function ensureSheet(sheetName) {
  const sheets = await getSheetsClient();
  if (!sheetIdCache) sheetIdCache = await loadSheetIdCache(sheets);

  if (sheetIdCache[sheetName] !== undefined) {
    // Keep existing Sheets compatible when the application schema gains a
    // new optional column. Missing columns are appended to the header only;
    // existing data is left untouched.
    const cols = SCHEMAS[sheetName] || [];
    if (cols.length && !schemaCheckedCache.has(sheetName)) {
      const lastCol = columnLetter(cols.length - 1);
      const headerResp = await sheets.spreadsheets.values.get({
        spreadsheetId: CONFIG.SPREADSHEET_ID,
        range: `${sheetName}!A1:${lastCol}1`
      });
      const header = (headerResp.data.values && headerResp.data.values[0]) || [];
      let changed = false;
      const nextHeader = cols.map((col, i) => {
        if (header[i] !== col) changed = true;
        return header[i] || col;
      });
      // Only write when a required schema header is missing/misaligned.
      if (changed) {
        await sheets.spreadsheets.values.update({
          spreadsheetId: CONFIG.SPREADSHEET_ID,
          range: `${sheetName}!A1:${lastCol}1`,
          valueInputOption: "RAW",
          requestBody: { values: [nextHeader] }
        });
      }
      schemaCheckedCache.add(sheetName);
    }
    return sheetIdCache[sheetName];
  }

  // Sheet doesn't exist yet — create it with header row + basic styling.
  const addResp = await sheets.spreadsheets.batchUpdate({
    spreadsheetId: CONFIG.SPREADSHEET_ID,
    requestBody: {
      requests: [
        { addSheet: { properties: { title: sheetName } } }
      ]
    }
  });
  const newSheetId = addResp.data.replies[0].addSheet.properties.sheetId;
  sheetIdCache[sheetName] = newSheetId;
  schemaCheckedCache.add(sheetName);

  const cols = SCHEMAS[sheetName];
  await sheets.spreadsheets.values.update({
    spreadsheetId: CONFIG.SPREADSHEET_ID,
    range: `${sheetName}!A1:${columnLetter(cols.length - 1)}1`,
    valueInputOption: "RAW",
    requestBody: { values: [cols] }
  });

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: CONFIG.SPREADSHEET_ID,
    requestBody: {
      requests: [
        {
          repeatCell: {
            range: { sheetId: newSheetId, startRowIndex: 0, endRowIndex: 1 },
            cell: {
              userEnteredFormat: {
                backgroundColor: { red: 0.06, green: 0.09, blue: 0.16 },
                textFormat: {
                  foregroundColor: { red: 0.22, green: 0.74, blue: 0.97 },
                  bold: true
                }
              }
            },
            fields: "userEnteredFormat(backgroundColor,textFormat)"
          }
        },
        {
          updateSheetProperties: {
            properties: { sheetId: newSheetId, gridProperties: { frozenRowCount: 1 } },
            fields: "gridProperties.frozenRowCount"
          }
        }
      ]
    }
  });

  return newSheetId;
}

// ─── READ ───────────────────────────────────────────────────────────────────

/**
 * Reads every data row in a sheet and maps it to a plain object.
 * Skips blank rows (rows where column A is empty).
 */
async function sheetToObjects(sheetName) {
  const now = Date.now();
  const cached = sheetDataCache.get(sheetName);
  if (cached && now - cached.createdAt < SHEET_CACHE_TTL_MS) {
    return cloneRows(cached.rows);
  }

  await ensureSheet(sheetName);
  const sheets = await getSheetsClient();
  const cols = SCHEMAS[sheetName];
  const lastCol = columnLetter(cols.length - 1);

  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: CONFIG.SPREADSHEET_ID,
    range: `${sheetName}!A2:${lastCol}`
  });

  const rows = resp.data.values || [];
  const objects = rows
    .filter(r => r[0] !== undefined && r[0] !== "")
    .map(row => {
      const obj = {};
      cols.forEach((c, i) => { obj[c] = row[i] !== undefined ? row[i] : ""; });
      return obj;
    });

  sheetDataCache.set(sheetName, { createdAt: now, rows: cloneRows(objects) });
  return cloneRows(objects);
}

// ─── WRITE ──────────────────────────────────────────────────────────────────

/** Appends a new row. Column order follows SCHEMAS[sheetName]. */
async function appendRow(sheetName, obj) {
  await ensureSheet(sheetName);
  const sheets = await getSheetsClient();
  const cols = SCHEMAS[sheetName];
  const row = cols.map(col => (obj[col] !== undefined && obj[col] !== null) ? obj[col] : "");

  await sheets.spreadsheets.values.append({
    spreadsheetId: CONFIG.SPREADSHEET_ID,
    range: `${sheetName}!A1`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [row] }
  });
  invalidateSheetCache(sheetName);
}

/**
 * Finds the 1-based row number (in the full sheet, i.e. including the
 * header) of the first row whose idCol === idVal. Returns -1 if not found.
 */
async function findRowNumber(sheetName, idCol, idVal) {
  const sheets = await getSheetsClient();
  const cols = SCHEMAS[sheetName];
  const idIdx = cols.indexOf(idCol);
  const idLetter = columnLetter(idIdx);

  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: CONFIG.SPREADSHEET_ID,
    range: `${sheetName}!${idLetter}2:${idLetter}`
  });
  const ids = (resp.data.values || []).map(r => r[0]);
  const ri = ids.findIndex(v => String(v) === String(idVal));
  return ri === -1 ? -1 : ri + 2; // +2: 1-based + header row
}

/**
 * Updates a single cell identified by a row whose idCol === idVal.
 * targetCol is the column name to update; newVal is the new value.
 */
async function updateCell(sheetName, idCol, idVal, targetCol, newVal) {
  await ensureSheet(sheetName);
  const rowNum = await findRowNumber(sheetName, idCol, idVal);
  if (rowNum === -1) return;

  const sheets = await getSheetsClient();
  const cols = SCHEMAS[sheetName];
  const tgtLetter = columnLetter(cols.indexOf(targetCol));

  await sheets.spreadsheets.values.update({
    spreadsheetId: CONFIG.SPREADSHEET_ID,
    range: `${sheetName}!${tgtLetter}${rowNum}`,
    valueInputOption: "RAW",
    requestBody: { values: [[newVal]] }
  });
  invalidateSheetCache(sheetName);
}

/**
 * Deletes the first row where idCol === idVal.
 * Returns true if a row was deleted, false if not found.
 */
async function deleteRowById(sheetName, idCol, idVal) {
  const rowNum = await findRowNumber(sheetName, idCol, idVal);
  if (rowNum === -1) return false;

  const sheetId = await ensureSheet(sheetName);
  const sheets = await getSheetsClient();

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: CONFIG.SPREADSHEET_ID,
    requestBody: {
      requests: [{
        deleteDimension: {
          range: {
            sheetId,
            dimension: "ROWS",
            startIndex: rowNum - 1,
            endIndex: rowNum
          }
        }
      }]
    }
  });
  invalidateSheetCache(sheetName);
  return true;
}

/**
 * Deletes every row whose idCol is in idVals. Collects row numbers first,
 * then removes contiguous blocks from the bottom so indices stay valid.
 */
async function deleteRowsByIds(sheetName, idCol, idVals) {
  if (!idVals || !idVals.length) return 0;
  await ensureSheet(sheetName);

  const sheets = await getSheetsClient();
  const cols = SCHEMAS[sheetName];
  const idIdx = cols.indexOf(idCol);
  const idLetter = columnLetter(idIdx);

  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: CONFIG.SPREADSHEET_ID,
    range: `${sheetName}!${idLetter}2:${idLetter}`
  });
  const ids = resp.data.values || [];

  const want = {};
  idVals.forEach(v => { want[String(v)] = true; });

  const rowNums = [];
  ids.forEach((row, i) => {
    if (want[String(row[0])]) rowNums.push(i + 2); // +2: 1-based + header
  });
  if (!rowNums.length) return 0;

  rowNums.sort((a, b) => b - a);

  const sheetId = sheetIdCache[sheetName];
  const requests = [];
  let i = 0;
  while (i < rowNums.length) {
    const end = rowNums[i];
    let start = end;
    let j = i + 1;
    while (j < rowNums.length && rowNums[j] === start - 1) {
      start = rowNums[j];
      j++;
    }
    requests.push({
      deleteDimension: {
        range: { sheetId, dimension: "ROWS", startIndex: start - 1, endIndex: end }
      }
    });
    i = j;
  }

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: CONFIG.SPREADSHEET_ID,
    requestBody: { requests }
  });
  invalidateSheetCache(sheetName);

  return rowNums.length;
}

module.exports = {
  sheetToObjects,
  appendRow,
  updateCell,
  deleteRowById,
  deleteRowsByIds
};
