const fs = require('fs');
const {
  parseSaleReport,
  parseStockDetailReport,
  getCurrentStockByItem,
  computeAvgMrpByItem,
  computeAvgPriceByItem,
} = require('./reportReaders');
const { analyzeSalesPatterns } = require('./salesAnalysis');
const { generatePurchaseSuggestions, validateConfig } = require('./purchaseSuggestions');
const { resolveCatalogIdentity, CatalogLedger } = require('./nameResolver');

/**
 * Full V1.1 pipeline: Sale Report + Stock Detail Report -> Name Resolution -> purchase suggestions & classifications.
 *
 * Operational Workflow:
 * 1. Validate report files & configuration
 * 2. Parse raw reports (dd/mm/yyyy date support, snapshot date extraction, negative stock handling)
 * 3. V1.1 Cross-Report Catalog & Stock Name Resolution:
 *    - Cross-report raw inventory (Sales + Stock)
 *    - Level 1 deterministic normalization (trailing N/NN/NNN and unit spacing)
 *    - Persistent catalog ledger decisions (MERGE & KEEP_SEPARATE)
 *    - Level 2 semantic candidate matching (identity preservation: brand, size, unit, abbreviations)
 *    - Canonical SKU selection rule (stock master name priority)
 *    - Pre- and post-resolution quantity auditing
 *    - Unresolved identity safeguard: ambiguous/unresolved items are flagged MATCH REQUIRED
 *      and withheld from premature downstream reorder calculations!
 * 4. Aggregate stock quantities and sales time-series by Canonical SKU
 * 5. Automatic trend window derivation (recent/prior halves)
 * 6. Mathematical Safety Stock (Z * sigma * sqrt(L)), Reorder Point, Target Stock, Suggested Qty
 * 7. Classifications (BUY_NOW, WATCH, OK, and REVIEW)
 *
 * @param {Object} input
 * @param {string} input.saleReportPath - path to Vyapar Sale Report Excel file
 * @param {string} input.stockDetailPath - path to Vyapar Stock Detail Report Excel file
 * @param {Object} [config] - optional configuration (leadTimeDays, reviewFrequencyDays, orderCoverageDays, serviceLevel, etc.)
 */
function runAnalysis({ saleReportPath, stockDetailPath } = {}, config = {}) {
  // 1. File existence validation
  if (!saleReportPath) {
    throw new Error('Sale Report path is required.');
  }
  if (!stockDetailPath) {
    throw new Error('Stock Detail Report path is required.');
  }
  if (!fs.existsSync(saleReportPath)) {
    throw new Error(`Sale Report file not found at: "${saleReportPath}"`);
  }
  if (!fs.existsSync(stockDetailPath)) {
    throw new Error(`Stock Detail Report file not found at: "${stockDetailPath}"`);
  }

  // Validate config early
  const validatedConfig = validateConfig(config);

  // 2. Parse raw reports
  const saleParsed = parseSaleReport(saleReportPath);
  const stockParsed = parseStockDetailReport(stockDetailPath);

  // 3. V1.1 Cross-Report Name Resolution
  const ledger = new CatalogLedger();
  const identityResolution = resolveCatalogIdentity({
    saleRecords: saleParsed.records,
    stockRecords: stockParsed.records,
    ledger,
    runtimeManualMappings: config.manualNameMappings || [],
    runtimeRejectedMerges: config.rejectedMerges || [],
    masterCatalogMap: config.masterCatalogMap || null,
  });

  const unresolvedCanonicalSet = new Set(
    identityResolution.unresolvedItems.map((u) => u.canonicalName)
  );

  // Apply resolved canonical names to raw records
  const resolvedStockRecords = stockParsed.records.map((r) => ({
    ...r,
    itemName: identityResolution.resolveRawNameToCanonical(r.rawItemName || r.itemName),
  }));
  const resolvedSaleRecords = saleParsed.records.map((r) => ({
    ...r,
    itemName: identityResolution.resolveRawNameToCanonical(r.itemName),
  }));

  // Safeguard 6: Filter out unresolved identity items from downstream reorder calculations
  const filteredStockRecords = resolvedStockRecords.filter(
    (r) => !unresolvedCanonicalSet.has(r.itemName)
  );
  const filteredSaleRecords = resolvedSaleRecords.filter(
    (r) => !unresolvedCanonicalSet.has(r.itemName)
  );

  const { currentStock, mergedItemGroups } = getCurrentStockByItem(filteredStockRecords);

  // 4. Sales analysis with automatic trend window
  const salesAnalysis = analyzeSalesPatterns(filteredSaleRecords, {
    trendWindowDays: config.trendWindowDays,
  });

  // Average MRP by variant from Sale Report Price/Unit
  const avgMrpByItem = computeAvgMrpByItem(saleParsed.records);

  // Enhance pending candidates with MRP
  const pendingCandidatesWithPrices = identityResolution.pendingCandidates.map((c) => ({
    ...c,
    avgMrpA: avgMrpByItem[c.itemA] ?? (c.variantA ? c.variantA.mrp : null),
    avgMrpB: avgMrpByItem[c.itemB] ?? (c.variantB ? c.variantB.mrp : null),
    avgPriceA: avgMrpByItem[c.itemA] ?? (c.variantA ? c.variantA.mrp : null),
    avgPriceB: avgMrpByItem[c.itemB] ?? (c.variantB ? c.variantB.mrp : null),
  }));

  // 5. Purchase suggestions and inventory requirements
  const result = generatePurchaseSuggestions({
    salesAnalysis: salesAnalysis.items,
    currentStockByItem: currentStock,
    config: validatedConfig,
  });

  // Dead stock & zero stock identification for resolved items
  const soldItemNames = new Set(Object.keys(salesAnalysis.items));
  const neverSold = Object.entries(currentStock).filter(([itemName]) => !soldItemNames.has(itemName));

  const deadStockCandidates = neverSold
    .filter(([, entry]) => entry.quantity > 0)
    .map(([itemName, entry]) => ({ itemName, currentStock: entry.quantity }))
    .sort((a, b) => b.currentStock - a.currentStock);

  const zeroStockNeverSold = neverSold
    .filter(([, entry]) => entry.quantity === 0)
    .map(([itemName]) => ({ itemName }));

  // 6. Summary metrics calculation
  const buyNowCount = result.suggestions.filter((s) => s.classification === 'BUY_NOW').length;
  const watchCount = result.suggestions.filter((s) => s.classification === 'WATCH').length;
  const okCount = result.suggestions.filter((s) => s.classification === 'OK').length;
  const deadStockCount = deadStockCandidates.length;
  const negativeStockCount = stockParsed.negativeStockItems.length;
  const matchRequiredCount = identityResolution.unresolvedItems.length;
  const reviewCount =
    negativeStockCount +
    result.dataQualityNotes.length +
    matchRequiredCount +
    pendingCandidatesWithPrices.length;

  const totalItems = Object.keys(currentStock).length + result.dataQualityNotes.length + matchRequiredCount;

  const analysisGeneratedAt = new Date().toISOString();

  // 7. Structured V1.1 Analysis Result
  return {
    analysisGeneratedAt,

    config: result.config,

    // V1.1 Name Resolution Ledger & Validation Report
    nameResolution: {
      summary: identityResolution.summary,
      validationReport: identityResolution.validationReport,
      pendingCandidates: pendingCandidatesWithPrices,
      persistentMappings: ledger.getAllMerges(),
      persistentSeparates: ledger.getAllSeparates(),
    },

    summary: {
      totalItems,
      buyNowCount,
      watchCount,
      okCount,
      reviewCount,
      deadStockCount,
      negativeStockCount,
      zeroStockCount: zeroStockNeverSold.length,
      matchRequiredCount,
      pendingCandidatesCount: pendingCandidatesWithPrices.length,
    },

    suggestions: result.suggestions,

    review: {
      matchRequiredItems: identityResolution.unresolvedItems,
      negativeStockItems: stockParsed.negativeStockItems,
      deadStockCandidates,
      zeroStockNeverSold,
      unresolvedNameVariants: identityResolution.unresolvedItems,
      suggestedMerges: pendingCandidatesWithPrices,
      dataQualityNotes: result.dataQualityNotes,
    },

    meta: {
      salesPeriod: salesAnalysis.dateRange,
      stockSnapshotDate: stockParsed.generationDate,
      trendWindowDays: salesAnalysis.trendWindowDays,
      flaggedRows: {
        sale: saleParsed.flagged,
        stockDetail: stockParsed.flagged,
      },
      mergedItemGroups,
      nameResolutionSummary: identityResolution.summary,
      negativeStockItems: stockParsed.negativeStockItems,
      deadStockCandidates,
      zeroStockNeverSold,
    },

    dataQualityNotes: result.dataQualityNotes,
  };
}

module.exports = { runAnalysis };
