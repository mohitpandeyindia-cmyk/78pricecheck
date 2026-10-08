const fs = require('fs');
const {
  parseSaleReport,
  parsePurchaseReport,
  parseStockDetailReport,
  getCurrentStockByItem,
  computeAvgMrpByItem,
  computeAvgPriceByItem,
} = require('./reportReaders');
const { analyzeSalesPatterns } = require('./salesAnalysis');
const { generatePurchaseSuggestions, validateConfig } = require('./purchaseSuggestions');
const { resolveCatalogIdentity, CatalogLedger } = require('./nameResolver');
const { loadMrpMaster, getMasterMrp } = require('./mrpMaster');
const { reconstructAllStockHistory } = require('./stockReconstruction');

/**
 * Full V2 Foundation pipeline:
 * Sale Report + Purchase Report + Stock Detail Report + MRP Master ->
 * Identity Resolution -> Historical Stock Reconstruction -> Availability-Aware Demand ->
 * Existing V1 Reorder Model & Suggestions.
 *
 * @param {Object} input
 * @param {string} input.saleReportPath - path to Vyapar Sale Report Excel file
 * @param {string} input.stockDetailPath - path to Vyapar Stock Detail Report Excel file
 * @param {string} [input.purchaseReportPath] - optional path to Vyapar Purchase Report Excel file
 * @param {Object} [config] - optional configuration (leadTimeDays, reviewFrequencyDays, orderCoverageDays, serviceLevel, etc.)
 */
function runAnalysis({ saleReportPath, stockDetailPath, purchaseReportPath } = {}, config = {}) {
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

  // Optional Purchase Report validation
  const hasPurchaseReport = Boolean(purchaseReportPath && fs.existsSync(purchaseReportPath));

  // Validate config early
  const validatedConfig = validateConfig(config);

  // 2. Parse raw reports (captures actual date ranges from workbook contents)
  const saleParsed = parseSaleReport(saleReportPath);
  const stockParsed = parseStockDetailReport(stockDetailPath);
  const purchaseParsed = hasPurchaseReport ? parsePurchaseReport(purchaseReportPath) : { records: [], flagged: [], dateRange: null };

  // 3. V1.1 / V2 Cross-Report Name Resolution with Authoritative MRP Master & Item Codes
  const ledger = new CatalogLedger();
  const mrpMasterData = loadMrpMaster({ customPath: config.mrpMasterPath });
  const identityResolution = resolveCatalogIdentity({
    saleRecords: saleParsed.records,
    stockRecords: stockParsed.records,
    purchaseRecords: purchaseParsed.records,
    ledger,
    runtimeManualMappings: config.manualNameMappings || [],
    runtimeRejectedMerges: config.rejectedMerges || [],
    masterCatalogMap: config.masterCatalogMap || null,
    mrpMaster: mrpMasterData,
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
  const resolvedPurchaseRecords = purchaseParsed.records.map((r) => ({
    ...r,
    itemName: identityResolution.resolveRawNameToCanonical(r.rawItemName || r.itemName),
  }));

  // Filter out unresolved identity items from downstream reorder calculations
  const filteredStockRecords = resolvedStockRecords.filter(
    (r) => !unresolvedCanonicalSet.has(r.itemName)
  );
  const filteredSaleRecords = resolvedSaleRecords.filter(
    (r) => !unresolvedCanonicalSet.has(r.itemName)
  );
  const filteredPurchaseRecords = resolvedPurchaseRecords.filter(
    (r) => !unresolvedCanonicalSet.has(r.itemName)
  );

  const { currentStock, mergedItemGroups } = getCurrentStockByItem(filteredStockRecords);

  // 4. Historical Stock Reconstruction Layer (V2 Movement-Type-Aware Ledger)
  let reconstructedStockMap = null;
  if (hasPurchaseReport || filteredPurchaseRecords.length > 0) {
    reconstructedStockMap = reconstructAllStockHistory({
      saleRecords: filteredSaleRecords,
      purchaseRecords: filteredPurchaseRecords,
      stockRecords: filteredStockRecords,
      mrpMaster: mrpMasterData,
      resolveToCanonical: (name) => identityResolution.resolveRawNameToCanonical(name),
    });
  }

  // 5. Sales analysis with automatic trend window and availability-aware demand
  const salesAnalysis = analyzeSalesPatterns(filteredSaleRecords, {
    trendWindowDays: config.trendWindowDays,
    reconstructedMap: reconstructedStockMap,
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

  // 6. Purchase suggestions and inventory requirements (Existing V1 math preserved)
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

  // 7. Authoritative Reference Default MRP attachment from master catalog
  if (!mrpMasterData || !mrpMasterData.loaded) {
    // If not loaded earlier, attempt to reload
  }

  // Map item codes and aliases by canonical SKU
  const itemCodesByCanonical = new Map();
  for (const r of [...resolvedStockRecords, ...resolvedSaleRecords]) {
    if (r.itemCode && r.itemName) {
      if (!itemCodesByCanonical.has(r.itemName)) itemCodesByCanonical.set(r.itemName, new Set());
      itemCodesByCanonical.get(r.itemName).add(r.itemCode);
    }
  }

  const aliasesByCanonical = new Map();
  if (Array.isArray(identityResolution.validationReport)) {
    for (const v of identityResolution.validationReport) {
      const aliasSet = new Set();
      (v.salesVariants || []).forEach((sv) => sv.rawName && aliasSet.add(sv.rawName));
      (v.stockVariants || []).forEach((sv) => sv.rawName && aliasSet.add(sv.rawName));
      aliasesByCanonical.set(v.canonicalName, [...aliasSet]);
    }
  }

  // Attach reference Default MRP to suggestions
  result.suggestions.forEach((item) => {
    const codes = itemCodesByCanonical.get(item.itemName);
    const primaryCode = codes && codes.size > 0 ? [...codes][0] : null;
    const aliases = aliasesByCanonical.get(item.itemName) || [];
    const resolvedMrp = getMasterMrp({
      itemCode: primaryCode,
      canonicalName: item.itemName,
      itemName: item.itemName,
      aliases,
      fallbackMrp: avgMrpByItem[item.itemName] ?? null,
    }, mrpMasterData);
    item.mrp = resolvedMrp;
    item.itemCode = primaryCode;
  });

  // Attach reference Default MRP to review items
  deadStockCandidates.forEach((d) => {
    const codes = itemCodesByCanonical.get(d.itemName);
    const primaryCode = codes && codes.size > 0 ? [...codes][0] : null;
    d.mrp = getMasterMrp({
      itemCode: primaryCode,
      canonicalName: d.itemName,
      itemName: d.itemName,
      aliases: aliasesByCanonical.get(d.itemName) || [],
      fallbackMrp: avgMrpByItem[d.itemName] ?? null,
    }, mrpMasterData);
    d.itemCode = primaryCode;
  });

  zeroStockNeverSold.forEach((z) => {
    const codes = itemCodesByCanonical.get(z.itemName);
    const primaryCode = codes && codes.size > 0 ? [...codes][0] : null;
    z.mrp = getMasterMrp({
      itemCode: primaryCode,
      canonicalName: z.itemName,
      itemName: z.itemName,
      fallbackMrp: avgMrpByItem[z.itemName] ?? null,
    }, mrpMasterData);
    z.itemCode = primaryCode;
  });

  stockParsed.negativeStockItems.forEach((n) => {
    n.mrp = getMasterMrp({
      itemCode: n.itemCode || null,
      canonicalName: n.itemName,
      itemName: n.itemName,
      fallbackMrp: avgMrpByItem[n.itemName] ?? null,
    }, mrpMasterData);
  });

  identityResolution.unresolvedItems.forEach((u) => {
    u.mrp = getMasterMrp({
      canonicalName: u.canonicalName,
      itemName: u.canonicalName,
      fallbackMrp: avgMrpByItem[u.canonicalName] ?? null,
    }, mrpMasterData);
  });

  result.dataQualityNotes.forEach((q) => {
    q.mrp = getMasterMrp({
      canonicalName: q.itemName,
      itemName: q.itemName,
      fallbackMrp: avgMrpByItem[q.itemName] ?? null,
    }, mrpMasterData);
  });

  if (Array.isArray(identityResolution.validationReport)) {
    identityResolution.validationReport.forEach((rep) => {
      rep.mrp = getMasterMrp({
        canonicalName: rep.canonicalName,
        itemName: rep.canonicalName,
        aliases: (rep.salesVariants || []).map((v) => v.rawName),
        fallbackMrp: avgMrpByItem[rep.canonicalName] ?? null,
      }, mrpMasterData);
    });
  }

  const analysisGeneratedAt = new Date().toISOString();

  // 8. Structured V1.1 Analysis Result
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
      stockSnapshotDateSource: stockParsed.snapshotDateSource || (stockParsed.generationDate ? 'title' : 'not provided by export'),
      trendWindowDays: salesAnalysis.trendWindowDays,
      dataCoverage: {
        sale: saleParsed.dateRange,
        purchase: purchaseParsed.dateRange,
        stockSnapshotDate: stockParsed.generationDate,
        hasPurchaseReport,
        mrpMasterCount: mrpMasterData ? mrpMasterData.count : 0,
      },
      mrpMaster: {
        loaded: mrpMasterData.loaded,
        sourceFile: mrpMasterData.sourceFile,
        count: mrpMasterData.count,
      },
      flaggedRows: {
        sale: saleParsed.flagged,
        stockDetail: stockParsed.flagged,
        purchase: purchaseParsed.flagged,
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
