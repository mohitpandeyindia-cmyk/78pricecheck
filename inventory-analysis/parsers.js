const XLSX = require('xlsx');

function readSheetRaw(filePath, sheetSelector = 1) {
  const wb = XLSX.readFile(filePath, { cellDates: true });
  const sheetNames = wb.SheetNames;

  let sheetName;
  if (typeof sheetSelector === 'number') {
    sheetName = sheetNames[sheetSelector];
  } else {
    sheetName = sheetSelector;
  }

  if (!sheetName) {
    throw new Error(
      `Sheet not found in ${filePath}. Available sheets: ${sheetNames.join(', ')}`
    );
  }

  const sheet = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });
  return rows;
}

function findHeaderRowIndex(rows, keywordSets, maxScan = 15) {
  const limit = Math.min(rows.length, maxScan);
  for (let i = 0; i < limit; i++) {
    const row = rows[i].map((c) => String(c).trim().toLowerCase());
    const matchedGroups = keywordSets.filter((group) =>
      group.some((kw) => row.some((cell) => cell.includes(kw)))
    );
    if (matchedGroups.length === keywordSets.length) {
      return i;
    }
  }
  return -1;
}

function mapColumns(headerRow, columnDefs) {
  const normalized = headerRow.map((c) => String(c).trim().toLowerCase());
  const colMap = {};

  for (const [field, keywords] of Object.entries(columnDefs)) {
    let foundIdx = -1;
    for (const kw of keywords) {
      // 1. Exact match first
      foundIdx = normalized.findIndex((cell) => cell === kw);
      if (foundIdx !== -1) break;

      // 2. Substring / boundary match
      foundIdx = normalized.findIndex((cell) => {
        if (cell.includes(kw)) {
          if (field === 'itemName' && cell.includes('code')) return false;
          if (kw.length <= 3) {
            const regex = new RegExp('\\b' + kw + '\\b', 'i');
            return regex.test(cell);
          }
          return true;
        }
        return false;
      });
      if (foundIdx !== -1) break;
    }
    colMap[field] = foundIdx;
  }
  return colMap;
}

const MONTH_MAP = {
  jan: 0, january: 0,
  feb: 1, february: 1,
  mar: 2, march: 2,
  apr: 3, april: 3,
  may: 4,
  jun: 5, june: 5,
  jul: 6, july: 6,
  aug: 7, august: 7,
  sep: 8, sept: 8, september: 8,
  oct: 9, october: 9,
  nov: 10, november: 10,
  dec: 11, december: 11,
};

/**
 * Vyapar's Stock Detail Report has no per-row date — the whole report is a
 * point-in-time snapshot, dated once in a title cell like:
 *   "Generated on Sept 13,2026 at 03:56 pm"
 * This extracts that single date. Handles "Sept" (non-standard abbreviation
 * that JS's native Date parser doesn't recognize).
 */
function parseGenerationDateFromTitle(titleCellValue) {
  if (!titleCellValue) return null;
  const str = String(titleCellValue);

  const m = str.match(/([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/);
  if (!m) return null;

  const [, monthStr, dayStr, yearStr] = m;
  const monthIdx = MONTH_MAP[monthStr.toLowerCase()];
  if (monthIdx === undefined) return null;

  const dt = new Date(Number(yearStr), monthIdx, Number(dayStr));
  return isNaN(dt) ? null : dt;
}

function parseDateCell(value) {
  if (!value && value !== 0) return null;
  if (value instanceof Date && !isNaN(value)) return value;

  const str = String(value).trim();
  if (!str) return null;

  const dmy = str.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (dmy) {
    let [, d, mo, y] = dmy;
    if (y.length === 2) y = '20' + y;
    const day = Number(d);
    const month = Number(mo);
    if (month > 12) return null;
    const dt = new Date(Number(y), month - 1, day);
    if (!isNaN(dt) && dt.getMonth() === month - 1) return dt;
    return null;
  }

  const native = new Date(str);
  if (!isNaN(native)) return native;

  return null;
}

function parseNumberCell(value) {
  if (value === '' || value === null || value === undefined) return null;
  const cleaned = String(value).replace(/,/g, '').trim();
  const n = parseFloat(cleaned);
  return isNaN(n) ? null : n;
}

/**
 * Vyapar item masters sometimes contain the SAME physical product entered
 * multiple times with a trailing "N" / "NN" / "NNN" token so the POS
 * treats them as distinct SKUs — typically because the item was re-added
 * at a different MRP rather than updating the existing entry. This strips
 * that trailing marker so both entries resolve to one canonical item.
 *
 * Examples this normalizes:
 *   "AB ARHAR DAL 500G N"        -> "AB ARHAR DAL 500G"
 *   "AB GRNDNUT 200G NN"         -> "AB GRNDNUT 200G"
 *   "PTNJLI DK NTRL TP 100G N N" -> "PTNJLI DK NTRL TP 100G"
 * Does NOT touch names where "N" is part of a real token, e.g.
 * "GILL FUSION 2N" (no space before the N — it's part of "2N", not a
 * trailing marker on its own).
 */
function normalizeItemName(rawName) {
  const trimmed = String(rawName).trim();
  const canonical = trimmed.replace(/(?:\s+N+)+$/i, '').trim();
  return canonical || trimmed; // guard: never return an empty string
}

module.exports = {
  readSheetRaw,
  findHeaderRowIndex,
  mapColumns,
  parseDateCell,
  parseGenerationDateFromTitle,
  parseNumberCell,
  normalizeItemName,
};
