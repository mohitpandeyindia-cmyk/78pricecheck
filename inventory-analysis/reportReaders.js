const XLSX = require('xlsx');
const {
  readSheetRaw,
  findHeaderRowIndex,
  mapColumns,
  parseDateCell,
  parseGenerationDateFromTitle,
  parseNumberCell,
  normalizeItemName,
} = require('./parsers');

/**
 * Sale Report -> Supports both Desktop ("Item Details" sheet) and Mobile ("Sale Items" sheet).
 * Auto-detects the itemized sheet by content (Date, Item Name, Quantity) across all sheets in the workbook.
 * Columns supported: Date, Invoice No., Item Name, Item Code, HSN/SAC, Quantity, Unit, UnitPrice (Price/Unit), Amount.
 */
function parseSaleReport(filePath, sheetSelector = null) {
  const wb = XLSX.readFile(filePath, { cellDates: true });
  const sheetNames = wb.SheetNames;

  let sheetName = null;
  let rows = null;
  let headerIdx = -1;
  const keywordSets = [['item'], ['qty', 'quantity'], ['date']];

  // If explicit sheetSelector passed, try that first
  if (sheetSelector !== null && sheetSelector !== undefined) {
    if (typeof sheetSelector === 'number') {
      sheetName = sheetNames[sheetSelector];
    } else {
      sheetName = sheetSelector;
    }
    if (sheetName && wb.Sheets[sheetName]) {
      rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, raw: false, defval: '' });
      headerIdx = findHeaderRowIndex(rows, keywordSets);
    }
  }

  // Scan all sheets by content if not found
  if (headerIdx === -1) {
    for (const name of sheetNames) {
      const candidateRows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: false, defval: '' });
      const idx = findHeaderRowIndex(candidateRows, keywordSets);
      if (idx !== -1) {
        sheetName = name;
        rows = candidateRows;
        headerIdx = idx;
        break;
      }
    }
  }

  if (headerIdx === -1 || !rows) {
    throw new Error(
      `Could not locate a sale items sheet in "${filePath}". ` +
      `Expected columns matching item, quantity, and date. Available sheets: ${sheetNames.join(', ')}`
    );
  }

  const headerRow = rows[headerIdx];
  const colMap = mapColumns(headerRow, {
    itemName: ['item name', 'item'],
    quantity: ['quantity', 'qty'],
    date: ['date'],
  });

  // For 78 Supermaart: Price/Unit or UnitPrice in Vyapar Sale Report = MRP
  const optionalColMap = mapColumns(headerRow, {
    pricePerUnit: ['price/unit', 'price per unit', 'unitprice', 'unit price'],
    mrp: ['mrp', 'm.r.p', 'max retail price', 'maximum retail price'],
  });

  const missing = Object.entries(colMap).filter(([, idx]) => idx === -1);
  if (missing.length) {
    throw new Error(
      `Header row found at row ${headerIdx + 1}, but couldn't match column(s): ` +
      `${missing.map(([f]) => f).join(', ')}. Header was: [${headerRow.join(' | ')}]`
    );
  }

  const records = [];
  const flagged = [];

  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    if (row.every((c) => String(c).trim() === '')) continue;

    const rawItemName = String(row[colMap.itemName] || '').trim();
    const itemName = normalizeItemName(rawItemName);
    const quantity = parseNumberCell(row[colMap.quantity]);
    const date = parseDateCell(row[colMap.date]);
    const priceUnitVal = optionalColMap.pricePerUnit !== -1 ? parseNumberCell(row[optionalColMap.pricePerUnit]) : null;
    const explicitMrp = optionalColMap.mrp !== -1 ? parseNumberCell(row[optionalColMap.mrp]) : null;
    // Authoritative rule: Sale Report Price/Unit or UnitPrice is MRP
    const mrp = priceUnitVal !== null ? priceUnitVal : explicitMrp;
    const pricePerUnit = mrp; // retained for backwards compatibility
    const mrpSource = priceUnitVal !== null ? 'Sale Report / UnitPrice' : (explicitMrp !== null ? 'Sale Report' : 'Not available');

    if (!rawItemName) { flagged.push({ rowNumber: i + 1, reason: 'missing item name', raw: row }); continue; }
    if (quantity === null) { flagged.push({ rowNumber: i + 1, reason: 'unparseable quantity', raw: row }); continue; }
    if (quantity < 0) { flagged.push({ rowNumber: i + 1, reason: 'negative quantity', raw: row }); continue; }
    if (!date) { flagged.push({ rowNumber: i + 1, reason: 'unparseable date', raw: row }); continue; }

    records.push({ itemName, rawItemName, quantity, date, mrp, pricePerUnit, mrpSource });
  }

  return { records, flagged };
}

/**
 * Stock Detail Report — a single point-in-time snapshot.
 * Supports:
 *   - Desktop exports: Headers directly at row 0 without "Generated on" title;
 *     spelling "Begining Quantity"; snapshotDateSource = "not provided by export".
 *   - Mobile/Phone exports: Row 0 "Generated on <date>" title row; header at Row 2.
 */
function parseStockDetailReport(filePath, sheetSelector = null) {
  const wb = XLSX.readFile(filePath, { cellDates: true });
  const sheetNames = wb.SheetNames;

  let sheetName = null;
  let rows = null;
  let headerIdx = -1;
  const keywordSets = [['item'], ['opening', 'begining', 'beginning'], ['closing']];

  // If explicit sheetSelector passed, try that first
  if (sheetSelector !== null && sheetSelector !== undefined) {
    if (typeof sheetSelector === 'number') {
      sheetName = sheetNames[sheetSelector];
    } else {
      sheetName = sheetSelector;
    }
    if (sheetName && wb.Sheets[sheetName]) {
      rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, raw: false, defval: '' });
      headerIdx = findHeaderRowIndex(rows, keywordSets);
    }
  }

  // Scan all sheets if not found
  if (headerIdx === -1) {
    for (const name of sheetNames) {
      const candidateRows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: false, defval: '' });
      const idx = findHeaderRowIndex(candidateRows, keywordSets);
      if (idx !== -1) {
        sheetName = name;
        rows = candidateRows;
        headerIdx = idx;
        break;
      }
    }
  }

  // Fallback if opening/begining is not present: match item and closing
  if (headerIdx === -1) {
    const fallbackKeywordSets = [['item'], ['closing']];
    for (const name of sheetNames) {
      const candidateRows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: false, defval: '' });
      const idx = findHeaderRowIndex(candidateRows, fallbackKeywordSets);
      if (idx !== -1) {
        sheetName = name;
        rows = candidateRows;
        headerIdx = idx;
        break;
      }
    }
  }

  if (headerIdx === -1 || !rows) {
    throw new Error(
      `Could not locate a header row in "${filePath}" matching item and closing quantity columns. Available sheets: ${sheetNames.join(', ')}`
    );
  }

  // Extract snapshot date from any title cell in rows preceding headerIdx (e.g. mobile exports)
  let generationDate = null;
  let snapshotDateSource = 'not provided by export';
  for (let r = 0; r < headerIdx; r++) {
    for (const cell of (rows[r] || [])) {
      const parsed = parseGenerationDateFromTitle(cell);
      if (parsed) {
        generationDate = parsed;
        snapshotDateSource = 'title';
        break;
      }
    }
    if (generationDate) break;
  }

  const headerRow = rows[headerIdx];
  const colMap = mapColumns(headerRow, {
    itemName: ['item name', 'item'],
    openingQty: ['opening quantity', 'begining quantity', 'beginning quantity', 'opening', 'begining', 'beginning'],
    quantityIn: ['quantity in', 'qty in', 'in'],
    quantityOut: ['quantity out', 'qty out', 'out'],
    closingQty: ['closing quantity', 'closing qty', 'closing'],
    mrp: ['mrp', 'm.r.p', 'max retail price', 'maximum retail price'],
  });

  const missing = ['itemName', 'closingQty'].filter((f) => colMap[f] === -1);
  if (missing.length) {
    throw new Error(
      `Header row found at row ${headerIdx + 1}, but couldn't match column(s): ${missing.join(', ')}. ` +
      `Header was: [${headerRow.join(' | ')}]`
    );
  }

  const records = [];
  const flagged = [];
  const negativeStockItems = [];

  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    if (row.every((c) => String(c).trim() === '')) continue;

    const rawItemName = String(row[colMap.itemName] || '').trim();

    // Vyapar appends a "Total" row at the very end of this report,
    // summing every numeric column — it has no serial number and isn't a
    // real item. Skip it rather than let it appear as a phantom product.
    if (rawItemName.toLowerCase() === 'total' || rawItemName.toLowerCase() === 'grand total') {
      continue;
    }

    const itemName = normalizeItemName(rawItemName);
    const openingQty = colMap.openingQty !== -1 ? parseNumberCell(row[colMap.openingQty]) : null;
    const rawClosingQty = parseNumberCell(row[colMap.closingQty]);
    const quantityIn = colMap.quantityIn !== -1 ? parseNumberCell(row[colMap.quantityIn]) : null;
    const quantityOut = colMap.quantityOut !== -1 ? parseNumberCell(row[colMap.quantityOut]) : null;
    const mrp = colMap.mrp !== -1 ? parseNumberCell(row[colMap.mrp]) : null;

    if (!rawItemName) { flagged.push({ rowNumber: i + 1, reason: 'missing item name', raw: row }); continue; }
    if (rawClosingQty === null) { flagged.push({ rowNumber: i + 1, reason: 'unparseable closing quantity', raw: row }); continue; }

    // Negative closing quantity means the system recorded more sold than
    // ever received (unlogged purchase, stock adjustment, or barcode
    // mix-up) — physically that's 0 on hand, not a row to discard. We
    // clamp to 0 for the reorder math but surface it separately since it's
    // usually the most urgent kind of item to check.
    let closingQty = rawClosingQty;
    if (rawClosingQty < 0) {
      negativeStockItems.push({ itemName: rawItemName, recordedClosingQty: rawClosingQty });
      closingQty = 0;
    }

    records.push({ itemName, rawItemName, openingQty, quantityIn, quantityOut, closingQty, date: generationDate, mrp });
  }

  return { records, flagged, generationDate, snapshotDateSource, negativeStockItems };
}

/**
 * Reshapes Stock Detail rows into a lookup map keyed by CANONICAL item
 * name. Multiple raw rows that normalize to the same canonical name (the
 * "same product listed twice with a trailing N/NN/NNN marker for a
 * different MRP" pattern) are SUMMED together — they're genuinely the same
 * physical stock, just split across two item-master entries — rather than
 * one overwriting the other.
 */
function getCurrentStockByItem(stockRecords) {
  const currentStock = {};
  const mergedVariants = new Map(); // canonicalName -> Set of raw names that merged into it

  for (const rec of stockRecords) {
    if (!currentStock[rec.itemName]) {
      currentStock[rec.itemName] = { quantity: 0, asOfDate: rec.date };
    }
    currentStock[rec.itemName].quantity += rec.closingQty;

    if (!mergedVariants.has(rec.itemName)) mergedVariants.set(rec.itemName, new Set());
    mergedVariants.get(rec.itemName).add(rec.rawItemName);
  }

  // Only report groups that actually combined 2+ distinct raw names —
  // a canonical name backed by a single raw row isn't a "merge".
  const mergeReport = [...mergedVariants.entries()]
    .filter(([, rawNames]) => rawNames.size > 1)
    .map(([canonicalName, rawNames]) => ({ canonicalName, rawVariants: [...rawNames] }));

  return { currentStock, mergedItemGroups: mergeReport };
}

/**
 * The exact-match N-suffix strip above handles most duplicate entries, but
 * some are shortened MORE than just the trailing N (e.g. a weight/size
 * token got dropped too — "AMUL CHEESE SLICES 200G" vs "AMUL CHEESE
 * SLICES N", not "...200G N"). Those don't exact-match after stripping, so
 * they're silently treated as two separate items — which can hide real
 * stock (a variant showing 0 while its real stock sits under a
 * differently-named row).
 *
 * This finds candidates for those cases by fuzzy prefix matching, but
 * DELIBERATELY DOES NOT AUTO-MERGE THEM — a wrong automatic merge could
 * silently combine two genuinely different products (e.g. a promo pack vs
 * the regular pack) and corrupt real stock numbers. Instead this returns a
 * review list: a single unambiguous candidate is "suggested" (still needs
 * human confirmation), zero or multiple candidates just get named as
 * unresolved for manual attention. The real fix is usually cleaning up the
 * naming in Vyapar itself.
 */
function findNameMatchSuggestions(stockRecords) {
  const rawNames = [...new Set(stockRecords.map((r) => r.rawItemName))];
  const rawNameSet = new Set(rawNames);

  const stripN = (name) => name.replace(/(?:\s+N+)+$/i, '').trim();
  const isNSuffixed = (name) => stripN(name) !== name;

  const suggestedMerges = [];
  const unresolved = [];

  for (const name of rawNames) {
    const stripped = stripN(name);
    if (stripped === name) continue; // not an N-suffixed name at all
    if (rawNameSet.has(stripped)) continue; // already handled by the exact-match path

    // Only consider "clean" (non-N-suffixed) names as merge candidates, so we
    // never chain one duplicate onto another duplicate.
    const candidates = rawNames.filter(
      (other) => other !== name && !isNSuffixed(other) && other.startsWith(stripped + ' ')
    );

    if (candidates.length === 1) {
      suggestedMerges.push({ rawName: name, suggestedMatch: candidates[0] });
    } else {
      unresolved.push({ rawName: name, candidates });
    }
  }

  return { suggestedMerges, unresolved };
}

/**
 * Builds a name-resolution map that combines stock rows for the same
 * physical product listed under multiple item-master entries — both the
 * clean "N/NN/NNN suffix" case (handled by normalizeItemName's stripping)
 * and the messier case where the duplicate's name was ALSO shortened (a
 * weight/size token dropped), which stripping alone can't fix.
 *
 * Unlike findNameMatchSuggestions() (review-only), this ACTUALLY resolves
 * the confident single-candidate cases into one canonical name — per an
 * explicit decision that these should be treated as one item, not two.
 * Only genuinely ambiguous cases (0 or 2+ candidates) are left unresolved,
 * since guessing there risks combining two different products.
 *
 * @param {string[]} rawStockNames - every raw item name from the Stock Detail Report
 * @param {Array<{from: string, to: string}>} manualMappings - explicit,
 *   store-owner-confirmed overrides, e.g. for promotional renames like
 *   "ANIK GHEE 1L FREE SUGAR" -> "ANIK GHEE 1L". These exist because some
 *   duplicate patterns (plain-language renames with no shared marker) are
 *   NOT safely detectable automatically — a same-name-prefix or matching-
 *   quantity heuristic produces too many false positives (e.g. matching
 *   different flavors or sizes of the same product line as if they were
 *   the same item). Only a human who knows the catalog can confirm these,
 *   so they're supplied here rather than guessed.
 * @returns {{ resolve: (name: string) => string, autoMerged: Array, unresolved: Array, manualMergesApplied: Array, manualMappingsNotFound: Array }}
 */
function buildNameResolver(rawStockNames, manualMappings = []) {
  const uniqueRaw = [...new Set(rawStockNames)];
  const rawNameSet = new Set(uniqueRaw);

  const stripN = (name) => name.replace(/(?:\s+N+)+$/i, '').trim();
  const isNSuffixed = (name) => stripN(name) !== name;
  const normalizeKey = (name) => String(name).trim().toUpperCase();

  // strippedName -> canonical full name, only for confident single-candidate cases
  const overrideMap = new Map();
  const autoMerged = [];
  const unresolved = [];

  for (const name of uniqueRaw) {
    const stripped = stripN(name);
    if (stripped === name) continue; // not N-suffixed at all
    if (rawNameSet.has(stripped)) continue; // exact match — normalizeItemName already handles this correctly on its own

    const candidates = uniqueRaw.filter(
      (other) => other !== name && !isNSuffixed(other) && other.startsWith(stripped + ' ')
    );

    if (candidates.length === 1) {
      overrideMap.set(stripped, candidates[0]);
      autoMerged.push({ rawName: name, mergedInto: candidates[0] });
    } else {
      unresolved.push({ rawName: name, candidates });
    }
  }

  function resolveAutomatic(rawName) {
    const stripped = stripN(rawName);
    return overrideMap.get(stripped) || stripped;
  }

  // Manual overrides take priority, matched case-insensitively so small
  // formatting differences don't silently fail to apply. The mapping's
  // TARGET still passes through automatic resolution too, in case it
  // happens to also be an N-suffixed name.
  const manualMap = new Map();
  for (const { from, to } of manualMappings) {
    manualMap.set(normalizeKey(from), to);
  }

  const manualMergesApplied = [];
  const manualMappingsNotFound = [];
  for (const { from, to } of manualMappings) {
    if (rawNameSet.has(from)) {
      manualMergesApplied.push({ from, to });
    } else {
      // The mapping was supplied but no item in THIS export matches it —
      // worth telling the user, since it likely means a typo or the item
      // was renamed again since the mapping was written.
      manualMappingsNotFound.push({ from, to });
    }
  }

  function resolve(rawName) {
    const manualTarget = manualMap.get(normalizeKey(rawName));
    if (manualTarget) return resolveAutomatic(manualTarget);
    return resolveAutomatic(rawName);
  }

  return { resolve, autoMerged, unresolved, manualMergesApplied, manualMappingsNotFound };
}

/**
 * Broader version of the merge-candidate search: unlike the N-suffix-only
 * logic above, this looks for a single-candidate PREFIX relationship
 * between any two canonical item names, regardless of whether either has
 * an N-suffix — this is what catches cases like "ANIK GHEE 1L" vs "ANIK
 * GHEE 1L FREE SUGAR" (a plain-language rename with no shared marker).
 *
 * This is intentionally NEVER auto-applied. Tested against real data, a
 * "single candidate" prefix match still has a meaningful false-positive
 * rate — e.g. "LAYS HNDS" vs "LAYS HNDS 10" is very likely a single packet
 * vs. a box of 10 (a genuinely different SKU), not a duplicate. Every
 * result here is a SUGGESTION for a human to approve or reject; approved
 * pairs should be saved as a manual mapping (see buildNameResolver) so the
 * decision persists across future runs instead of being re-asked forever.
 *
 * @param {string[]} canonicalNames - item names AFTER N-suffix resolution has already run (avoids re-suggesting pairs that are already merged)
 * @param {Set<string>} alreadyDecidedKeys - normalized (uppercase, trimmed) names that have already been approved OR rejected in a past review, so they aren't suggested again
 * @returns {Array<{ itemA: string, itemB: string }>}
 */
function findGeneralMergeSuggestions(canonicalNames, alreadyDecidedKeys = new Set()) {
  const uniqueNames = [...new Set(canonicalNames)];
  const normalizeKey = (name) => String(name).trim().toUpperCase();

  const suggestions = [];
  for (const shorter of uniqueNames) {
    if (alreadyDecidedKeys.has(normalizeKey(shorter))) continue;

    const matches = uniqueNames.filter((other) => other !== shorter && other.startsWith(shorter + ' '));
    if (matches.length === 1) {
      suggestions.push({ itemA: shorter, itemB: matches[0] });
    }
  }
  return suggestions;
}

/**
 * Average MRP per item calculated from the Sale Report's Price/Unit (MRP) column.
 * Items with no recorded MRP return null.
 */
function computeAvgMrpByItem(saleRecords) {
  const sums = new Map(); // itemName -> { total, count }
  for (const rec of saleRecords) {
    const val = rec.mrp !== null && rec.mrp !== undefined ? rec.mrp : rec.pricePerUnit;
    if (val === null || val === undefined) continue;
    if (!sums.has(rec.itemName)) sums.set(rec.itemName, { total: 0, count: 0 });
    const entry = sums.get(rec.itemName);
    entry.total += val;
    entry.count += 1;
  }
  const avgMrp = {};
  for (const [itemName, { total, count }] of sums.entries()) {
    avgMrp[itemName] = count > 0 ? Math.round((total / count) * 100) / 100 : null;
  }
  return avgMrp;
}

module.exports = {
  parseSaleReport,
  parseStockDetailReport,
  getCurrentStockByItem,
  findNameMatchSuggestions,
  buildNameResolver,
  findGeneralMergeSuggestions,
  computeAvgMrpByItem,
  computeAvgPriceByItem: computeAvgMrpByItem, // backwards compatibility
};
