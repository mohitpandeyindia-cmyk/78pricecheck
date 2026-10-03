const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { normalizeItemName } = require('./parsers');

let cachedMaster = null;

const DATA_DIR = path.join(__dirname, 'data');
const META_FILE = path.join(DATA_DIR, 'mrp_master_meta.json');

/**
 * Candidate search paths for the master catalog file.
 */
function getCandidateMasterPaths(customPath = null) {
  const paths = [];
  if (customPath) paths.push(customPath);

  // 1. Check metadata file if present
  if (fs.existsSync(META_FILE)) {
    try {
      const meta = JSON.parse(fs.readFileSync(META_FILE, 'utf8'));
      if (meta.savedPath && fs.existsSync(meta.savedPath)) {
        paths.push(meta.savedPath);
      }
    } catch (e) {}
  }

  // 2. Check persistent uploaded current master files
  paths.push(path.join(DATA_DIR, 'mrp_master_current.xlsx'));
  paths.push(path.join(DATA_DIR, 'mrp_master_current.xls'));

  // 3. Current authoritative master files & fallbacks
  paths.push('C:/Users/Admin/Downloads/Export Items (2).xlsx');
  paths.push('C:/price check/Export Items (2).xlsx');
  paths.push(path.join(DATA_DIR, 'Export Items (2).xlsx'));
  paths.push(path.join(__dirname, 'data/Export Items (2).xlsx'));
  paths.push(path.join(__dirname, '../data/Export Items (2).xlsx'));
  return paths;
}

/**
 * Locate the master catalog file from candidate paths.
 */
function locateMasterFile(customPath = null) {
  const candidates = getCandidateMasterPaths(customPath);
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * Extract authoritative fields from a master catalog row, supporting exact column names:
 * - Item name* (authoritative), Item Name
 * - Item code (authoritative), Item Code
 * - Default Mrp (authoritative), Default MRP
 * Strictly ignores Sale price, WHOLESALE PRICE, Purchase price.
 */
function extractMrpMasterRow(row) {
  const rawCode = row['Item code'] !== undefined && row['Item code'] !== '' ? row['Item code']
                : row['Item Code'] !== undefined && row['Item Code'] !== '' ? row['Item Code']
                : row['item code'] !== undefined && row['item code'] !== '' ? row['item code']
                : '';

  const rawName = row['Item name*'] !== undefined && row['Item name*'] !== '' ? row['Item name*']
                : row['Item Name*'] !== undefined && row['Item Name*'] !== '' ? row['Item Name*']
                : row['Item Name'] !== undefined && row['Item Name'] !== '' ? row['Item Name']
                : row['Item name'] !== undefined && row['Item name'] !== '' ? row['Item name']
                : '';

  const rawMrp = row['Default Mrp'] !== undefined && row['Default Mrp'] !== '' ? row['Default Mrp']
               : row['Default MRP'] !== undefined && row['Default MRP'] !== '' ? row['Default MRP']
               : row['default mrp'] !== undefined && row['default mrp'] !== '' ? row['default mrp']
               : null;

  return {
    rawCode: rawCode !== null && rawCode !== undefined ? String(rawCode).trim() : '',
    rawName: rawName !== null && rawName !== undefined ? String(rawName).trim() : '',
    rawMrp
  };
}

/**
 * Load and parse the exported items master file into memory lookup Maps.
 * Only parses once and caches in memory.
 * Authoritative field: Default Mrp (ignores Wholesale, Sale Price, Purchase Price).
 */
function loadMrpMaster(options = {}) {
  const filePath = locateMasterFile(options.customPath);
  if (!filePath) {
    return {
      loaded: false,
      sourceFile: null,
      byCode: new Map(),
      byNormalizedName: new Map(),
      byRawName: new Map(),
      count: 0
    };
  }

  if (cachedMaster && cachedMaster.sourceFile === filePath) {
    return cachedMaster;
  }

  const byCode = new Map();
  const byNormalizedName = new Map();
  const byRawName = new Map();
  const detailsByCode = new Map();
  const detailsByNormalizedName = new Map();
  const detailsByRawName = new Map();

  const wb = XLSX.readFile(filePath);
  const sheetName = wb.SheetNames[0];
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: '' });

  let count = 0;
  for (const row of rows) {
    const { rawCode, rawName, rawMrp } = extractMrpMasterRow(row);
    const mrp = Number(rawMrp);
    if (!isNaN(mrp) && mrp > 0) {
      count++;
      const detailEntry = { mrp, itemCode: rawCode || null, itemName: rawName };
      if (rawCode) {
        byCode.set(rawCode, mrp);
        detailsByCode.set(rawCode, detailEntry);
        const stripped = rawCode.replace(/^0+/, '');
        if (stripped) {
          byCode.set(stripped, mrp);
          detailsByCode.set(stripped, detailEntry);
        }
      }
      if (rawName) {
        const upper = rawName.toUpperCase();
        byRawName.set(upper, mrp);
        detailsByRawName.set(upper, detailEntry);
        const norm = normalizeItemName(rawName);
        if (norm) {
          byNormalizedName.set(norm, mrp);
          detailsByNormalizedName.set(norm, detailEntry);
        }
      }
    }
  }

  cachedMaster = {
    loaded: true,
    sourceFile: filePath,
    byCode,
    byNormalizedName,
    byRawName,
    detailsByCode,
    detailsByNormalizedName,
    detailsByRawName,
    count
  };

  return cachedMaster;
}

/**
 * Resolve Default MRP details using the exact priority hierarchy specified:
 * 1. Item Code / barcode, when available.
 * 2. Existing canonical/resolved item identity.
 * 3. Normalized exact item name.
 * 4. Existing approved aliases/name-resolution mappings.
 * 5. Fallback to existing approved MRP source if present, otherwise null.
 *
 * Returns: { mrp: number|null, source: string, itemCode: string|null, matchedMasterName: string|null }
 */
function getMasterMrpDetail({ itemCode = null, canonicalName = null, itemName = null, aliases = [], fallbackMrp = null } = {}, masterData = null) {
  const master = masterData || loadMrpMaster();
  if (!master || !master.loaded) {
    const fallbackNum = fallbackMrp !== null && fallbackMrp !== undefined && Number(fallbackMrp) > 0 ? Number(fallbackMrp) : null;
    return {
      mrp: fallbackNum,
      source: fallbackNum !== null ? 'Sale Report' : 'Not available',
      itemCode: itemCode || null,
      matchedMasterName: null
    };
  }

  // 1. Item Code / barcode match
  if (itemCode) {
    const codeStr = String(itemCode).trim();
    if (master.detailsByCode && master.detailsByCode.has(codeStr)) {
      const d = master.detailsByCode.get(codeStr);
      return { mrp: d.mrp, source: 'MRP Master', itemCode: d.itemCode || codeStr, matchedMasterName: d.itemName };
    }
    const stripped = codeStr.replace(/^0+/, '');
    if (stripped && master.detailsByCode && master.detailsByCode.has(stripped)) {
      const d = master.detailsByCode.get(stripped);
      return { mrp: d.mrp, source: 'MRP Master', itemCode: d.itemCode || stripped, matchedMasterName: d.itemName };
    }
  }

  // 2. Canonical / resolved item identity
  if (canonicalName) {
    const normCanonical = normalizeItemName(canonicalName);
    if (master.detailsByNormalizedName && master.detailsByNormalizedName.has(normCanonical)) {
      const d = master.detailsByNormalizedName.get(normCanonical);
      return { mrp: d.mrp, source: 'MRP Master', itemCode: d.itemCode, matchedMasterName: d.itemName };
    }
    const upperCanonical = String(canonicalName).trim().toUpperCase();
    if (master.detailsByRawName && master.detailsByRawName.has(upperCanonical)) {
      const d = master.detailsByRawName.get(upperCanonical);
      return { mrp: d.mrp, source: 'MRP Master', itemCode: d.itemCode, matchedMasterName: d.itemName };
    }
  }

  // 3. Normalized exact item name
  if (itemName) {
    const normItem = normalizeItemName(itemName);
    if (master.detailsByNormalizedName && master.detailsByNormalizedName.has(normItem)) {
      const d = master.detailsByNormalizedName.get(normItem);
      return { mrp: d.mrp, source: 'MRP Master', itemCode: d.itemCode, matchedMasterName: d.itemName };
    }
    const upperItem = String(itemName).trim().toUpperCase();
    if (master.detailsByRawName && master.detailsByRawName.has(upperItem)) {
      const d = master.detailsByRawName.get(upperItem);
      return { mrp: d.mrp, source: 'MRP Master', itemCode: d.itemCode, matchedMasterName: d.itemName };
    }
  }

  // 4. Existing approved aliases/mappings
  if (Array.isArray(aliases)) {
    for (const alias of aliases) {
      if (!alias) continue;
      const normAlias = normalizeItemName(alias);
      if (master.detailsByNormalizedName && master.detailsByNormalizedName.has(normAlias)) {
        const d = master.detailsByNormalizedName.get(normAlias);
        return { mrp: d.mrp, source: 'MRP Master', itemCode: d.itemCode, matchedMasterName: d.itemName };
      }
      const upperAlias = String(alias).trim().toUpperCase();
      if (master.detailsByRawName && master.detailsByRawName.has(upperAlias)) {
        const d = master.detailsByRawName.get(upperAlias);
        return { mrp: d.mrp, source: 'MRP Master', itemCode: d.itemCode, matchedMasterName: d.itemName };
      }
    }
  }

  // 5. Fallback only to existing approved MRP source if present
  if (fallbackMrp !== null && fallbackMrp !== undefined && Number(fallbackMrp) > 0) {
    return {
      mrp: Number(fallbackMrp),
      source: 'Sale Report',
      itemCode: itemCode || null,
      matchedMasterName: null
    };
  }

  return {
    mrp: null,
    source: 'Not available',
    itemCode: itemCode || null,
    matchedMasterName: null
  };
}

/**
 * Resolve Default MRP numeric value using the exact priority hierarchy.
 */
function getMasterMrp(params = {}, masterData = null) {
  const detail = getMasterMrpDetail(params, masterData);
  return detail.mrp;
}

/**
 * Handle new uploaded MRP Master file (.xls or .xlsx).
 * Parses Item Code, Item Name, Default MRP, saves file to data directory,
 * updates metadata for persistence, and refreshes in-memory cache.
 */
function saveUploadedMrpMaster({ tempFilePath, originalFilename }) {
  if (!fs.existsSync(tempFilePath)) {
    throw new Error('Uploaded file does not exist on disk.');
  }

  // 1. Validate that the file can be parsed and contains valid Default MRP rows
  const wb = XLSX.readFile(tempFilePath);
  const sheetName = wb.SheetNames[0];
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: '' });

  let validCount = 0;
  for (const row of rows) {
    const { rawMrp } = extractMrpMasterRow(row);
    const mrp = Number(rawMrp);
    if (!isNaN(mrp) && mrp > 0) {
      validCount++;
    }
  }

  if (validCount === 0) {
    throw new Error('No valid products with "Default Mrp" found in uploaded file.');
  }

  // 2. Ensure data directory exists
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  // 3. Determine persistent destination path in data directory
  const ext = path.extname(originalFilename || tempFilePath) || '.xls';
  const destPath = path.join(DATA_DIR, `mrp_master_current${ext}`);

  // Remove alternative extension file if exists
  const altExt = ext.toLowerCase() === '.xlsx' ? '.xls' : '.xlsx';
  const altPath = path.join(DATA_DIR, `mrp_master_current${altExt}`);
  if (fs.existsSync(altPath)) {
    try { fs.unlinkSync(altPath); } catch (e) {}
  }

  fs.copyFileSync(tempFilePath, destPath);

  // 4. Save metadata for persistence
  const meta = {
    originalFilename: originalFilename || path.basename(tempFilePath),
    uploadedAt: new Date().toISOString(),
    productCount: validCount,
    savedPath: destPath
  };
  fs.writeFileSync(META_FILE, JSON.stringify(meta, null, 2), 'utf8');

  // 5. Invalidate cache and reload
  cachedMaster = null;
  const master = loadMrpMaster({ customPath: destPath });

  return {
    success: true,
    loaded: true,
    count: validCount,
    originalFilename: meta.originalFilename,
    uploadedAt: meta.uploadedAt,
    savedPath: destPath
  };
}

/**
 * Retrieve current MRP Master status (loaded, count, filename).
 */
function getMrpMasterStatus() {
  const master = loadMrpMaster();
  if (!master || !master.loaded || master.count === 0) {
    return {
      loaded: false,
      count: 0,
      filename: null,
      uploadedAt: null
    };
  }

  let originalFilename = path.basename(master.sourceFile);
  let uploadedAt = null;

  if (fs.existsSync(META_FILE)) {
    try {
      const meta = JSON.parse(fs.readFileSync(META_FILE, 'utf8'));
      if (meta.originalFilename) originalFilename = meta.originalFilename;
      if (meta.uploadedAt) uploadedAt = meta.uploadedAt;
    } catch (e) {}
  }

  return {
    loaded: true,
    count: master.count,
    filename: originalFilename,
    uploadedAt
  };
}

/**
 * Reset in-memory cache (for testing)
 */
function resetMrpMasterCache() {
  cachedMaster = null;
}

module.exports = {
  loadMrpMaster,
  getMasterMrp,
  getMasterMrpDetail,
  locateMasterFile,
  saveUploadedMrpMaster,
  getMrpMasterStatus,
  resetMrpMasterCache,
};
