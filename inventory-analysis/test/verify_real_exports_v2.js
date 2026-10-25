const path = require('path');
const { parseSaleReport, parsePurchaseReport, parseStockDetailReport } = require('../reportReaders');
const { runAnalysis } = require('../index');

console.log('================================================================');
console.log('  RUNNING FULL REAL-EXPORT PIPELINE PRE-DEPLOYMENT VERIFICATION ');
console.log('================================================================\n');

const downloadsDir = 'C:/Users/Admin/Downloads';
const saleReportPath = path.join(downloadsDir, 'SaleReport_01_04_26_to_31_10_26.xlsx');
const purchaseReportPath = path.join(downloadsDir, 'PurchaseReport_01_04_26_to_31_10_26.xlsx');
const stockDetailPath = path.join(downloadsDir, 'StockDetailReport_01_04_26_to_06_10_26.xlsx');

function toLocalDateString(d) {
  if (!d) return 'None';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// 1. Raw Row Counts and Date Windows
console.log('Parsing raw files to check row counts and date windows...');
const rawSales = parseSaleReport(saleReportPath);
const rawPurchases = parsePurchaseReport(purchaseReportPath);
const rawStock = parseStockDetailReport(stockDetailPath);

console.log('\n--- 1. Raw Report Metrics ---');
console.log(`Sale Report: ${rawSales.records.length} valid rows, date window: ${toLocalDateString(rawSales.dateRange?.from)} to ${toLocalDateString(rawSales.dateRange?.to)} (${rawSales.dateRange?.days} days)`);
console.log(`Purchase Report: ${rawPurchases.records.length} valid rows, date window: ${toLocalDateString(rawPurchases.dateRange?.from)} to ${toLocalDateString(rawPurchases.dateRange?.to)} (${rawPurchases.dateRange?.days} days)`);
console.log(`Stock Detail Report: ${rawStock.records.length} valid rows, snapshot date: ${rawStock.generationDate ? toLocalDateString(rawStock.generationDate) : 'None'}`);

// 2. Run Full Pipeline
console.log('\nRunning runAnalysis full pipeline...');
const startTime = Date.now();
const res = runAnalysis({
  saleReportPath,
  purchaseReportPath,
  stockDetailPath,
});
const durationMs = Date.now() - startTime;

console.log(`\nAnalysis completed in ${(durationMs / 1000).toFixed(1)}s`);

// 3. Population & Category Counts
console.log('\n--- 2. Population & Suggestion Counts ---');
console.log(`Total Canonical Active SKUs: ${res.suggestions.length}`);
console.log(`BUY NOW: ${res.summary.buyNowCount}`);
console.log(`WATCH: ${res.summary.watchCount}`);
console.log(`OK: ${res.summary.okCount}`);
console.log(`REVIEW (Dead Stock + Zero Stock + Negative): ${res.summary.reviewCount}`);
console.log(`  - Dead Stock: ${res.summary.deadStockCount}`);
console.log(`  - Zero Stock Never Sold: ${res.summary.zeroStockCount}`);
console.log(`  - Negative Stock: ${res.summary.negativeStockCount}`);
console.log(`  - Unresolved Name Matches Required: ${res.summary.matchRequiredCount}`);

// 4. Availability Confidence Breakdown
let verifiedCount = 0;
let boundedCount = 0;
let indeterminateCount = 0;
let reconMismatchCount = 0;

for (const s of res.suggestions) {
  if (s.availabilityConfidence === 'VERIFIED') verifiedCount++;
  else if (s.availabilityConfidence === 'BOUNDED') boundedCount++;
  else indeterminateCount++;

  if (s.reconciliationStatus === 'STOCK_RECONSTRUCTION_MISMATCH') {
    reconMismatchCount++;
  }
}

console.log('\n--- 3. Availability Confidence & Reconciliation Status ---');
console.log(`VERIFIED: ${verifiedCount} (${((verifiedCount / res.suggestions.length) * 100).toFixed(1)}%)`);
console.log(`BOUNDED: ${boundedCount} (${((boundedCount / res.suggestions.length) * 100).toFixed(1)}%)`);
console.log(`INDETERMINATE: ${indeterminateCount} (${((indeterminateCount / res.suggestions.length) * 100).toFixed(1)}%)`);
console.log(`Reconciliation Mismatches: ${reconMismatchCount} (${((reconMismatchCount / res.suggestions.length) * 100).toFixed(1)}%)`);
console.log(`Unresolved Identities Excluded: ${res.review.matchRequiredItems.length}`);

// 5. Snapshot Freshness Status
console.log('\n--- 4. Snapshot Freshness & Meta ---');
console.log(`Stock Snapshot Date: ${res.meta.stockSnapshotDate ? toLocalDateString(res.meta.stockSnapshotDate) : 'None'}`);
console.log(`Stock Snapshot Date Source: ${res.meta.stockSnapshotDateSource}`);
console.log(`Sales Analysis Period: ${toLocalDateString(res.meta.salesPeriod?.from)} to ${toLocalDateString(res.meta.salesPeriod?.to)} (${res.meta.salesPeriod?.days} days)`);
console.log(`Trend Window Length: ${res.meta.trendWindowDays} days`);
console.log(`MRP Master Loaded: ${res.meta.mrpMaster.loaded ? 'YES' : 'NO'} (${res.meta.mrpMaster.count} items)`);

// 6. BRIT TRT JIMJAM Exact Final Demand and Order Calculation
const jimjam = res.suggestions.find(s => s.itemName === 'BRIT TRT JIMJAM 57 GM');
if (jimjam) {
  console.log('\n--- 5. Exact SKU Calculation: BRIT TRT JIMJAM 57 GM ---');
  console.log(`Canonical Name: ${jimjam.itemName}`);
  console.log(`Item Code: ${jimjam.itemCode}`);
  console.log(`MRP: ${jimjam.mrp}`);
  console.log(`Current Operational Stock: ${jimjam.currentStock}`);
  console.log(`Classification: ${jimjam.classification}`);
  console.log(`Total Sold in Period: ${jimjam.totalSoldInPeriod} units`);
  console.log(`Calendar Avg Daily Demand: ${jimjam.calendarAvgDailyDemand} units/day`);
  console.log(`Effective Daily Demand: ${jimjam.effectiveDailyDemand} units/day`);
  console.log(`Demand Variability (σ): ${jimjam.demandVariability} units/day`);
  console.log(`Lead Time Days (L): ${jimjam.leadTimeDays}`);
  console.log(`Review Frequency Days (R): ${jimjam.reviewFrequencyDays}`);
  console.log(`Order Coverage Days (C): ${jimjam.orderCoverageDays}`);
  console.log(`Service Level (SL): ${jimjam.serviceLevel} (Z = 1.65)`);
  console.log(`Watch Threshold Factor: 1.25`);

  console.log('\n--- A. Calculation with REAL Data Standard Deviation (σ = 1.074) ---');
  const z = 1.65;
  const L = 3;
  const C = 15;
  const edd = jimjam.effectiveDailyDemand; // 0.45
  const sigmaReal = jimjam.demandVariability; // 1.07
  const ssRawReal = z * sigmaReal * Math.sqrt(L);
  const ssReal = Math.ceil(ssRawReal);
  const ropRawReal = edd * L + ssReal;
  const ropReal = Math.ceil(ropRawReal);
  const tsRawReal = edd * C + ssReal;
  const tsReal = Math.ceil(tsRawReal);
  const qReal = Math.max(0, Math.ceil(tsReal - Math.max(0, jimjam.currentStock)));
  console.log(`  Step 1: SS_raw = 1.65 * ${sigmaReal} * sqrt(3) = ${ssRawReal.toFixed(4)} -> SS = ceil(${ssRawReal.toFixed(4)}) = ${ssReal}`);
  console.log(`  Step 2: ROP_raw = ${edd} * 3 + ${ssReal} = ${ropRawReal.toFixed(4)} -> ROP = ceil(${ropRawReal.toFixed(4)}) = ${ropReal}`);
  console.log(`  Step 3: TS_raw = ${edd} * 15 + ${ssReal} = ${tsRawReal.toFixed(4)} -> TS = ceil(${tsRawReal.toFixed(4)}) = ${tsReal}`);
  console.log(`  Step 4: Q = max(0, ceil(${tsReal} - ${jimjam.currentStock})) = ${qReal}`);
  console.log(`  Engine Outputs: SS = ${jimjam.safetyStock}, ROP = ${jimjam.reorderPoint}, TS = ${jimjam.targetStock}, Q = ${jimjam.suggestedOrderQty}`);

  console.log('\n--- B. Calculation with Prompt Theoretical Standard Deviation (σ = 0.589) ---');
  const sigmaPrompt = 0.589;
  const ssRawPrompt = z * sigmaPrompt * Math.sqrt(L);
  const ssPrompt = Math.ceil(ssRawPrompt);
  const ropRawPrompt = edd * L + ssPrompt;
  const ropPrompt = Math.ceil(ropRawPrompt);
  const tsRawPrompt = edd * C + ssPrompt;
  const tsPrompt = Math.ceil(tsRawPrompt);
  const qPrompt = Math.max(0, Math.ceil(tsPrompt - Math.max(0, jimjam.currentStock)));
  console.log(`  Step 1: SS_raw = 1.65 * 0.589 * sqrt(3) = ${ssRawPrompt.toFixed(4)} -> SS = ceil(${ssRawPrompt.toFixed(4)}) = ${ssPrompt}`);
  console.log(`  Step 2: ROP_raw = 0.45 * 3 + ${ssPrompt} = ${ropRawPrompt.toFixed(4)} -> ROP = ceil(${ropRawPrompt.toFixed(4)}) = ${ropPrompt}`);
  console.log(`  Step 3: TS_raw = 0.45 * 15 + ${ssPrompt} = ${tsRawPrompt.toFixed(4)} -> TS = ceil(${tsRawPrompt.toFixed(4)}) = ${tsPrompt}`);
  console.log(`  Step 4: Q = max(0, ceil(${tsPrompt} - 0)) = ${qPrompt}`);

  console.log('\n--- C. Metadata & Availability ---');
  console.log(`Trend: ${jimjam.trend} (Reason: ${jimjam.trendReason || 'None'})`);
  console.log(`Availability Confidence: ${jimjam.availabilityConfidence}`);
  console.log(`Is Provisional: ${jimjam.isProvisional}`);
  console.log(`Provisional Reason: ${jimjam.provisionalReason}`);
  console.log(`Reconciliation Status: ${jimjam.reconciliationStatus} (Difference: ${jimjam.reconciliationDifference})`);
  console.log('Availability Summary:', {
    analysisPeriodDays: jimjam.availability.analysisPeriodDays,
    availableDays: jimjam.availability.availableDays,
    stockoutDays: jimjam.availability.stockoutDays,
    unknownDays: jimjam.availability.unknownDays,
  });
} else {
  console.log('\nJIMJAM SKU not found in suggestions.');
}

// 7. Population Transitions from Continuous to Integer Ceil
console.log('\n--- 6. SKU Classification Transition Analysis (Continuous -> Integer Ceil) ---');
let transitions = {
  'OK -> WATCH': [],
  'WATCH -> BUY_NOW': [],
  'OK -> BUY_NOW': [],
  'BUY_NOW -> WATCH': [],
  'WATCH -> OK': [],
  'BUY_NOW -> OK': [],
};

const z = 1.65;
const L = 3;
const watchFactor = 1.25;

res.suggestions.forEach(item => {
  // Reconstruct old continuous classification
  const ssRaw = z * (item.demandVariability || 0) * Math.sqrt(L);
  const ropRaw = item.effectiveDailyDemand * L + ssRaw;
  const stock = item.currentStock;
  const edd = item.effectiveDailyDemand;

  let oldClass = 'OK';
  if (stock < ropRaw && edd > 0) {
    oldClass = 'BUY_NOW';
  } else if (stock <= ropRaw * watchFactor && ropRaw > 0) {
    oldClass = 'WATCH';
  } else {
    oldClass = 'OK';
  }

  const newClass = item.classification;
  if (oldClass !== newClass) {
    const key = `${oldClass} -> ${newClass}`;
    if (transitions[key]) {
      transitions[key].push({
        itemName: item.itemName,
        stock,
        edd,
        sigma: item.demandVariability,
        ropRaw: Math.round(ropRaw * 100) / 100,
        ropCeil: item.reorderPoint,
        targetStockCeil: item.targetStock,
        orderQty: item.suggestedOrderQty,
      });
    }
  }
});

for (const [key, items] of Object.entries(transitions)) {
  console.log(`\nTransition ${key}: ${items.length} SKUs`);
  if (items.length > 0) {
    console.log(`  Sample SKUs (first 5):`);
    items.slice(0, 5).forEach(s => {
      console.log(`    - ${s.itemName}: Stock = ${s.stock}, EDD = ${s.edd}, ROP_raw = ${s.ropRaw} -> ROP_ceil = ${s.ropCeil}, Q = ${s.orderQty}`);
    });
  }
}

console.log('\n================================================================\n');
