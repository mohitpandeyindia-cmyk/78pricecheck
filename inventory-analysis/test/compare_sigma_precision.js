const fs = require('fs');
const path = require('path');
const { parseSaleReport, parsePurchaseReport, parseStockDetailReport, getCurrentStockByItem } = require('../reportReaders');
const { resolveCatalogIdentity, CatalogLedger } = require('../nameResolver');
const { loadMrpMaster } = require('../mrpMaster');
const { reconstructAllStockHistory } = require('../stockReconstruction');
const { buildDailySeries, fillDailyValues, mean, stdDev } = require('../salesAnalysis');

function round2(n) {
  if (n === null || n === undefined || isNaN(n)) return null;
  return Math.round(n * 100) / 100;
}

function ceilClean(val) {
  if (typeof val !== 'number' || isNaN(val)) return 0;
  return Math.max(0, Math.ceil(val - 1e-9));
}

const downloadsDir = 'C:/Users/Admin/Downloads';
const saleReportPath = path.join(downloadsDir, 'SaleReport_01_04_26_to_31_10_26.xlsx');
const purchaseReportPath = path.join(downloadsDir, 'PurchaseReport_01_04_26_to_31_10_26.xlsx');
const stockDetailPath = path.join(downloadsDir, 'StockDetailReport_01_04_26_to_06_10_26.xlsx');

console.log('Loading and parsing canonical reports...');
const saleParsed = parseSaleReport(saleReportPath);
const stockParsed = parseStockDetailReport(stockDetailPath);
const purchaseParsed = parsePurchaseReport(purchaseReportPath);

console.log('Resolving catalog identities...');
const ledger = new CatalogLedger();
const mrpMasterData = loadMrpMaster({});
const identityResolution = resolveCatalogIdentity({
  saleRecords: saleParsed.records,
  stockRecords: stockParsed.records,
  purchaseRecords: purchaseParsed.records,
  ledger,
  mrpMaster: mrpMasterData,
});

const unresolvedCanonicalSet = new Set(
  identityResolution.unresolvedItems.map((u) => u.canonicalName)
);

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

const filteredStockRecords = resolvedStockRecords.filter(r => !unresolvedCanonicalSet.has(r.itemName));
const filteredSaleRecords = resolvedSaleRecords.filter(r => !unresolvedCanonicalSet.has(r.itemName));
const filteredPurchaseRecords = resolvedPurchaseRecords.filter(r => !unresolvedCanonicalSet.has(r.itemName));

const { currentStock } = getCurrentStockByItem(filteredStockRecords);

console.log('Reconstructing historical stock...');
const reconstructedStockMap = reconstructAllStockHistory({
  saleRecords: filteredSaleRecords,
  purchaseRecords: filteredPurchaseRecords,
  stockRecords: filteredStockRecords,
  mrpMaster: mrpMasterData,
  resolveToCanonical: (name) => identityResolution.resolveRawNameToCanonical(name),
  periodBounds: saleParsed.dateRange,
});

// Group sales using standard buildDailySeries
const { byItem, minDate, maxDate } = buildDailySeries(filteredSaleRecords);
const periodDays = saleParsed.dateRange.days;

console.log(`Analyzing ${byItem.size} active sold items across ${periodDays} days...`);

const z = 1.65;
const leadTimeDays = 3;
const orderCoverageDays = 15;
const watchThresholdFactor = 1.25;
const sqrtL = Math.sqrt(leadTimeDays);

let totalSKUsCompared = 0;
let diffSS = 0;
let diffROP = 0;
let diffTS = 0;
let diffQty = 0;
let diffClassification = 0;

const skuDifferences = [];
let jimjamComparison = null;

for (const [itemName, dayMap] of byItem.entries()) {
  const stockEntry = currentStock[itemName];
  if (!stockEntry) continue; // Skip items missing from stock detail (routed to Review)

  const dailyValues = fillDailyValues(dayMap, minDate, maxDate);
  const totalSold = dailyValues.reduce((a, b) => a + b, 0);

  const avgDailyDemand = mean(dailyValues);
  const dailyStdDevRaw = stdDev(dailyValues);
  const dailyStdDevRound = round2(dailyStdDevRaw);

  const recon = reconstructedStockMap.get(itemName) || null;
  let effectiveAvgDailyDemand = avgDailyDemand;

  if (recon && recon.metrics) {
    if (recon.metrics.availabilityConfidence === 'VERIFIED') {
      effectiveAvgDailyDemand = recon.metrics.averageDailyDemandWhileAvailable;
    } else {
      effectiveAvgDailyDemand = avgDailyDemand;
    }
  }

  const edd = round2(effectiveAvgDailyDemand);
  const currentPhysicalStock = stockEntry.quantity;
  const operationalStock = Math.max(0, currentPhysicalStock);

  // Method A: Full-precision sigma internally
  const ssRawA = z * dailyStdDevRaw * sqrtL;
  const ssA = ceilClean(ssRawA);
  const ropRawA = edd * leadTimeDays + ssA;
  const ropA = ceilClean(ropRawA);
  const tsRawA = edd * orderCoverageDays + ssA;
  const tsA = ceilClean(tsRawA);
  const qtyA = Math.max(0, ceilClean(tsA - operationalStock));
  let classA = 'OK';
  if (currentPhysicalStock < ropA && edd > 0) {
    classA = 'BUY_NOW';
  } else if (currentPhysicalStock <= ropA * watchThresholdFactor && ropA > 0) {
    classA = 'WATCH';
  }

  // Method B: Two-decimal rounded sigma
  const ssRawB = z * dailyStdDevRound * sqrtL;
  const ssB = ceilClean(ssRawB);
  const ropRawB = edd * leadTimeDays + ssB;
  const ropB = ceilClean(ropRawB);
  const tsRawB = edd * orderCoverageDays + ssB;
  const tsB = ceilClean(tsRawB);
  const qtyB = Math.max(0, ceilClean(tsB - operationalStock));
  let classB = 'OK';
  if (currentPhysicalStock < ropB && edd > 0) {
    classB = 'BUY_NOW';
  } else if (currentPhysicalStock <= ropB * watchThresholdFactor && ropB > 0) {
    classB = 'WATCH';
  }

  totalSKUsCompared++;

  const hasDiffSS = ssA !== ssB;
  const hasDiffROP = ropA !== ropB;
  const hasDiffTS = tsA !== tsB;
  const hasDiffQty = qtyA !== qtyB;
  const hasDiffClass = classA !== classB;

  if (hasDiffSS) diffSS++;
  if (hasDiffROP) diffROP++;
  if (hasDiffTS) diffTS++;
  if (hasDiffQty) diffQty++;
  if (hasDiffClass) diffClassification++;

  if (hasDiffSS || hasDiffROP || hasDiffTS || hasDiffQty || hasDiffClass) {
    skuDifferences.push({
      itemName,
      currentStock: currentPhysicalStock,
      edd,
      sigmaRaw: dailyStdDevRaw,
      sigmaRound: dailyStdDevRound,
      ssRawA: round2(ssRawA),
      ssRawB: round2(ssRawB),
      ssA,
      ssB,
      ropA,
      ropB,
      tsA,
      tsB,
      qtyA,
      qtyB,
      classA,
      classB,
    });
  }

  if (itemName === 'BRIT TRT JIMJAM 57 GM') {
    jimjamComparison = {
      itemName,
      currentStock: currentPhysicalStock,
      edd,
      sigmaRaw: dailyStdDevRaw,
      sigmaRound: dailyStdDevRound,
      ssRawA,
      ssRawB,
      ssA,
      ssB,
      ropA,
      ropB,
      tsA,
      tsB,
      qtyA,
      qtyB,
      classA,
      classB,
    };
  }
}

console.log('\n================================================================');
console.log('  GATE 2: SIGMA PRECISION IMPACT AUDIT RESULTS (6,138 SKUs)     ');
console.log('================================================================\n');

console.log(`Total Active SKUs Evaluated: ${totalSKUsCompared}`);
console.log(`SKUs with Different Safety Stock (SS): ${diffSS} (${((diffSS / totalSKUsCompared) * 100).toFixed(2)}%)`);
console.log(`SKUs with Different Reorder Point (ROP): ${diffROP} (${((diffROP / totalSKUsCompared) * 100).toFixed(2)}%)`);
console.log(`SKUs with Different Target Stock (TS): ${diffTS} (${((diffTS / totalSKUsCompared) * 100).toFixed(2)}%)`);
console.log(`SKUs with Different Suggested Order Qty (Q): ${diffQty} (${((diffQty / totalSKUsCompared) * 100).toFixed(2)}%)`);
console.log(`SKUs with Different Final Classification: ${diffClassification} (${((diffClassification / totalSKUsCompared) * 100).toFixed(2)}%)`);

if (jimjamComparison) {
  console.log('\n--- BRIT TRT JIMJAM 57 GM Specific Comparison ---');
  console.log(`Full-precision Sigma: ${jimjamComparison.sigmaRaw.toFixed(6)}`);
  console.log(`Rounded Sigma (2 dec): ${jimjamComparison.sigmaRound.toFixed(2)}`);
  console.log(`Method A (Full Precision): SS_raw=${jimjamComparison.ssRawA.toFixed(4)} -> SS=${jimjamComparison.ssA}, ROP=${jimjamComparison.ropA}, TS=${jimjamComparison.tsA}, Q=${jimjamComparison.qtyA}, Class=${jimjamComparison.classA}`);
  console.log(`Method B (Rounded 2 Dec): SS_raw=${jimjamComparison.ssRawB.toFixed(4)} -> SS=${jimjamComparison.ssB}, ROP=${jimjamComparison.ropB}, TS=${jimjamComparison.tsB}, Q=${jimjamComparison.qtyB}, Class=${jimjamComparison.classB}`);
  console.log(`Difference for JIMJAM: ${jimjamComparison.ssA === jimjamComparison.ssB ? 'NONE (Identical integer SS, ROP, TS, Q, Classification)' : 'DIFFERENT'}`);
}

console.log('\n--- Summary of SKUs with Output Differences ---');
console.log(`Total SKUs with ANY integer/classification difference: ${skuDifferences.length} out of ${totalSKUsCompared}`);

// Sort by absolute difference in Q or name
skuDifferences.sort((a, b) => Math.abs(b.qtyA - b.qtyB) - Math.abs(a.qtyA - a.qtyB));

console.log('\nSample differing SKUs (first 25):');
for (let i = 0; i < Math.min(25, skuDifferences.length); i++) {
  const d = skuDifferences[i];
  console.log(`- [${d.itemName}] Stock: ${d.currentStock}, EDD: ${d.edd}`);
  console.log(`    σ_raw: ${d.sigmaRaw.toFixed(5)} -> SS_raw: ${d.ssRawA} -> SS: ${d.ssA}, ROP: ${d.ropA}, TS: ${d.tsA}, Q: ${d.qtyA}, Class: ${d.classA}`);
  console.log(`    σ_rnd: ${d.sigmaRound.toFixed(2)} -> SS_raw: ${d.ssRawB} -> SS: ${d.ssB}, ROP: ${d.ropB}, TS: ${d.tsB}, Q: ${d.qtyB}, Class: ${d.classB}`);
}

fs.writeFileSync(
  path.join(__dirname, 'sigma_precision_differences.json'),
  JSON.stringify({ totalSKUsCompared, diffSS, diffROP, diffTS, diffQty, diffClassification, skuDifferences }, null, 2)
);
console.log(`\nFull difference report written to: ${path.join(__dirname, 'sigma_precision_differences.json')}`);
