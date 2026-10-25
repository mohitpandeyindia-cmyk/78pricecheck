const fs = require('fs');
const path = require('path');
const { generatePurchaseSuggestions } = require('../purchaseSuggestions');
const { runAnalysis } = require('../index');

console.log('================================================================');
console.log('  1. RUNTIME PRODUCTION FORMULA AUDIT FOR BRIT TRT JIMJAM 57 GM ');
console.log('================================================================\n');

// 1. Case A: Real-export inputs
const resReal = generatePurchaseSuggestions({
  salesAnalysis: {
    'BRIT TRT JIMJAM 57 GM': {
      totalSold: 85,
      periodDays: 189,
      fullPeriodAvgDailyDemand: 0.449735,
      recentAvgDailyDemand: null,
      priorAvgDailyDemand: null,
      dailyStdDev: 1.0738,
      trend: 'stable',
    },
  },
  currentStockByItem: { 'BRIT TRT JIMJAM 57 GM': { quantity: 0, asOfDate: new Date() } },
  config: { leadTimeDays: 3, orderCoverageDays: 15, serviceLevel: 0.95, watchThresholdFactor: 1.25 },
});

const sugReal = resReal.suggestions[0];
console.log('--- Case A: Real-Export Inputs (EDD = 0.4497, σ = 1.0738, L = 3, C = 15, Stock = 0) ---');
console.log('Selected Z-Score:', sugReal.serviceLevel, '-> Z = 1.65');
console.log('Raw Safety Stock: 1.65 * 1.0738 * sqrt(3) =', (1.65 * 1.0738 * Math.sqrt(3)).toFixed(6));
console.log('Final Integer SS: ceilClean(...) =', sugReal.safetyStock);
console.log('Raw ROP Expression: 0.4497 * 3 + ' + sugReal.safetyStock + ' =', (0.449735 * 3 + sugReal.safetyStock).toFixed(6));
console.log('Final Integer ROP: ceilClean(...) =', sugReal.reorderPoint);
console.log('Raw Target Expression: 0.4497 * 15 + ' + sugReal.safetyStock + ' =', (0.449735 * 15 + sugReal.safetyStock).toFixed(6));
console.log('Final Integer TS: ceilClean(...) =', sugReal.targetStock);
console.log('Suggested Order Qty (Q): max(0, ceilClean(TS - Stock)) =', sugReal.suggestedOrderQty);
console.log('Classification Status:', sugReal.classification);
console.log('Older Continuous Engine Output (Historical): SS = 3.06, ROP = 4.41, TS = 9.81, Q = 10\n');

// 2. Case B: Boundary-test inputs
const resBoundary = generatePurchaseSuggestions({
  salesAnalysis: {
    'BRIT TRT JIMJAM 57 GM': {
      totalSold: 85,
      periodDays: 189,
      fullPeriodAvgDailyDemand: 0.45,
      recentAvgDailyDemand: null,
      priorAvgDailyDemand: null,
      dailyStdDev: 0.589,
      trend: 'stable',
    },
  },
  currentStockByItem: { 'BRIT TRT JIMJAM 57 GM': { quantity: 0, asOfDate: new Date() } },
  config: { leadTimeDays: 3, orderCoverageDays: 15, serviceLevel: 0.95, watchThresholdFactor: 1.25 },
});

const sugBoundary = resBoundary.suggestions[0];
console.log('--- Case B: Boundary-Test Inputs (EDD = 0.45, σ = 0.589, L = 3, C = 15, Stock = 0) ---');
console.log('Selected Z-Score:', sugBoundary.serviceLevel, '-> Z = 1.65');
console.log('Raw Safety Stock: 1.65 * 0.589 * sqrt(3) =', (1.65 * 0.589 * Math.sqrt(3)).toFixed(6));
console.log('Final Integer SS: ceilClean(...) =', sugBoundary.safetyStock);
console.log('Raw ROP Expression: 0.45 * 3 + ' + sugBoundary.safetyStock + ' =', (0.45 * 3 + sugBoundary.safetyStock).toFixed(6));
console.log('Final Integer ROP: ceilClean(...) =', sugBoundary.reorderPoint);
console.log('Raw Target Expression: 0.45 * 15 + ' + sugBoundary.safetyStock + ' =', (0.45 * 15 + sugBoundary.safetyStock).toFixed(6));
console.log('Final Integer TS: ceilClean(...) =', sugBoundary.targetStock);
console.log('Suggested Order Qty (Q): max(0, ceilClean(TS - Stock)) =', sugBoundary.suggestedOrderQty);
console.log('Classification Status:', sugBoundary.classification);
console.log('Older Continuous Engine Output (Hypothetical): SS = 1.68, ROP = 3.03, TS = 8.43, Q = 9\n');

console.log('================================================================');
console.log('  2. WATCH BOUNDARY & INDEPENDENT QUANTITY VERIFICATION         ');
console.log('================================================================\n');

// With Case B parameters: EDD = 0.45, C = 15, SS = 2 -> TS = 9. ROP = 4, Watch Threshold = 4 * 1.25 = 5.0
const independentQtyTests = [
  { name: 'Stock 0 (Zero stock)', stock: 0, expectedClass: 'BUY_NOW', expectedQ: 9 },
  { name: 'Stock 3 (Below ROP)', stock: 3, expectedClass: 'BUY_NOW', expectedQ: 6 },
  { name: 'Stock 4 (Exactly at ROP)', stock: 4, expectedClass: 'WATCH', expectedQ: 5 },
  { name: 'Stock 5 (Exactly at Watch Limit)', stock: 5, expectedClass: 'WATCH', expectedQ: 4 },
  { name: 'Negative Stock -5 (Clamped for ordering)', stock: -5, expectedClass: 'BUY_NOW', expectedQ: 9, expectPreservedStock: -5 },
  { name: 'Fractional Stock 2.4 (Below ROP)', stock: 2.4, expectedClass: 'BUY_NOW', expectedQ: 7 },
  { name: 'Stock 9 (At Target Stock)', stock: 9, expectedClass: 'OK', expectedQ: 0 },
  { name: 'Stock 10 (Above Target Stock)', stock: 10, expectedClass: 'OK', expectedQ: 0 },
];

for (const t of independentQtyTests) {
  const r = generatePurchaseSuggestions({
    salesAnalysis: {
      'ITEM': { totalSold: 85, periodDays: 189, fullPeriodAvgDailyDemand: 0.45, recentAvgDailyDemand: null, priorAvgDailyDemand: null, dailyStdDev: 0.589, trend: 'stable' }
    },
    currentStockByItem: { 'ITEM': { quantity: t.stock, asOfDate: new Date() } },
    config: { leadTimeDays: 3, orderCoverageDays: 15, serviceLevel: 0.95, watchThresholdFactor: 1.25 }
  });
  const sug = r.suggestions[0];
  const classPass = sug.classification === t.expectedClass;
  const qPass = sug.suggestedOrderQty === t.expectedQ;
  const stockPreservedPass = t.expectPreservedStock !== undefined ? sug.currentStock === t.expectPreservedStock : true;
  console.log(`- ${t.name}: Class = ${sug.classification} (${classPass ? 'PASS' : 'FAIL'}), Q = ${sug.suggestedOrderQty} (Expected: ${t.expectedQ} -> ${qPass ? 'PASS' : 'FAIL'})${t.expectPreservedStock !== undefined ? `, currentStock = ${sug.currentStock} (${stockPreservedPass ? 'PASS' : 'FAIL'})` : ''}`);
}

console.log('\n================================================================');
console.log('  3. EPSILON & CEILCLEAN NUMERICAL BEHAVIOR                     ');
console.log('================================================================\n');

const testVals = [
  { val: 5.999999, note: 'Just below 6.0' },
  { val: 6.0, note: 'Exact integer 6.0' },
  { val: 6.000000000000001, note: 'IEEE-754 precision noise above 6.0 (6 + 1e-15)' },
  { val: 6.000000001, note: 'Small epsilon noise (6 + 1e-9)' },
  { val: 6.00001, note: 'Legitimate value above 6.0 (should ceil to 7)' },
  { val: 6.1, note: 'Legitimate fractional value above 6.0 (should ceil to 7)' },
  { val: 1.683, note: 'Case B SS raw' },
  { val: 3.058, note: 'Case A SS raw' },
];

function ceilCleanRef(val) {
  if (typeof val !== 'number' || isNaN(val)) return 0;
  return Math.max(0, Math.ceil(val - 1e-9));
}

for (const tv of testVals) {
  const rawCeil = Math.ceil(tv.val);
  const cleanCeil = ceilCleanRef(tv.val);
  console.log(`Value: ${tv.val.toString().padEnd(20)} | raw Math.ceil: ${rawCeil} | ceilClean: ${cleanCeil} | Note: ${tv.note}`);
}

console.log('\n================================================================\n');
