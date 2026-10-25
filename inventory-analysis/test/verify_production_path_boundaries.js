const assert = require('assert');
const { generatePurchaseSuggestions } = require('../purchaseSuggestions');

console.log('================================================================');
console.log('  RUNNING PRODUCTION-PATH PIPELINE BOUNDARY TESTS               ');
console.log('================================================================\n');

// Helper to run through the real generatePurchaseSuggestions pipeline
function runPipeline(salesAnalysisMap, currentStockMap, configOverrides = {}) {
  return generatePurchaseSuggestions({
    salesAnalysis: salesAnalysisMap,
    currentStockByItem: currentStockMap,
    config: {
      leadTimeDays: 3,
      orderCoverageDays: 15,
      serviceLevel: 0.95,
      watchThresholdFactor: 1.25,
      ...configOverrides,
    },
  });
}

function runPipelineItem(itemKey, salesData, stockQty, configOverrides = {}) {
  const res = runPipeline(
    { [itemKey]: salesData },
    { [itemKey]: { quantity: stockQty, asOfDate: new Date() } },
    configOverrides
  );
  return { suggestion: res.suggestions[0], dataQualityNotes: res.dataQualityNotes };
}

// -------------------------------------------------------------
// 1. Target Stock = 9: Independent Suggested Quantity Verification
// -------------------------------------------------------------
console.log('--- 1. Target Stock = 9 Independent Quantity Verification ---');
// Base parameters: EDD = 0.45, sigma = 0.589, L = 3, C = 15
// SS = ceil(1.65 * 0.589 * sqrt(3)) = 2
// ROP = ceil(0.45 * 3 + 2) = 4
// TS = ceil(0.45 * 15 + 2) = 9
const baseSales = {
  totalSold: 85,
  periodDays: 189,
  fullPeriodAvgDailyDemand: 0.45,
  recentAvgDailyDemand: null,
  priorAvgDailyDemand: null,
  dailyStdDev: 0.589,
  trend: 'stable',
};

// Stock 0 -> Q = 9, BUY_NOW
{
  const { suggestion } = runPipelineItem('SKU-STOCK-0', baseSales, 0);
  assert.strictEqual(suggestion.classification, 'BUY_NOW');
  assert.strictEqual(suggestion.targetStock, 9);
  assert.strictEqual(suggestion.suggestedOrderQty, 9, 'Stock 0 -> Q must equal 9');
  console.log('  ✅ Stock 0: BUY_NOW, TS=9, Q=9');
}

// Stock 3 -> Q = 6, BUY_NOW
{
  const { suggestion } = runPipelineItem('SKU-STOCK-3', baseSales, 3);
  assert.strictEqual(suggestion.classification, 'BUY_NOW');
  assert.strictEqual(suggestion.targetStock, 9);
  assert.strictEqual(suggestion.suggestedOrderQty, 6, 'Stock 3 -> Q must equal 6 (9 - 3)');
  console.log('  ✅ Stock 3: BUY_NOW, TS=9, Q=6');
}

// Stock 4 -> Q = 5, WATCH (Stock = ROP = 4)
{
  const { suggestion } = runPipelineItem('SKU-STOCK-4', baseSales, 4);
  assert.strictEqual(suggestion.classification, 'WATCH');
  assert.strictEqual(suggestion.reorderPoint, 4);
  assert.strictEqual(suggestion.targetStock, 9);
  assert.strictEqual(suggestion.suggestedOrderQty, 5, 'Stock 4 -> Q must equal 5 (9 - 4) independently of WATCH classification');
  console.log('  ✅ Stock 4: WATCH, ROP=4, TS=9, Q=5 (independent formula verified)');
}

// Stock 5 -> Q = 4, WATCH (Stock = ROP * 1.25 = 5.0)
{
  const { suggestion } = runPipelineItem('SKU-STOCK-5', baseSales, 5);
  assert.strictEqual(suggestion.classification, 'WATCH');
  assert.strictEqual(suggestion.targetStock, 9);
  assert.strictEqual(suggestion.suggestedOrderQty, 4, 'Stock 5 -> Q must equal 4 (9 - 5) independently of WATCH classification');
  console.log('  ✅ Stock 5: WATCH, WatchLimit=5.0, TS=9, Q=4 (independent formula verified)');
}

// Negative stock -5 -> Q = 9, BUY_NOW (physical stock preserved as -5)
{
  const { suggestion } = runPipelineItem('SKU-STOCK-NEG5', baseSales, -5);
  assert.strictEqual(suggestion.classification, 'BUY_NOW');
  assert.strictEqual(suggestion.currentStock, -5, 'Original negative stock must be preserved');
  assert.strictEqual(suggestion.suggestedOrderQty, 9, 'Negative stock clamped to 0 yields Q = TS (9)');
  console.log('  ✅ Negative Stock -5: BUY_NOW, currentStock=-5 preserved, Q=9');
}

// Fractional stock 2.4 -> Q = 7, BUY_NOW
{
  const { suggestion } = runPipelineItem('SKU-STOCK-2.4', baseSales, 2.4);
  assert.strictEqual(suggestion.classification, 'BUY_NOW');
  assert.strictEqual(suggestion.suggestedOrderQty, 7, 'Fractional stock 2.4 -> Q = ceilClean(9 - 2.4) = 7');
  console.log('  ✅ Fractional Stock 2.4: BUY_NOW, TS=9, Q=7');
}

// -------------------------------------------------------------
// 2. WATCH Boundary Verification
// -------------------------------------------------------------
console.log('\n--- 2. WATCH Boundary Verification ---');
// Stock immediately below ROP (3.999 < 4)
{
  const { suggestion } = runPipelineItem('SKU-BELOW-ROP', baseSales, 3.999);
  assert.strictEqual(suggestion.classification, 'BUY_NOW');
  assert.strictEqual(suggestion.suggestedOrderQty, 6); // ceilClean(9 - 3.999) = 6
  console.log('  ✅ Stock Immediately Below ROP (3.999 vs 4): BUY_NOW, Q=6');
}

// Stock exactly at ROP (4.0)
{
  const { suggestion } = runPipelineItem('SKU-AT-ROP', baseSales, 4.0);
  assert.strictEqual(suggestion.classification, 'WATCH');
  assert.strictEqual(suggestion.suggestedOrderQty, 5);
  console.log('  ✅ Stock Exactly at ROP (4.0): WATCH, Q=5');
}

// Stock exactly at watch threshold (5.0)
{
  const { suggestion } = runPipelineItem('SKU-AT-WATCH-LIMIT', baseSales, 5.0);
  assert.strictEqual(suggestion.classification, 'WATCH');
  assert.strictEqual(suggestion.suggestedOrderQty, 4);
  console.log('  ✅ Stock Exactly at Watch Threshold (5.0): WATCH, Q=4');
}

// Stock immediately above watch threshold (5.001 > 5.0)
{
  const { suggestion } = runPipelineItem('SKU-ABOVE-WATCH-LIMIT', baseSales, 5.001);
  assert.strictEqual(suggestion.classification, 'OK');
  assert.strictEqual(suggestion.suggestedOrderQty, 4); // ceilClean(9 - 5.001) = 4
  console.log('  ✅ Stock Immediately Above Watch Threshold (5.001): OK, Q=4');
}

// Stock at or above target stock (9.0 and 10.0) -> Q = 0
{
  const { suggestion: sug9 } = runPipelineItem('SKU-AT-TS', baseSales, 9.0);
  assert.strictEqual(sug9.classification, 'OK');
  assert.strictEqual(sug9.suggestedOrderQty, 0, 'Stock = TS -> Q = 0');

  const { suggestion: sug10 } = runPipelineItem('SKU-ABOVE-TS', baseSales, 10.0);
  assert.strictEqual(sug10.classification, 'OK');
  assert.strictEqual(sug10.suggestedOrderQty, 0, 'Stock > TS -> Q = 0');
  console.log('  ✅ Stock at/above TS (9.0 and 10.0): OK, Q=0');
}

// -------------------------------------------------------------
// 3. Epsilon & CeilClean Numerical Behavior
// -------------------------------------------------------------
console.log('\n--- 3. Epsilon & CeilClean Precision Protection ---');
{
  // Floating-point precision noise (6.000000000000001) must cleanly resolve to 6, NOT 7!
  const stdDevTarget6 = 6 / (1.65 * Math.sqrt(3));
  const { suggestion } = runPipelineItem('SKU-FLOAT-6', {
    totalSold: 150,
    periodDays: 30,
    fullPeriodAvgDailyDemand: 5.0,
    recentAvgDailyDemand: 5.0,
    priorAvgDailyDemand: 5.0,
    dailyStdDev: stdDevTarget6,
    trend: 'stable',
  }, 20);

  assert.strictEqual(suggestion.safetyStock, 6, 'SS must cleanly be 6, not 7');
  assert.strictEqual(suggestion.reorderPoint, 21, 'ROP must cleanly be 21 (5*3 + 6)');
  assert.strictEqual(suggestion.targetStock, 81, 'TS must cleanly be 81 (5*15 + 6)');
  assert.strictEqual(suggestion.suggestedOrderQty, 61, 'Q must cleanly be 61 (81 - 20)');
  console.log('  ✅ IEEE-754 precision noise (6.000000000000001): SS=6, ROP=21, TS=81, Q=61');
}

{
  // Legitimate value above integer boundary (6.001) must round up to 7!
  const stdDevTarget6001 = 6.001 / (1.65 * Math.sqrt(3));
  const { suggestion } = runPipelineItem('SKU-LEGIT-ABOVE-6', {
    totalSold: 150,
    periodDays: 30,
    fullPeriodAvgDailyDemand: 5.0,
    recentAvgDailyDemand: 5.0,
    priorAvgDailyDemand: 5.0,
    dailyStdDev: stdDevTarget6001,
    trend: 'stable',
  }, 20);
  assert.strictEqual(suggestion.safetyStock, 7, 'True 6.001 must round up to 7');
  console.log('  ✅ Legitimate fraction above integer (6.001): SS=7');
}

{
  // Legitimate value just below integer boundary (5.999999) must round up to 6!
  const stdDevTarget5999 = 5.999999 / (1.65 * Math.sqrt(3));
  const { suggestion } = runPipelineItem('SKU-LEGIT-BELOW-6', {
    totalSold: 150,
    periodDays: 30,
    fullPeriodAvgDailyDemand: 5.0,
    recentAvgDailyDemand: 5.0,
    priorAvgDailyDemand: 5.0,
    dailyStdDev: stdDevTarget5999,
    trend: 'stable',
  }, 20);
  assert.strictEqual(suggestion.safetyStock, 6, '5.999999 must round up to 6');
  console.log('  ✅ Legitimate fraction below integer (5.999999): SS=6');
}

// -------------------------------------------------------------
// 4. Missing Data vs. Measured Zero Demand
// -------------------------------------------------------------
console.log('\n--- 4. Missing Data vs. Measured Zero Demand ---');

// A. Numeric zero EDD and numeric zero sigma
{
  const { suggestion } = runPipelineItem('SKU-NUMERIC-ZERO', {
    totalSold: 0,
    periodDays: 189,
    fullPeriodAvgDailyDemand: 0,
    recentAvgDailyDemand: null,
    priorAvgDailyDemand: null,
    dailyStdDev: 0,
    trend: 'stable',
  }, 0);
  assert.strictEqual(suggestion.classification, 'OK');
  assert.strictEqual(suggestion.suggestedOrderQty, 0);
  assert.strictEqual(suggestion.safetyStock, 0);
  assert.strictEqual(suggestion.reorderPoint, 0);
  assert.strictEqual(suggestion.targetStock, 0);
  console.log('  ✅ Numeric Zero Demand (EDD=0, σ=0): Classified OK, Q=0, SS=0, ROP=0, TS=0');
}

// A2. Gate 1 Test: Synthetic EDD = 0, positive sigma, positive target stock, physical stock below target stock
{
  const { suggestion } = runPipelineItem('SKU-EDD0-SIGMA-POS', {
    totalSold: 0,
    periodDays: 189,
    fullPeriodAvgDailyDemand: 0,
    recentAvgDailyDemand: null,
    priorAvgDailyDemand: null,
    dailyStdDev: 1.0, // positive sigma
    trend: 'stable',
    availabilityConfidence: 'VERIFIED',
  }, 0); // physical stock 0 < targetStock 3

  // Traced formulas:
  // SS = ceilClean(1.65 * 1.0 * sqrt(3)) = 3
  // ROP = ceilClean(0 * 3 + 3) = 3
  // TS = ceilClean(0 * 15 + 3) = 3
  // stock = 0 < TS = 3
  // Suggested Order Qty: max(0, ceilClean(TS - operationalStock)) = max(0, ceilClean(3 - 0)) = 3
  // Classification: currentPhysicalStock (0) <= ROP * 1.25 (3.75) and ROP (3) > 0 -> WATCH
  assert.strictEqual(suggestion.safetyStock, 3);
  assert.strictEqual(suggestion.reorderPoint, 3);
  assert.strictEqual(suggestion.targetStock, 3);
  assert.strictEqual(suggestion.suggestedOrderQty, 3, 'Q must equal max(0, ceilClean(TS - stock)) = 3 without EDD condition');
  assert.strictEqual(suggestion.classification, 'WATCH', 'Classification is WATCH (currentStock <= ROP * 1.25 and ROP > 0)');
  assert.strictEqual(suggestion.availabilityConfidence, 'VERIFIED');
  console.log(`  ✅ Gate 1 Synthetic Boundary (EDD=0, σ=1.0, Stock=0): TS=${suggestion.targetStock}, Q=${suggestion.suggestedOrderQty}, Confidence=${suggestion.availabilityConfidence}, Classification=${suggestion.classification}`);
}

// A3. EDD = 0 with Positive Sigma under Trend-Adjusted Demand:
// When an item sold units in the prior window (yielding sigma > 0) but 0 units in the recent window,
// trend-adjusted demand sets EDD = recentAvgDailyDemand = 0.
// Verify that the unconditional formula correctly orders safety buffer Q = TS = SS (e.g. Q = 3) instead of being zeroed!
{
  const resTrendZero = generatePurchaseSuggestions({
    salesAnalysis: {
      'SKU-FALLING-TO-ZERO': {
        totalSold: 40,
        periodDays: 180,
        fullPeriodAvgDailyDemand: 0.22,
        recentAvgDailyDemand: 0, // Recent 90-day window had 0 sales
        priorAvgDailyDemand: 0.44, // Prior 90-day window had 40 sales
        dailyStdDev: 1.0, // Historical variability across period is positive
        trend: 'falling',
        demandChangePct: -100,
      },
    },
    currentStockByItem: { 'SKU-FALLING-TO-ZERO': { quantity: 0, asOfDate: new Date() } },
    config: { leadTimeDays: 3, orderCoverageDays: 15, serviceLevel: 0.95, watchThresholdFactor: 1.25, useTrendAdjustedDemand: true },
  });

  const sug = resTrendZero.suggestions[0];
  // Under trend adjustment, EDD is set to recentAvgDailyDemand (0):
  assert.strictEqual(sug.effectiveDailyDemand, 0);
  assert.strictEqual(sug.safetyStock, 3); // ceilClean(1.65 * 1.0 * sqrt(3)) = 3
  assert.strictEqual(sug.reorderPoint, 3); // ceilClean(0 * 3 + 3) = 3
  assert.strictEqual(sug.targetStock, 3); // ceilClean(0 * 15 + 3) = 3
  assert.strictEqual(sug.suggestedOrderQty, 3, 'Unconditional formula must preserve buffer Q = 3 when EDD = 0 via trend');
  assert.strictEqual(sug.classification, 'WATCH');
  console.log('  ✅ Trend Adjustment Boundary (Falling to EDD=0 with σ=1.0): Q=3 preserved unconditionally');
}

// A4. Full-Period Arithmetic Mean Scope:
// For the complete non-negative daily series without trend or availability adjustments,
// sum(d) = 0 strictly implies mean(d) = 0 and stdDev(d) = 0.
{
  const zeroSalesDays = new Array(189).fill(0);
  const meanDemand = zeroSalesDays.reduce((a, b) => a + b, 0) / zeroSalesDays.length;
  const variance = zeroSalesDays.reduce((acc, val) => acc + Math.pow(val - meanDemand, 2), 0) / zeroSalesDays.length;
  const sigma = Math.sqrt(variance);

  assert.strictEqual(meanDemand, 0);
  assert.strictEqual(sigma, 0);
  console.log('  ✅ Full-Period Arithmetic Mean Scope: Verified that unadjusted series EDD=0 implies σ=0');
}

// B. Missing / null EDD
{
  const res = runPipeline(
    {
      'SKU-NULL-EDD': {
        totalSold: 50,
        periodDays: 189,
        fullPeriodAvgDailyDemand: null, // missing EDD
        recentAvgDailyDemand: null,
        priorAvgDailyDemand: null,
        dailyStdDev: 1.0,
        trend: 'stable',
      },
    },
    { 'SKU-NULL-EDD': { quantity: 5, asOfDate: new Date() } }
  );
  assert.strictEqual(res.suggestions.length, 0, 'Item with null EDD must NOT produce a suggestion');
  assert.strictEqual(res.dataQualityNotes.length, 1);
  assert(res.dataQualityNotes[0].issue.includes('Demand velocity (EDD) is missing or invalid'));
  console.log('  ✅ Missing/Null EDD: Withheld from automated reorder, routed to Review (dataQualityNotes)');
}

// C. Missing / null sigma
{
  const res = runPipeline(
    {
      'SKU-NULL-SIGMA': {
        totalSold: 50,
        periodDays: 189,
        fullPeriodAvgDailyDemand: 0.5,
        recentAvgDailyDemand: null,
        priorAvgDailyDemand: null,
        dailyStdDev: null, // missing sigma
        trend: 'stable',
      },
    },
    { 'SKU-NULL-SIGMA': { quantity: 5, asOfDate: new Date() } }
  );
  assert.strictEqual(res.suggestions.length, 0, 'Item with null sigma must NOT produce a suggestion');
  assert.strictEqual(res.dataQualityNotes.length, 1);
  assert(res.dataQualityNotes[0].issue.includes('Demand variability (sigma) is missing or invalid'));
  console.log('  ✅ Missing/Null Sigma: Withheld from automated reorder, routed to Review (dataQualityNotes)');
}

// D. NaN and invalid numerical inputs
{
  const res = runPipeline(
    {
      'SKU-NAN-EDD': {
        totalSold: 50,
        periodDays: 189,
        fullPeriodAvgDailyDemand: NaN,
        recentAvgDailyDemand: null,
        priorAvgDailyDemand: null,
        dailyStdDev: 1.0,
        trend: 'stable',
      },
      'SKU-NAN-STOCK': {
        totalSold: 50,
        periodDays: 189,
        fullPeriodAvgDailyDemand: 0.5,
        recentAvgDailyDemand: null,
        priorAvgDailyDemand: null,
        dailyStdDev: 1.0,
        trend: 'stable',
      },
    },
    {
      'SKU-NAN-EDD': { quantity: 5, asOfDate: new Date() },
      'SKU-NAN-STOCK': { quantity: NaN, asOfDate: new Date() },
    }
  );
  assert.strictEqual(res.suggestions.length, 0);
  assert.strictEqual(res.dataQualityNotes.length, 2);
  console.log('  ✅ NaN EDD / Stock: Withheld from automated reorder, routed to Review (dataQualityNotes)');
}

// E. BOUNDED Availability
{
  const { suggestion } = runPipelineItem('SKU-BOUNDED', {
    totalSold: 85,
    periodDays: 189,
    fullPeriodAvgDailyDemand: 0.45,
    recentAvgDailyDemand: null,
    priorAvgDailyDemand: null,
    dailyStdDev: 1.07,
    trend: 'stable',
    availabilityConfidence: 'BOUNDED',
    isProvisional: true,
    provisionalReason: 'Bounded availability: inward arrival dates are unverified; calendar baseline retained with provisional warning.',
  }, 0);
  assert.strictEqual(suggestion.availabilityConfidence, 'BOUNDED');
  assert.strictEqual(suggestion.isProvisional, true);
  assert(suggestion.provisionalReason.includes('Bounded availability'));
  console.log('  ✅ BOUNDED Availability: Confidence="BOUNDED", isProvisional=true, warning preserved');
}

// F. INDETERMINATE Availability
{
  const { suggestion } = runPipelineItem('SKU-INDETERMINATE', {
    totalSold: 20,
    periodDays: 189,
    fullPeriodAvgDailyDemand: 0.1,
    recentAvgDailyDemand: null,
    priorAvgDailyDemand: null,
    dailyStdDev: 0.3,
    trend: 'stable',
    availabilityConfidence: 'INDETERMINATE',
    isProvisional: true,
    provisionalReason: 'Indeterminate availability: insufficient movement evidence; using calendar demand baseline.',
  }, 2);
  assert.strictEqual(suggestion.availabilityConfidence, 'INDETERMINATE');
  assert.strictEqual(suggestion.isProvisional, true);
  console.log('  ✅ INDETERMINATE Availability: Confidence="INDETERMINATE", isProvisional=true, warning preserved');
}

// G. Stock Reconstruction Mismatch
{
  const { suggestion } = runPipelineItem('SKU-MISMATCH', {
    totalSold: 85,
    periodDays: 189,
    fullPeriodAvgDailyDemand: 0.45,
    recentAvgDailyDemand: null,
    priorAvgDailyDemand: null,
    dailyStdDev: 1.07,
    trend: 'stable',
    reconciliationStatus: 'STOCK_RECONSTRUCTION_MISMATCH',
    reconciliationDifference: -9,
  }, 0);
  assert.strictEqual(suggestion.reconciliationStatus, 'STOCK_RECONSTRUCTION_MISMATCH');
  assert.strictEqual(suggestion.reconciliationDifference, -9);
  console.log('  ✅ Stock Reconstruction Mismatch: reconciliationStatus="STOCK_RECONSTRUCTION_MISMATCH" (Diff: -9)');
}

// H. Valid BUY NOW item with Provisional Demand (e.g. JIMJAM)
{
  const { suggestion } = runPipelineItem('BRIT TRT JIMJAM 57 GM', {
    totalSold: 85,
    periodDays: 189,
    fullPeriodAvgDailyDemand: 0.45,
    recentAvgDailyDemand: null,
    priorAvgDailyDemand: null,
    dailyStdDev: 1.07,
    trend: 'stable',
    availabilityConfidence: 'BOUNDED',
    isProvisional: true,
    provisionalReason: 'Bounded availability: inward arrival dates are unverified; calendar baseline retained with provisional warning.',
  }, 0);
  assert.strictEqual(suggestion.classification, 'BUY_NOW');
  assert.strictEqual(suggestion.safetyStock, 4);
  assert.strictEqual(suggestion.reorderPoint, 6);
  assert.strictEqual(suggestion.targetStock, 11);
  assert.strictEqual(suggestion.suggestedOrderQty, 11);
  assert.strictEqual(suggestion.isProvisional, true);
  console.log('  ✅ Valid BUY NOW with Provisional Demand: Classified BUY_NOW, SS=4, ROP=6, TS=11, Q=11, isProvisional=true');
}

// I. Insufficient data: Sold historically but not in Stock Detail Report
{
  const res = runPipeline(
    {
      'SKU-SOLD-NO-STOCK': {
        totalSold: 30,
        periodDays: 189,
        fullPeriodAvgDailyDemand: 0.16,
        recentAvgDailyDemand: null,
        priorAvgDailyDemand: null,
        dailyStdDev: 0.4,
        trend: 'stable',
      },
    },
    {} // empty current stock!
  );
  assert.strictEqual(res.suggestions.length, 0);
  assert.strictEqual(res.dataQualityNotes.length, 1);
  assert(res.dataQualityNotes[0].issue.includes('Sold historically but not found in Stock Detail Report'));
  console.log('  ✅ Insufficient Data (Sold historically, missing from Stock Detail): Routed to Review (dataQualityNotes)');
}

console.log('\n================================================================');
console.log('  ALL PRODUCTION-PATH PIPELINE TESTS PASSED (100%)              ');
console.log('================================================================\n');
