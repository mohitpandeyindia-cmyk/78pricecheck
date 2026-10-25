const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { parseSaleReport, parsePurchaseReport, parseStockDetailReport } = require('../reportReaders');
const { resolveCatalogIdentity, CatalogLedger } = require('../nameResolver');
const { reconstructSkuStock, toDayKey } = require('../stockReconstruction');
const { analyzeSalesPatterns, detectTrend } = require('../salesAnalysis');

const downloadsDir = 'C:/Users/Admin/Downloads';
const saleReportPath = path.join(downloadsDir, 'SaleReport_01_04_26_to_31_10_26.xlsx');
const purchaseReportPath = path.join(downloadsDir, 'PurchaseReport_01_04_26_to_31_10_26.xlsx');
const stockDetailPath = path.join(downloadsDir, 'StockDetailReport_01_04_26_to_06_10_26.xlsx');

console.log('Loading source reports...');
const saleParsed = parseSaleReport(saleReportPath);
const purchaseParsed = parsePurchaseReport(purchaseReportPath);
const stockParsed = parseStockDetailReport(stockDetailPath);

const ledger = new CatalogLedger();
const identityResolution = resolveCatalogIdentity({
  saleRecords: saleParsed.records,
  stockRecords: stockParsed.records,
  purchaseRecords: purchaseParsed.records,
  ledger,
});

const jimjamCanonical = 'BRIT TRT JIMJAM 57 GM';

// Filter records for JIMJAM
const jimjamSales = saleParsed.records
  .filter(r => identityResolution.resolveRawNameToCanonical(r.itemName) === jimjamCanonical)
  .map(r => ({ ...r, itemName: jimjamCanonical, transactionType: 'Sale' }));

const jimjamPurchases = purchaseParsed.records
  .filter(r => identityResolution.resolveRawNameToCanonical(r.rawItemName || r.itemName) === jimjamCanonical)
  .map(r => ({ ...r, itemName: jimjamCanonical, transactionType: r.transactionType || 'Purchase' }));

const jimjamStock = stockParsed.records.find(
  r => identityResolution.resolveRawNameToCanonical(r.rawItemName || r.itemName) === jimjamCanonical
);

console.log(`Found ${jimjamSales.length} sale transactions, ${jimjamPurchases.length} purchase transactions.`);
console.log('Stock Detail Record:', jimjamStock);

// Run stock reconstruction for JIMJAM across the analysis period
const periodBounds = saleParsed.dateRange; // 01-Apr-2026 to 06-Oct-2026 (189 days)
const movements = [...jimjamSales, ...jimjamPurchases];

const recon = reconstructSkuStock({
  skuKey: jimjamStock?.itemCode || 'BRIT-JIMJAM',
  itemName: jimjamCanonical,
  itemCode: jimjamStock?.itemCode,
  openingStock: jimjamStock?.beginningQuantity || 0,
  hasExplicitOpeningEvidence: false,
  stockDetailClosing: jimjamStock?.closingQuantity !== undefined ? jimjamStock.closingQuantity : 0,
  stockDetailIn: jimjamStock?.quantityIn !== undefined ? jimjamStock.quantityIn : null,
  stockDetailOut: jimjamStock?.quantityOut !== undefined ? jimjamStock.quantityOut : null,
  movements,
  periodBounds,
});

console.log('\n--- Reconstructed Stock Summary ---');
console.log(`Analysis Period: ${recon.metrics.analysisPeriodDays} days`);
console.log(`Available Days: ${recon.metrics.availableDays}`);
console.log(`Stockout Days: ${recon.metrics.stockoutDays}`);
console.log(`Unknown Days: ${recon.metrics.unknownDays}`);
console.log(`Confidence: ${recon.metrics.availabilityConfidence}`);
console.log(`Reconciliation Status: ${recon.reconciliationStatus} (Difference: ${recon.reconciliationDifference})`);

// Window partition verification
const periodDays = recon.dailyStates.length;
const trendWindowDays = Math.floor(periodDays / 2); // 94 days
const recentStates = recon.dailyStates.slice(-trendWindowDays);
const priorStates = recon.dailyStates.slice(-trendWindowDays * 2, -trendWindowDays);
const unpairedState = recon.dailyStates[0];

const priorAvail = priorStates.filter(s => s.status === 'AVAILABLE').length;
const priorStockout = priorStates.filter(s => s.status === 'STOCKOUT').length;
const priorUnknown = priorStates.filter(s => s.status === 'UNKNOWN').length;

const recentAvail = recentStates.filter(s => s.status === 'AVAILABLE').length;
const recentStockout = recentStates.filter(s => s.status === 'STOCKOUT').length;
const recentUnknown = recentStates.filter(s => s.status === 'UNKNOWN').length;

console.log('\n--- Trend Window Availability Counts ---');
console.log(`Unpaired initial day (${unpairedState.dayKey}): status = ${unpairedState.status}`);
console.log(`Prior window (${priorStates[0].dayKey} to ${priorStates[priorStates.length - 1].dayKey}, ${trendWindowDays} days):`);
console.log(`  AVAILABLE = ${priorAvail}, STOCKOUT = ${priorStockout}, UNKNOWN = ${priorUnknown}`);
console.log(`  Sum: ${priorAvail + priorStockout + priorUnknown} === ${trendWindowDays}`);

console.log(`Recent window (${recentStates[0].dayKey} to ${recentStates[recentStates.length - 1].dayKey}, ${trendWindowDays} days):`);
console.log(`  AVAILABLE = ${recentAvail}, STOCKOUT = ${recentStockout}, UNKNOWN = ${recentUnknown}`);
console.log(`  Sum: ${recentAvail + recentStockout + recentUnknown} === ${trendWindowDays}`);

assert.strictEqual(priorAvail + priorStockout + priorUnknown, 94, 'Prior window sum must equal 94');
assert.strictEqual(recentAvail + recentStockout + recentUnknown, 94, 'Recent window sum must equal 94');
assert.strictEqual(recon.metrics.availableDays + recon.metrics.stockoutDays + recon.metrics.unknownDays, 189, 'Overall sum must equal 189');

// Generate machine-readable JSON containing all 189 daily records
const dailyRecordsOutput = recon.dailyStates.map((s, idx) => ({
  dayIndex: idx + 1,
  date: s.dayKey,
  datedPurchases: s.purchases,
  debitNotes: s.debitNotes,
  grossSales: s.sales,
  creditNotes: s.creditNotes,
  undatedInwardConstraint: s.undatedInwardConstraint,
  dayStartStock: s.dayStartStock,
  estimatedEndingStock: s.estimatedEndingStock,
  rawMinFeasibleStock: s.rawMinFeasibleStock,
  rawMaxFeasibleStock: s.rawMaxFeasibleStock,
  minFeasibleStock: s.minFeasibleStock,
  maxFeasibleStock: s.maxFeasibleStock,
  availabilityState: s.status,
  rationale: s.rationale,
}));

const outputPath = path.join(__dirname, 'brit_trt_jimjam_189_daily_states.json');
fs.writeFileSync(outputPath, JSON.stringify(dailyRecordsOutput, null, 2), 'utf8');
console.log(`\nSuccessfully wrote 189 daily records to: ${outputPath}`);

// Also write a CSV version for convenience
const csvHeaders = 'dayIndex,date,datedPurchases,debitNotes,grossSales,creditNotes,undatedInwardConstraint,dayStartStock,estimatedEndingStock,rawMinFeasibleStock,rawMaxFeasibleStock,minFeasibleStock,maxFeasibleStock,availabilityState,rationale\n';
const csvRows = dailyRecordsOutput.map(r => 
  `${r.dayIndex},${r.date},${r.datedPurchases},${r.debitNotes},${r.grossSales},${r.creditNotes},${r.undatedInwardConstraint},${r.dayStartStock},${r.estimatedEndingStock},${r.rawMinFeasibleStock},${r.rawMaxFeasibleStock},${r.minFeasibleStock},${r.maxFeasibleStock},${r.availabilityState},"${r.rationale.replace(/"/g, '""')}"`
).join('\n');
const csvOutputPath = path.join(__dirname, 'brit_trt_jimjam_189_daily_states.csv');
fs.writeFileSync(csvOutputPath, csvHeaders + csvRows, 'utf8');
console.log(`Successfully wrote CSV version to: ${csvOutputPath}`);
