const fs = require('fs');
const path = require('path');
const { runAnalysis } = require('../index');

console.log('================================================================');
console.log('  GENERATING FULL SKU-LEVEL CLASSIFICATION TRANSITION AUDIT     ');
console.log('================================================================\n');

const downloadsDir = 'C:/Users/Admin/Downloads';
const saleReportPath = path.join(downloadsDir, 'SaleReport_01_04_26_to_31_10_26.xlsx');
const purchaseReportPath = path.join(downloadsDir, 'PurchaseReport_01_04_26_to_31_10_26.xlsx');
const stockDetailPath = path.join(downloadsDir, 'StockDetailReport_01_04_26_to_06_10_26.xlsx');

const startTime = Date.now();
const res = runAnalysis({
  saleReportPath,
  purchaseReportPath,
  stockDetailPath,
});
console.log(`Analysis executed in ${((Date.now() - startTime) / 1000).toFixed(1)}s\n`);

const z = 1.65;
const L = 3;
const C = 15;
const watchFactor = 1.25;

const artifactDir = 'C:/Users/Admin/.gemini/antigravity/brain/7d63a9ee-4b89-41d2-99bd-34505d5d1728';
const csvPath = path.join(artifactDir, 'sku_classification_transitions.csv');

const csvHeader = [
  'ItemName',
  'ItemCode',
  'CurrentStock',
  'EDD',
  'DailyStdDev',
  'OldClassification',
  'NewClassification',
  'OldSafetyStock',
  'NewSafetyStock',
  'OldROP',
  'NewROP',
  'OldTargetStock',
  'NewTargetStock',
  'OldSuggestedQty',
  'NewSuggestedQty',
  'TransitionType',
  'TransitionReason'
].join(',');

const csvRows = [csvHeader];

const transitionCounts = {
  'OK -> OK': 0,
  'OK -> WATCH': 0,
  'OK -> BUY_NOW': 0,
  'WATCH -> WATCH': 0,
  'WATCH -> BUY_NOW': 0,
  'WATCH -> OK': 0,
  'BUY_NOW -> BUY_NOW': 0,
  'BUY_NOW -> WATCH': 0,
  'BUY_NOW -> OK': 0,
};

let oldBuyNow = 0, oldWatch = 0, oldOk = 0;
let newBuyNow = 0, newWatch = 0, newOk = 0;

const skuSet = new Set();
let duplicates = 0;

res.suggestions.forEach(item => {
  if (skuSet.has(item.itemName)) {
    duplicates++;
  }
  skuSet.add(item.itemName);

  const stock = item.currentStock;
  const edd = item.effectiveDailyDemand;
  const sigma = item.demandVariability || 0;

  // Reconstruct old continuous calculation using the actual unrounded production baseline
  const ssRaw = z * sigma * Math.sqrt(L);
  const ropRaw = edd * L + ssRaw;
  const tsRaw = edd * C + ssRaw;
  const operationalStock = Math.max(0, stock);

  let oldClass = 'OK';
  let oldQty = 0;
  if (stock < ropRaw && edd > 0) {
    oldClass = 'BUY_NOW';
    oldQty = Math.max(0, Math.ceil(tsRaw - operationalStock));
  } else if (stock <= ropRaw * watchFactor && ropRaw > 0) {
    oldClass = 'WATCH';
    oldQty = Math.max(0, Math.ceil(tsRaw - operationalStock));
  } else {
    oldClass = 'OK';
    oldQty = edd > 0 ? Math.max(0, Math.ceil(tsRaw - operationalStock)) : 0;
  }

  const oldSS = Math.round(ssRaw * 100) / 100;
  const oldROP = Math.round(ropRaw * 100) / 100;
  const oldTS = Math.round(tsRaw * 100) / 100;

  // Count old
  if (oldClass === 'BUY_NOW') oldBuyNow++;
  else if (oldClass === 'WATCH') oldWatch++;
  else oldOk++;

  // New values
  const newClass = item.classification;
  const newSS = item.safetyStock;
  const newROP = item.reorderPoint;
  const newTS = item.targetStock;
  const newQty = item.suggestedOrderQty;

  // Count new
  if (newClass === 'BUY_NOW') newBuyNow++;
  else if (newClass === 'WATCH') newWatch++;
  else newOk++;

  const transKey = `${oldClass} -> ${newClass}`;
  transitionCounts[transKey] = (transitionCounts[transKey] || 0) + 1;

  let reason = 'Threshold unchanged or stock distant from boundary';
  if (transKey === 'OK -> WATCH') {
    reason = `Stock (${stock}) entered watch zone because ROP ceiled from ${oldROP} to ${newROP} (watch ceiling increased from ${(oldROP * watchFactor).toFixed(2)} to ${(newROP * watchFactor).toFixed(2)})`;
  } else if (transKey === 'WATCH -> BUY_NOW') {
    reason = `Stock (${stock}) fell below ROP because ROP ceiled from ${oldROP} to ${newROP} (stock ${stock} < ${newROP})`;
  } else if (transKey === 'OK -> BUY_NOW') {
    reason = `Stock (${stock}) fell directly into BUY NOW because ROP ceiled from ${oldROP} to ${newROP} (stock ${stock} < ${newROP})`;
  }

  const row = [
    `"${item.itemName.replace(/"/g, '""')}"`,
    `"${item.itemCode || ''}"`,
    stock,
    edd,
    sigma,
    oldClass,
    newClass,
    oldSS,
    newSS,
    oldROP,
    newROP,
    oldTS,
    newTS,
    oldQty,
    newQty,
    `"${transKey}"`,
    `"${reason}"`
  ].join(',');

  csvRows.push(row);
});

fs.writeFileSync(csvPath, csvRows.join('\n'), 'utf8');

console.log('--- 1. Population & Integrity Check ---');
console.log(`Total Canonical Active SKUs: ${res.suggestions.length}`);
console.log(`Unique SKU Names in Output: ${skuSet.size}`);
console.log(`Duplicate SKUs Encountered: ${duplicates}`);
console.log(`CSV Export Written To: ${csvPath} (${(fs.statSync(csvPath).size / 1024).toFixed(1)} KB)`);

console.log('\n--- 2. Overall Population Counts Before & After ---');
console.log(`Old Classification: BUY NOW = ${oldBuyNow}, WATCH = ${oldWatch}, OK = ${oldOk} (Total = ${oldBuyNow + oldWatch + oldOk})`);
console.log(`New Classification: BUY NOW = ${newBuyNow}, WATCH = ${newWatch}, OK = ${newOk} (Total = ${newBuyNow + newWatch + newOk})`);
console.log(`Delta: BUY NOW: ${newBuyNow - oldBuyNow > 0 ? '+' : ''}${newBuyNow - oldBuyNow}, WATCH: ${newWatch - oldWatch > 0 ? '+' : ''}${newWatch - oldWatch}, OK: ${newOk - oldOk}`);

console.log('\n--- 3. Exact Transition Counts By Pair ---');
for (const [pair, count] of Object.entries(transitionCounts)) {
  console.log(`  ${pair.padEnd(20)}: ${count} SKUs`);
}

console.log('\n================================================================\n');
