const fs = require('fs');
const path = require('path');

// Default ledger path
const DATA_DIR = path.resolve(__dirname, 'data');
const LEDGER_FILE = path.join(DATA_DIR, 'catalog_ledger.json');

// Standard grocery abbreviation mappings (bidirectional)
const ABBREVIATION_MAP = {
  'BTTR': 'BUTTER',
  'BUTTER': 'BTTR',
  'CHOC': 'CHOCOLATE',
  'CHOCOLATE': 'CHOC',
  'DK': 'DANT KANTI',
  'NTRL': 'NATURAL',
  'NATURAL': 'NTRL',
  'TP': 'TOOTHPASTE',
  'TOOTHPASTE': 'TP',
  'PDR': 'POWDER',
  'POWDER': 'PDR',
  'SFTY': 'SAFETY',
  'SAFETY': 'SFTY',
  'CRCH': 'CRUNCH',
  'CRUNCH': 'CRCH',
  'NDL': 'NOODLES',
  'NODLS': 'NOODLES',
  'NOODLES': 'NDL',
  'BIS': 'BISCUIT',
  'BSCT': 'BISCUIT',
  'BISCUIT': 'BSCT',
  'CK': 'CAKE',
  'CAKE': 'CK',
  'GRLC': 'GARLIC',
  'GARLIC': 'GRLC',
  'PNT': 'PEANUT',
  'PEANUT': 'PNT',
  'GRNDNUT': 'GROUNDNUT',
  'GROUNDNUT': 'GRNDNUT',
  'CRD': 'CURD',
  'CURD': 'CRD',
  'PNR': 'PANEER',
  'PANEER': 'PNR',
};

// Distinct variant / flavour modifiers that must NEVER be merged together
const CONFLICTING_VARIANTS = [
  new Set(['SALTED', 'UNSALTED']),
  new Set(['CLASSIC', 'SPICY', 'MASALA', 'GARLIC', 'ONION']),
  new Set(['PLAIN', 'SUGAR FREE', 'DIET', 'LITE', 'LIGHT']),
  new Set(['CREAM', 'CHOCOLATE', 'VANILLA', 'STRAWBERRY']),
  new Set(['CARDAMOM', 'ELAICHI', 'GINGER', 'ADRAK']),
];

/**
 * Normalizes keys for case-insensitive, space-insensitive comparisons.
 */
function normalizeKey(str) {
  if (!str) return '';
  return String(str).trim().toUpperCase().replace(/\s+/g, ' ');
}

/**
 * Level 1 — Deterministic Normalization (Safe & Automatic)
 * - Strips trailing POS markers: N, NN, NNN, etc. (e.g. "ITEM 500GM N" -> "ITEM 500GM")
 * - Normalizes spacing around standard metrics (e.g. "500GM" -> "500 GM")
 * - Normalizes unit casing
 */
function normalizeDeterministic(rawName) {
  if (!rawName) return '';
  let str = String(rawName).trim();

  // Strip trailing standalone N / NN / NNN markers
  str = str.replace(/(?:\s+N+)+$/i, '').trim();

  // Standardize spacing between number and metric units (e.g. 500G -> 500 GM, 1KG -> 1 KG)
  str = str.replace(/(\d+(?:\.\d+)?)\s*(G|GM|GMS)\b/i, '$1 GM');
  str = str.replace(/(\d+(?:\.\d+)?)\s*(KG|KGS)\b/i, '$1 KG');
  str = str.replace(/(\d+(?:\.\d+)?)\s*(ML|MLS)\b/i, '$1 ML');
  str = str.replace(/(\d+(?:\.\d+)?)\s*(L|LT|LTR|LTRS)\b/i, '$1 LTR');
  str = str.replace(/(\d+(?:\.\d+)?)\s*(PC|PCS)\b/i, '$1 PCS');

  // Collapse consecutive whitespaces
  str = str.replace(/\s+/g, ' ').trim();

  return str || String(rawName).trim();
}

/**
 * Extracts identity components: Brand, Pack Size, Unit, Core Product Tokens, Variant Tokens, Numeric Tokens
 */
function extractProductIdentity(name) {
  const norm = normalizeDeterministic(name).toUpperCase();
  const tokens = norm.split(' ').filter(Boolean);

  let size = null;
  let unit = null;

  // 1. Metric size and unit pattern: number followed by unit (GM, KG, ML, LTR, PCS)
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const m1 = t.match(/^(\d+(?:\.\d+)?)(GM|KG|ML|LTR|PCS)$/);
    if (m1) {
      size = parseFloat(m1[1]);
      unit = m1[2];
      tokens.splice(i, 1);
      break;
    }
    if (i < tokens.length - 1) {
      const numMatch = t.match(/^(\d+(?:\.\d+)?)$/);
      const unitToken = tokens[i + 1];
      if (numMatch && ['GM', 'KG', 'ML', 'LTR', 'PCS'].includes(unitToken)) {
        size = parseFloat(numMatch[1]);
        unit = unitToken;
        tokens.splice(i, 2);
        break;
      }
    }
  }

  // 2. Extract count or standalone numeric tokens (e.g., 20 in "MAG MSLA E MAGIC SCHT 20", 5 in "... 5", "2N", "6PACK")
  let numericToken = null;
  let numericTokenType = null; // 'COUNT_PACK' | 'NUMERIC_TOKEN'

  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i];
    const countMatch = t.match(/^(\d+)(?:N|PK|PACK|S)$/);
    if (countMatch) {
      numericToken = countMatch[1];
      numericTokenType = 'COUNT_PACK';
      tokens.splice(i, 1);
      break;
    }
    const pureNumMatch = t.match(/^(\d+(?:\.\d+)?)$/);
    if (pureNumMatch) {
      numericToken = pureNumMatch[1];
      numericTokenType = 'NUMERIC_TOKEN';
      tokens.splice(i, 1);
      break;
    }
  }

  // Brand is usually the first token
  const brand = tokens.length > 0 ? tokens[0] : '';
  const remainingTokens = tokens.slice(1);

  // Separate known variant/flavour tokens from product tokens
  const variantTokens = [];
  const productTokens = [];

  for (const tok of remainingTokens) {
    let isVariant = false;
    for (const group of CONFLICTING_VARIANTS) {
      if (group.has(tok)) {
        variantTokens.push(tok);
        isVariant = true;
        break;
      }
    }
    if (!isVariant) {
      productTokens.push(tok);
    }
  }

  const sizeWeightFormatted = size !== null ? `${size} ${unit}` : null;

  return {
    rawName: name,
    normalized: norm,
    brand,
    size,
    unit,
    sizeWeightFormatted,
    numericToken,
    numericTokenType,
    productTokens,
    variantTokens,
  };
}

/**
 * Consonantal abbreviation matcher: checks if token A is a consonant-skeleton
 * abbreviation of token B (e.g. BTTR -> B-T-T-R vs BUTTER -> B-U-T-T-E-R).
 */
function isConsonantalAbbr(shortToken, fullToken) {
  if (!shortToken || !fullToken) return false;
  if (shortToken.length < 3 || fullToken.length < 4) return false;
  const consonants = (s) => s.replace(/[AEIOU]/g, '');
  const cShort = consonants(shortToken);
  const cFull = consonants(fullToken);
  return cShort === cFull && cShort.length >= 3;
}

/**
 * Level 2 — Semantic / Candidate Matching
 * Evaluates whether two distinct items share the same physical product identity.
 * Strictly enforces:
 * - Same Brand
 * - Same Metric Pack Size and Unit (NEVER match 500 GM with 100 GM)
 * - Numeric Token Safety:
 *   - Conflicting numeric tokens (e.g. 20 vs 5) -> NEVER match
 *   - Asymmetric numeric tokens (e.g. none vs 20) -> Flagged as ⚠ HUMAN REVIEW REQUIRED, never auto-merged
 * - Same Product Identity (direct, dictionary, or consonantal abbreviation)
 * - Non-conflicting Variant/Flavour tokens
 */
function evaluateCandidateMatch(rawNameA, rawNameB, precomputedIdA = null, precomputedIdB = null) {
  const idA = precomputedIdA || extractProductIdentity(rawNameA);
  const idB = precomputedIdB || extractProductIdentity(rawNameB);

  // Exact normalized match -> Level 1 already handled or trivial match
  if (idA.normalized === idB.normalized) {
    return { isMatch: true, confidence: 1.0, reason: 'Identical normalized product name', hasWarning: false };
  }

  // Guard 1: Brand must match
  if (idA.brand !== idB.brand || !idA.brand) {
    return { isMatch: false, reason: `Different brands: "${idA.brand}" vs "${idB.brand}"` };
  }

  // Guard 2: Metric pack size and unit MUST match if present in both
  if (idA.size !== null && idB.size !== null) {
    if (idA.size !== idB.size || idA.unit !== idB.unit) {
      return { isMatch: false, reason: `Different pack sizes/units: ${idA.sizeWeightFormatted} vs ${idB.sizeWeightFormatted}` };
    }
  } else if ((idA.size !== null) !== (idB.size !== null)) {
    // One has a metric size, other does not
    return { isMatch: false, reason: `One item specifies metric pack size (${idA.sizeWeightFormatted || idB.sizeWeightFormatted}), other does not` };
  }

  // Guard 3: Standalone numeric tokens (count / sachet / price-point / size)
  let numericWarning = false;
  let numericLabel = '—';
  if (idA.numericToken !== null && idB.numericToken !== null) {
    if (idA.numericToken !== idB.numericToken) {
      return {
        isMatch: false,
        reason: `Conflicting numeric pack/count tokens: "${idA.numericToken}" vs "${idB.numericToken}"`
      };
    }
    numericLabel = idA.numericToken;
  } else if (idA.numericToken !== null || idB.numericToken !== null) {
    // One item has a numeric token and the other does not (e.g. none vs 20)
    // NEVER AUTO-MERGE: This must enter review with an explicit warning!
    numericWarning = true;
    const valA = idA.numericToken || 'none';
    const valB = idB.numericToken || 'none';
    numericLabel = `${valA} vs ${valB}`;
  }

  // Guard 4: Variant/Flavour conflict
  for (const group of CONFLICTING_VARIANTS) {
    const hasA = idA.variantTokens.find((t) => group.has(t));
    const hasB = idB.variantTokens.find((t) => group.has(t));
    if (hasA && hasB && hasA !== hasB) {
      return { isMatch: false, reason: `Conflicting variant attributes: "${hasA}" vs "${hasB}"` };
    }
  }

  // Evaluate Product Tokens
  const tokensA = idA.productTokens;
  const tokensB = idB.productTokens;

  if (tokensA.length === 0 || tokensB.length === 0) {
    return { isMatch: false, reason: 'Insufficient product tokens to evaluate' };
  }

  let matchedTokensCount = 0;
  let abbreviationFound = null;

  for (const tA of tokensA) {
    for (const tB of tokensB) {
      if (tA === tB) {
        matchedTokensCount++;
        break;
      }
      if (ABBREVIATION_MAP[tA] === tB || ABBREVIATION_MAP[tB] === tA) {
        matchedTokensCount++;
        abbreviationFound = `${tA} ↔ ${tB}`;
        break;
      }
      if (isConsonantalAbbr(tA, tB) || isConsonantalAbbr(tB, tA)) {
        matchedTokensCount++;
        abbreviationFound = `${tA} ↔ ${tB} (consonantal abbreviation)`;
        break;
      }
    }
  }

  const maxTokens = Math.max(tokensA.length, tokensB.length);
  const matchRatio = matchedTokensCount / maxTokens;

  if (matchRatio >= 0.8 || (tokensA.length === 1 && tokensB.length === 1 && matchedTokensCount === 1)) {
    let reason = '';
    if (numericWarning) {
      reason = `Product name is highly similar, but numeric pack/count token differs (${numericLabel}).`;
    } else if (abbreviationFound) {
      reason = `Brand (${idA.brand}) and pack size (${idA.sizeWeightFormatted || 'none'}) agree with abbreviation: ${abbreviationFound}`;
    } else {
      reason = `Brand (${idA.brand}) and pack size (${idA.sizeWeightFormatted || 'none'}) agree with high token correspondence`;
    }

    return {
      isMatch: true,
      confidence: numericWarning ? 0.65 : 0.85,
      hasWarning: numericWarning,
      reason,
      packCountCheck: {
        match: !numericWarning,
        warning: numericWarning,
        label: numericWarning ? numericLabel : (idA.sizeWeightFormatted || idA.numericToken || '—'),
        valA: idA.sizeWeightFormatted || idA.numericToken || 'none',
        valB: idB.sizeWeightFormatted || idB.numericToken || 'none',
      }
    };
  }

  return { isMatch: false, reason: 'Product tokens do not match' };
}

/**
 * Persistent Catalog Mapping Ledger
 * Stores:
 * - MERGE: rawName -> canonicalName
 * - KEEP_SEPARATE: pair of item keys that should never be suggested again
 */
class CatalogLedger {
  constructor(filePath = LEDGER_FILE) {
    this.filePath = filePath;
    this.merges = new Map(); // rawKey -> { rawName, canonicalName, source: 'AUTO'|'MANUAL', date }
    this.separates = new Set(); // sortedPairKey "KEYA|||KEYB"
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf8');
        const data = JSON.parse(raw);
        if (Array.isArray(data.merges)) {
          for (const m of data.merges) {
            this.merges.set(normalizeKey(m.rawName), m);
          }
        }
        if (Array.isArray(data.separates)) {
          for (const s of data.separates) {
            this.separates.add(s);
          }
        }
      }
    } catch (e) {
      console.error(`[CatalogLedger] Primary ledger read error on ${this.filePath}:`, e.message);
      // Attempt automatic fallback to backup if operating on production ledger
      if (this.filePath === LEDGER_FILE) {
        const backupFile = path.join(DATA_DIR, 'catalog_ledger.backup.json');
        if (fs.existsSync(backupFile)) {
          try {
            const rawBackup = fs.readFileSync(backupFile, 'utf8');
            const dataBackup = JSON.parse(rawBackup);
            if (Array.isArray(dataBackup.merges)) {
              for (const m of dataBackup.merges) {
                this.merges.set(normalizeKey(m.rawName), m);
              }
            }
            if (Array.isArray(dataBackup.separates)) {
              for (const s of dataBackup.separates) {
                this.separates.add(s);
              }
            }
            console.warn('[CatalogLedger] Successfully recovered decision state from catalog_ledger.backup.json');
            return;
          } catch (bErr) {
            console.error('[CatalogLedger] Backup recovery also failed:', bErr.message);
          }
        }
      }
      // If no valid backup exists, start empty
      this.merges = new Map();
      this.separates = new Set();
    }
  }

  save() {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const data = {
        updatedAt: new Date().toISOString(),
        merges: Array.from(this.merges.values()),
        separates: Array.from(this.separates),
      };
      const jsonContent = JSON.stringify(data, null, 2);

      // Atomic write pattern: write to temporary file, then atomic rename
      const tempPath = `${this.filePath}.tmp.${Date.now()}`;
      fs.writeFileSync(tempPath, jsonContent, 'utf8');
      fs.renameSync(tempPath, this.filePath);

      // If writing to production ledger, mirror to backup file
      if (this.filePath === LEDGER_FILE) {
        const backupFile = path.join(DATA_DIR, 'catalog_ledger.backup.json');
        fs.writeFileSync(backupFile, jsonContent, 'utf8');
      }
    } catch (e) {
      console.error('[CatalogLedger] Failed to save ledger:', e.message);
    }
  }

  recordMerge(rawName, canonicalName, source = 'MANUAL') {
    const key = normalizeKey(rawName);
    this.merges.set(key, {
      rawName: String(rawName).trim(),
      canonicalName: String(canonicalName).trim(),
      source,
      date: new Date().toISOString(),
    });
    this.save();
  }

  recordKeepSeparate(itemA, itemB) {
    const key = this.getPairKey(itemA, itemB);
    this.separates.add(key);
    this.save();
  }

  removeDecision(rawNameOrItemA, itemB = null) {
    if (itemB) {
      const pairKey = this.getPairKey(rawNameOrItemA, itemB);
      this.separates.delete(pairKey);
    } else {
      this.merges.delete(normalizeKey(rawNameOrItemA));
    }
    this.save();
  }

  isKeptSeparate(itemA, itemB) {
    return this.separates.has(this.getPairKey(itemA, itemB));
  }

  getCanonical(rawName) {
    const entry = this.merges.get(normalizeKey(rawName));
    return entry ? entry.canonicalName : null;
  }

  getPairKey(itemA, itemB) {
    const kA = normalizeKey(itemA);
    const kB = normalizeKey(itemB);
    return kA < kB ? `${kA}|||${kB}` : `${kB}|||${kA}`;
  }

  getAllMerges() {
    return Array.from(this.merges.values());
  }

  getAllSeparates() {
    return Array.from(this.separates).map((k) => {
      const [itemA, itemB] = k.split('|||');
      return { itemA, itemB };
    });
  }
}

/**
 * Deterministic Canonical Name Selection Rule:
 * 1. Existing manual canonical name from ledger, if defined
 * 2. Exact stock name without N suffix
 * 3. Exact sales name without N suffix
 * 4. First normalized variant
 */
function selectCanonicalName(rawVariants, ledgerCanonical, stockNamesSet, salesNamesSet) {
  if (ledgerCanonical) return ledgerCanonical;

  // Exact stock name without N suffix
  for (const name of rawVariants) {
    const norm = normalizeDeterministic(name);
    if (stockNamesSet.has(norm) && !/(?:\s+N+)+$/i.test(name)) {
      return norm;
    }
  }

  // Exact stock name in stockNamesSet
  for (const name of rawVariants) {
    const norm = normalizeDeterministic(name);
    if (stockNamesSet.has(norm)) {
      return norm;
    }
  }

  // Exact sales name without N suffix
  for (const name of rawVariants) {
    const norm = normalizeDeterministic(name);
    if (salesNamesSet.has(norm) && !/(?:\s+N+)+$/i.test(name)) {
      return norm;
    }
  }

  // Fallback to first normalized variant
  return normalizeDeterministic(rawVariants[0]);
}

/**
 * Main V1.1 Catalog & Stock Name Resolution Pipeline
 *
 * @param {Object} params
 * @param {Array} params.saleRecords - raw records from parseSaleReport
 * @param {Array} params.stockRecords - raw records from parseStockDetailReport
 * @param {CatalogLedger} [params.ledger] - persistent ledger instance
 * @param {Array} [params.runtimeManualMappings] - optional runtime mappings
 * @param {Array} [params.runtimeRejectedMerges] - optional runtime rejected merges
 * @param {Map|Object} [params.masterCatalogMap] - optional lookup map from SQLite master catalog
 */
function resolveCatalogIdentity({
  saleRecords = [],
  stockRecords = [],
  ledger = null,
  runtimeManualMappings = [],
  runtimeRejectedMerges = [],
  masterCatalogMap = null,
}) {
  const activeLedger = ledger || new CatalogLedger();

  // Incorporate runtime mappings/rejections into active ledger if provided
  for (const { from, to } of runtimeManualMappings) {
    activeLedger.recordMerge(from, to, 'MANUAL');
  }
  for (const { itemA, itemB } of runtimeRejectedMerges) {
    activeLedger.recordKeepSeparate(itemA, itemB);
  }

  // Sourced MRP extraction: Sale Report (Price/Unit is MRP) -> Master Catalog -> Not available
  const rawMrpMap = new Map(); // rawName -> { mrp: number, source: string }

  // 1. Cross-Report Raw-Name Inventory
  const rawSalesMap = new Map(); // rawName -> { totalQty, priceSum, priceCount }
  for (const r of saleRecords) {
    const raw = String(r.rawItemName || r.itemName || '').trim();
    if (!raw) continue;
    if (!rawSalesMap.has(raw)) {
      rawSalesMap.set(raw, { totalQty: 0, priceSum: 0, priceCount: 0 });
    }
    const entry = rawSalesMap.get(raw);
    entry.totalQty += r.quantity || 0;
    // For 78 Supermaart: Sale Report Price/Unit is MRP
    const saleMrp = (r.mrp !== null && r.mrp !== undefined) ? r.mrp : r.pricePerUnit;
    if (saleMrp !== null && saleMrp !== undefined) {
      entry.priceSum += saleMrp;
      entry.priceCount++;
      if (!rawMrpMap.has(raw)) {
        rawMrpMap.set(raw, { mrp: saleMrp, source: 'Sale Report' });
      }
      const normRaw = normalizeDeterministic(raw);
      if (!rawMrpMap.has(normRaw)) {
        rawMrpMap.set(normRaw, { mrp: saleMrp, source: 'Sale Report' });
      }
    }
  }

  const rawStockMap = new Map(); // rawName -> { currentStock, asOfDate }
  for (const r of stockRecords) {
    const raw = String(r.rawItemName || r.itemName || '').trim();
    if (!raw) continue;
    if (!rawStockMap.has(raw)) {
      rawStockMap.set(raw, { currentStock: 0, asOfDate: r.date });
    }
    rawStockMap.get(raw).currentStock += r.closingQty || 0;
    if (r.mrp !== null && r.mrp !== undefined && !rawMrpMap.has(raw)) {
      rawMrpMap.set(raw, { mrp: r.mrp, source: 'Stock Detail' });
    }
  }

  function getItemMrpInfo(itemName) {
    if (!itemName) return { mrp: null, source: 'Not available' };

    // 1. Sale Report (Price/Unit is MRP)
    const fromReports = rawMrpMap.get(itemName);
    if (fromReports && fromReports.mrp !== null) return fromReports;

    const norm = normalizeDeterministic(itemName);
    const fromNorm = rawMrpMap.get(norm);
    if (fromNorm && fromNorm.mrp !== null) return fromNorm;

    // 2. Master Catalog MRP
    if (masterCatalogMap) {
      const key = normalizeKey(itemName);
      const normKey = normalizeKey(norm);
      let catMrp = null;
      if (masterCatalogMap instanceof Map) {
        catMrp = masterCatalogMap.get(key) ?? masterCatalogMap.get(normKey) ?? null;
      } else if (typeof masterCatalogMap === 'object') {
        catMrp = masterCatalogMap[key] ?? masterCatalogMap[normKey] ?? null;
      }
      if (catMrp !== null && catMrp !== undefined) {
        return { mrp: catMrp, source: 'Master Catalog' };
      }
    }
    return { mrp: null, source: 'Not available' };
  }

  const allRawNames = Array.from(new Set([...rawSalesMap.keys(), ...rawStockMap.keys()]));
  const stockNamesSet = new Set(Array.from(rawStockMap.keys()).map(normalizeDeterministic));
  const salesNamesSet = new Set(Array.from(rawSalesMap.keys()).map(normalizeDeterministic));

  // 2. Level 1 Deterministic Normalization & Ledger Mappings
  // Group raw names by preliminary target
  const nameToTarget = new Map();
  const rawToMethod = new Map(); // rawName -> 'EXACT' | 'AUTO' | 'MANUAL'

  for (const raw of allRawNames) {
    // Check persistent ledger first (both raw and normalized form)
    const norm = normalizeDeterministic(raw);
    const ledgerTarget = activeLedger.getCanonical(raw) || activeLedger.getCanonical(norm);
    if (ledgerTarget) {
      nameToTarget.set(raw, normalizeDeterministic(ledgerTarget));
      rawToMethod.set(raw, 'MANUAL');
      continue;
    }

    // Level 1: Deterministic normalization
    nameToTarget.set(raw, norm);
    if (norm !== raw) {
      rawToMethod.set(raw, 'AUTO');
    } else {
      rawToMethod.set(raw, 'EXACT');
    }
  }

  // 3. Level 2 Semantic / Candidate Matching
  // Collect distinct normalized targets to check for potential abbreviation/variant merges
  const uniqueNormalizedTargets = Array.from(new Set(nameToTarget.values()));
  const pendingCandidates = [];

  // Precompute identities and partition by brand to prevent O(N^2) quadratic performance bottleneck
  const identityMap = new Map();
  const brandBuckets = new Map();

  for (const target of uniqueNormalizedTargets) {
    const id = extractProductIdentity(target);
    identityMap.set(target, id);
    if (!id.brand) continue;
    if (!brandBuckets.has(id.brand)) {
      brandBuckets.set(id.brand, []);
    }
    brandBuckets.get(id.brand).push(target);
  }

  for (const [, targetsInBrand] of brandBuckets.entries()) {
    if (targetsInBrand.length < 2) continue;
    for (let i = 0; i < targetsInBrand.length; i++) {
      for (let j = i + 1; j < targetsInBrand.length; j++) {
        const targetA = targetsInBrand[i];
        const targetB = targetsInBrand[j];

        // Skip if previously decided as KEEP_SEPARATE
        if (activeLedger.isKeptSeparate(targetA, targetB)) continue;

        const evalResult = evaluateCandidateMatch(
          targetA,
          targetB,
          identityMap.get(targetA),
          identityMap.get(targetB)
        );
        if (evalResult.isMatch) {
          const suggestedCanonical = selectCanonicalName([targetA, targetB], null, stockNamesSet, salesNamesSet);

          const mrpInfoA = getItemMrpInfo(targetA);
          const mrpInfoB = getItemMrpInfo(targetB);

          const salesInfoA = rawSalesMap.get(targetA);
          const salesInfoB = rawSalesMap.get(targetB);

          const stockInfoA = rawStockMap.get(targetA);
          const stockInfoB = rawStockMap.get(targetB);

          const avgPriceA = salesInfoA && salesInfoA.priceCount > 0
            ? Math.round((salesInfoA.priceSum / salesInfoA.priceCount) * 100) / 100
            : null;
          const avgPriceB = salesInfoB && salesInfoB.priceCount > 0
            ? Math.round((salesInfoB.priceSum / salesInfoB.priceCount) * 100) / 100
            : null;

          const idA = identityMap.get(targetA);
          const idB = identityMap.get(targetB);

          const packCheck = evalResult.packCountCheck || {
            match: true,
            warning: false,
            label: idA.sizeWeightFormatted || idA.numericToken || '—',
            valA: idA.sizeWeightFormatted || idA.numericToken || 'none',
            valB: idB.sizeWeightFormatted || idB.numericToken || 'none',
          };

          const mrpLabel = (mrpInfoA.mrp !== null || mrpInfoB.mrp !== null)
            ? `${mrpInfoA.mrp !== null ? '₹' + mrpInfoA.mrp : '—'} vs ${mrpInfoB.mrp !== null ? '₹' + mrpInfoB.mrp : '—'}`
            : '—';

          pendingCandidates.push({
            itemA: targetA,
            itemB: targetB,
            confidence: evalResult.confidence,
            hasWarning: Boolean(evalResult.hasWarning),
            matchStatus: evalResult.hasWarning ? 'HUMAN_REVIEW_REQUIRED' : 'IDENTITY_SUPPORTED',
            reason: evalResult.reason,
            suggestedCanonical,
            variantA: {
              name: targetA,
              mrp: mrpInfoA.mrp,
              mrpSource: mrpInfoA.source,
              avgMrp: avgPriceA,
              avgPrice: avgPriceA,
              salesQty: salesInfoA ? salesInfoA.totalQty : 0,
              stockQty: stockInfoA ? stockInfoA.currentStock : 0,
            },
            variantB: {
              name: targetB,
              mrp: mrpInfoB.mrp,
              mrpSource: mrpInfoB.source,
              avgMrp: avgPriceB,
              avgPrice: avgPriceB,
              salesQty: salesInfoB ? salesInfoB.totalQty : 0,
              stockQty: stockInfoB ? stockInfoB.currentStock : 0,
            },
            identityCheck: {
              brand: {
                match: idA.brand === idB.brand,
                valA: idA.brand,
                valB: idB.brand,
              },
              product: {
                match: true,
                valA: idA.productTokens.join(' '),
                valB: idB.productTokens.join(' '),
              },
              packCount: packCheck,
              mrp: {
                valA: mrpInfoA.mrp !== null ? `₹${mrpInfoA.mrp}` : '—',
                valB: mrpInfoB.mrp !== null ? `₹${mrpInfoB.mrp}` : '—',
                label: mrpLabel,
              },
            },
          });
        }
      }
    }
  }

  // 4. Cluster Raw Variants into Canonical SKUs
  // target -> Set of raw variants
  const targetToVariants = new Map();
  for (const raw of allRawNames) {
    const target = nameToTarget.get(raw);
    if (!targetToVariants.has(target)) {
      targetToVariants.set(target, new Set());
    }
    targetToVariants.get(target).add(raw);
  }

  // Build Canonical Groups & Validation Report
  const validationReport = [];
  const resolvedItems = new Map(); // canonicalName -> { canonicalName, currentStock, totalSold, salesVariants, stockVariants }
  const unresolvedItems = []; // items flagged MATCH REQUIRED (e.g. single-sided with pending candidate)

  const candidateItemsSet = new Set(
    pendingCandidates.flatMap((c) => [normalizeKey(c.itemA), normalizeKey(c.itemB)])
  );

  for (const [targetName, rawVariantsSet] of targetToVariants.entries()) {
    const variantsList = Array.from(rawVariantsSet);
    let ledgerTarget = activeLedger.getCanonical(targetName);
    if (!ledgerTarget) {
      for (const v of variantsList) {
        const c = activeLedger.getCanonical(v) || activeLedger.getCanonical(normalizeDeterministic(v));
        if (c) {
          ledgerTarget = c;
          break;
        }
      }
    }
    if (!ledgerTarget && variantsList.some((v) => rawToMethod.get(v) === 'MANUAL')) {
      ledgerTarget = targetName;
    }
    const canonicalName = selectCanonicalName(variantsList, ledgerTarget, stockNamesSet, salesNamesSet);

    // Sales breakdown
    const salesVariants = [];
    let totalSalesQty = 0;
    for (const v of variantsList) {
      if (rawSalesMap.has(v)) {
        const sInfo = rawSalesMap.get(v);
        totalSalesQty += sInfo.totalQty;
        salesVariants.push({
          rawName: v,
          quantitySold: sInfo.totalQty,
          status: rawToMethod.get(v) || 'EXACT',
        });
      }
    }

    // Stock breakdown
    const stockVariants = [];
    let totalStockQty = 0;
    let stockAsOfDate = null;
    for (const v of variantsList) {
      if (rawStockMap.has(v)) {
        const stInfo = rawStockMap.get(v);
        totalStockQty += stInfo.currentStock;
        stockAsOfDate = stInfo.asOfDate || stockAsOfDate;
        stockVariants.push({
          rawName: v,
          currentStock: stInfo.currentStock,
          status: rawToMethod.get(v) || 'EXACT',
        });
      }
    }

    const inSales = salesVariants.length > 0;
    const inStock = stockVariants.length > 0;
    const hasPendingCandidate = candidateItemsSet.has(normalizeKey(canonicalName));

    // Determine Resolution Status & Resolution Source
    let resolutionStatus = 'MATCHED';
    let resolutionSource = 'AUTO_MATCHED';
    let resolutionDetail = 'Exact match across reports';

    const hasManual = variantsList.some((v) => rawToMethod.get(v) === 'MANUAL');
    const hasAuto = variantsList.some((v) => rawToMethod.get(v) === 'AUTO');

    if (hasManual) {
      resolutionStatus = 'MANUAL_MERGED';
      resolutionSource = 'MANUAL_MERGE';
      resolutionDetail = 'Resolved via confirmed manual ledger mapping';
    } else if (hasAuto || variantsList.length > 1) {
      resolutionStatus = 'AUTO_MERGED';
      resolutionSource = 'AUTO_NORMALIZED';
      resolutionDetail = 'All mapped to one canonical SKU';
    }

    // Critical Safeguard: If unresolved / single-sided with pending candidates, flag as MATCH_REQUIRED
    const isUnresolved = hasPendingCandidate && (!inSales || !inStock);
    if (isUnresolved) {
      resolutionStatus = 'UNRESOLVED';
      resolutionSource = 'UNRESOLVED';
      resolutionDetail = 'Candidate match pending approval (MATCH REQUIRED)';
    }

    // Attach resolutionSource to individual variant chips
    salesVariants.forEach(v => {
      v.resolutionSource = v.status === 'MANUAL' ? 'MANUAL_MERGE' : (v.status === 'AUTO' ? 'AUTO_NORMALIZED' : 'AUTO_MATCHED');
    });
    stockVariants.forEach(v => {
      v.resolutionSource = v.status === 'MANUAL' ? 'MANUAL_MERGE' : (v.status === 'AUTO' ? 'AUTO_NORMALIZED' : 'AUTO_MATCHED');
    });

    const reportEntry = {
      canonicalName,
      resolutionStatus,
      resolutionSource,
      resolutionDetail,
      inSales,
      inStock,
      salesVariants,
      totalSalesQuantity: totalSalesQty,
      stockVariants,
      totalStockQuantity: totalStockQty,
      stockAsOfDate,
      hasPendingCandidate,
    };

    validationReport.push(reportEntry);

    if (resolutionStatus === 'UNRESOLVED') {
      unresolvedItems.push(reportEntry);
    } else {
      resolvedItems.set(canonicalName, {
        canonicalName,
        currentStock: totalStockQty,
        totalSold: totalSalesQty,
        stockAsOfDate,
        salesVariants,
        stockVariants,
      });
    }
  }

  // Sort validation report: UNRESOLVED first, then AUTO_MERGED / MANUAL_MERGED, then MATCHED
  const statusPriority = { UNRESOLVED: 0, MANUAL_MERGED: 1, AUTO_MERGED: 2, MATCHED: 3 };
  validationReport.sort((a, b) => (statusPriority[a.resolutionStatus] ?? 4) - (statusPriority[b.resolutionStatus] ?? 4));

  // Summary Metrics
  const summary = {
    totalRawNames: allRawNames.length,
    canonicalCount: validationReport.length,
    matchedCount: validationReport.filter((r) => r.resolutionStatus === 'MATCHED').length,
    autoMergedCount: validationReport.filter((r) => r.resolutionStatus === 'AUTO_MERGED').length,
    manualMergedCount: validationReport.filter((r) => r.resolutionStatus === 'MANUAL_MERGED').length,
    unresolvedCount: unresolvedItems.length,
    pendingCandidatesCount: pendingCandidates.length,
  };

  // Helper resolver function for downstream records
  function resolveRawNameToCanonical(rawName) {
    const target = nameToTarget.get(rawName) || normalizeDeterministic(rawName);
    // Find canonical name for this target
    for (const rep of validationReport) {
      if (rep.canonicalName === target || rep.salesVariants.some((v) => v.rawName === rawName) || rep.stockVariants.some((v) => v.rawName === rawName)) {
        return rep.canonicalName;
      }
    }
    return target;
  }

  return {
    summary,
    validationReport,
    pendingCandidates,
    resolvedItems,
    unresolvedItems,
    resolveRawNameToCanonical,
    activeLedger,
  };
}

module.exports = {
  normalizeDeterministic,
  extractProductIdentity,
  evaluateCandidateMatch,
  selectCanonicalName,
  CatalogLedger,
  resolveCatalogIdentity,
  normalizeKey,
};
