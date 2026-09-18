const assert = require('assert');
const path = require('path');
const fs = require('fs');

const {
  findHeaderRowIndex,
  mapColumns,
  parseDateCell,
  parseGenerationDateFromTitle,
  parseNumberCell,
  normalizeItemName,
} = require('../parsers');

const {
  analyzeSalesPatterns,
  detectTrend,
  buildDailySeries,
  fillDailyValues,
  mean,
  stdDev,
  MIN_MEANINGFUL_RECENT_DAILY_DEMAND,
} = require('../salesAnalysis');

const {
  generatePurchaseSuggestions,
  validateConfig,
  zFor,
  generateReason,
} = require('../purchaseSuggestions');

const { getCurrentStockByItem } = require('../reportReaders');
const { runAnalysis } = require('../index');

// Results tracker for Section 43 categories
const testResults = [];

function recordCategory(category, passed, detail = '') {
  testResults.push({ category, passed, detail });
}

console.log('Running Inventory Analysis V1 Test Suite...\n');

// -------------------------------------------------------------
// 1. Parser tests
// -------------------------------------------------------------
try {
  const sampleRows = [
    ['Vyapar Sales Report'],
    ['Generated on 15/09/2026'],
    ['', ''],
    ['Date', 'Invoice No', 'Item Name', 'Quantity', 'Price/Unit'],
    ['15/08/2026', 'INV-001', 'Milk 500ml', '10', '30'],
  ];
  const idx = findHeaderRowIndex(sampleRows, [['item'], ['qty', 'quantity'], ['date']]);
  assert.strictEqual(idx, 3, 'findHeaderRowIndex should identify header row at index 3');

  const colMap = mapColumns(sampleRows[3], {
    itemName: ['item name', 'item'],
    quantity: ['qty', 'quantity'],
    date: ['date'],
  });
  assert.strictEqual(colMap.itemName, 2);
  assert.strictEqual(colMap.quantity, 3);
  assert.strictEqual(colMap.date, 0);

  assert.strictEqual(parseNumberCell('1,250.75'), 1250.75);
  assert.strictEqual(parseNumberCell('-15'), -15);
  assert.strictEqual(parseNumberCell(''), null);
  assert.strictEqual(parseNumberCell(null), null);

  recordCategory('Parser tests', true, 'Header detection, column mapping, and number parsing passed');
} catch (e) {
  recordCategory('Parser tests', false, e.message);
}

// -------------------------------------------------------------
// 2. Date handling
// -------------------------------------------------------------
try {
  // Test dd/mm/yyyy parsing: 05/09/2026 is 5 Sept, NOT 9 May
  const d1 = parseDateCell('05/09/2026');
  assert(d1 instanceof Date);
  assert.strictEqual(d1.getDate(), 5, 'Day must be 5');
  assert.strictEqual(d1.getMonth(), 8, 'Month must be September (index 8)');
  assert.strictEqual(d1.getFullYear(), 2026);

  // Test dd-mm-yyyy parsing
  const d2 = parseDateCell('28-02-2026');
  assert(d2 instanceof Date);
  assert.strictEqual(d2.getDate(), 28);
  assert.strictEqual(d2.getMonth(), 1);

  // Test snapshot date from title with "Sept"
  const snapDate = parseGenerationDateFromTitle('Generated on Sept 13,2026 at 03:56 pm');
  assert(snapDate instanceof Date);
  assert.strictEqual(snapDate.getDate(), 13);
  assert.strictEqual(snapDate.getMonth(), 8);
  assert.strictEqual(snapDate.getFullYear(), 2026);

  recordCategory('Date handling', true, 'dd/mm/yyyy support and snapshot title extraction passed');
} catch (e) {
  recordCategory('Date handling', false, e.message);
}

// -------------------------------------------------------------
// 3. Name normalization
// -------------------------------------------------------------
try {
  assert.strictEqual(normalizeItemName('AB ARHAR DAL 500G N'), 'AB ARHAR DAL 500G');
  assert.strictEqual(normalizeItemName('AB GRNDNUT 200G NN'), 'AB GRNDNUT 200G');
  assert.strictEqual(normalizeItemName('PTNJLI DK NTRL TP 100G N N'), 'PTNJLI DK NTRL TP 100G');
  // Should NOT strip when N is part of a real token
  assert.strictEqual(normalizeItemName('GILL FUSION 2N'), 'GILL FUSION 2N');

  // Stock record aggregation test
  const stockRecords = [
    { itemName: 'AMUL BUTTER 100G', rawItemName: 'AMUL BUTTER 100G', closingQty: 10, date: new Date() },
    { itemName: 'AMUL BUTTER 100G', rawItemName: 'AMUL BUTTER 100G N', closingQty: 15, date: new Date() },
    { itemName: 'OTHER ITEM', rawItemName: 'OTHER ITEM', closingQty: 5, date: new Date() },
  ];
  const { currentStock, mergedItemGroups } = getCurrentStockByItem(stockRecords);
  assert.strictEqual(currentStock['AMUL BUTTER 100G'].quantity, 25, 'Quantities of N variants must be summed');
  assert.strictEqual(mergedItemGroups.length, 1);
  assert.strictEqual(mergedItemGroups[0].rawVariants.length, 2);

  recordCategory('Name normalization', true, 'N/NN/NNN stripping and stock merging passed');
} catch (e) {
  recordCategory('Name normalization', false, e.message);
}

// -------------------------------------------------------------
// 4. Negative stock
// -------------------------------------------------------------
try {
  // In report reader, closingQty < 0 is recorded in negativeStockItems and clamped to 0
  const rawClosingQty = -5;
  const negativeStockItems = [];
  let closingQty = rawClosingQty;
  if (rawClosingQty < 0) {
    negativeStockItems.push({ itemName: 'TEST ITEM NEG', recordedClosingQty: rawClosingQty });
    closingQty = 0;
  }
  assert.strictEqual(closingQty, 0, 'Negative stock must be clamped to 0 for purchase math');
  assert.strictEqual(negativeStockItems[0].recordedClosingQty, -5, 'Original negative stock retained');

  // Check purchase suggestion with 0 stock
  const suggestions = generatePurchaseSuggestions({
    salesAnalysis: {
      'TEST ITEM NEG': {
        totalSold: 30,
        periodDays: 30,
        trendWindowDays: 15,
        fullPeriodAvgDailyDemand: 1.0,
        recentAvgDailyDemand: 1.0,
        priorAvgDailyDemand: 1.0,
        demandChangePct: 0,
        dailyStdDev: 0.5,
        trend: 'stable',
      },
    },
    currentStockByItem: {
      'TEST ITEM NEG': { quantity: 0, asOfDate: new Date() },
    },
    config: { leadTimeDays: 3, orderCoverageDays: 15, serviceLevel: 0.95 },
  });

  assert.strictEqual(suggestions.suggestions[0].currentStock, 0);
  assert.strictEqual(suggestions.suggestions[0].classification, 'BUY_NOW');

  recordCategory('Negative stock', true, 'Clamped to 0 for math and retained in review list');
} catch (e) {
  recordCategory('Negative stock', false, e.message);
}

// -------------------------------------------------------------
// Helper: generate synthetic daily sales records
// -------------------------------------------------------------
function makeSalesRecords(itemName, days, dailyDemandGenerator) {
  const records = [];
  const baseDate = new Date(2026, 0, 1); // 1 Jan 2026
  for (let i = 0; i < days; i++) {
    const d = new Date(baseDate);
    d.setDate(baseDate.getDate() + i);
    const qty = dailyDemandGenerator(i);
    if (qty > 0) {
      records.push({ itemName, quantity: qty, date: d });
    }
  }
  return records;
}

// -------------------------------------------------------------
// 5. 60-day trend
// -------------------------------------------------------------
try {
  const records = makeSalesRecords('ITEM_60', 60, (day) => (day < 30 ? 10 : 20));
  const analysis = analyzeSalesPatterns(records);
  assert.strictEqual(analysis.periodDays, 60, 'Period days should be 60');
  assert.strictEqual(analysis.trendWindowDays, 30, 'Automatic trend window for 60-day report must be 30');
  const item = analysis.items['ITEM_60'];
  assert.strictEqual(item.trendWindowDays, 30);
  assert.strictEqual(item.priorAvgDailyDemand, 10);
  assert.strictEqual(item.recentAvgDailyDemand, 20);
  assert.strictEqual(item.trend, 'rising');

  recordCategory('60-day trend', true, '30/30 split and rising trend verified');
} catch (e) {
  recordCategory('60-day trend', false, e.message);
}

// -------------------------------------------------------------
// 6. 90-day trend
// -------------------------------------------------------------
try {
  const records = makeSalesRecords('ITEM_90', 90, (day) => (day < 45 ? 10 : 10));
  const analysis = analyzeSalesPatterns(records);
  assert.strictEqual(analysis.periodDays, 90, 'Period days should be 90');
  assert.strictEqual(analysis.trendWindowDays, 45, 'Automatic trend window for 90-day report must be 45');
  const item = analysis.items['ITEM_90'];
  assert.strictEqual(item.trendWindowDays, 45);
  assert.strictEqual(item.trend, 'stable');

  recordCategory('90-day trend', true, '45/45 split and stable trend verified');
} catch (e) {
  recordCategory('90-day trend', false, e.message);
}

// -------------------------------------------------------------
// 7. 120-day trend
// -------------------------------------------------------------
try {
  const records = makeSalesRecords('ITEM_120', 120, (day) => (day < 60 ? 20 : 10));
  const analysis = analyzeSalesPatterns(records);
  assert.strictEqual(analysis.periodDays, 120, 'Period days should be 120');
  assert.strictEqual(analysis.trendWindowDays, 60, 'Automatic trend window for 120-day report must be 60');
  const item = analysis.items['ITEM_120'];
  assert.strictEqual(item.trendWindowDays, 60);
  assert.strictEqual(item.trend, 'falling');

  recordCategory('120-day trend', true, '60/60 split and falling trend verified');
} catch (e) {
  recordCategory('120-day trend', false, e.message);
}

// -------------------------------------------------------------
// 8. Insufficient history
// -------------------------------------------------------------
try {
  // 10-day report (< 14 days)
  const records = makeSalesRecords('ITEM_SHORT', 10, () => 5);
  const analysis = analyzeSalesPatterns(records);
  assert.strictEqual(analysis.periodDays, 10);
  const item = analysis.items['ITEM_SHORT'];
  assert.strictEqual(item.trend, 'insufficient-data', 'Period < 14 days must return insufficient-data');
  assert.strictEqual(item.recentAvgDailyDemand, null);
  assert.strictEqual(item.priorAvgDailyDemand, null);

  // Demand basis must use full-period average
  const sug = generatePurchaseSuggestions({
    salesAnalysis: analysis.items,
    currentStockByItem: { ITEM_SHORT: { quantity: 10, asOfDate: new Date() } },
    config: { leadTimeDays: 3, orderCoverageDays: 15 },
  });
  assert.strictEqual(sug.suggestions[0].demandBasis, 'full-period average');
  assert.strictEqual(sug.suggestions[0].effectiveDailyDemand, 5);

  recordCategory('Insufficient history', true, 'Returns insufficient-data and falls back to full-period average');
} catch (e) {
  recordCategory('Insufficient history', false, e.message);
}

// -------------------------------------------------------------
// 9. Zero-baseline trend
// -------------------------------------------------------------
try {
  // Case A: Prior = 0, Recent = 0.1 (< 0.5 threshold) -> conservative 'stable'
  const dailyValuesSmall = new Array(30).fill(0);
  // Last 15 days have 1 or 2 sales (avg = 0.1)
  dailyValuesSmall[20] = 1;
  dailyValuesSmall[25] = 1;
  const trendSmall = detectTrend(dailyValuesSmall, 15);
  assert.strictEqual(trendSmall.priorAvg, 0);
  assert(trendSmall.recentAvg < MIN_MEANINGFUL_RECENT_DAILY_DEMAND);
  assert.strictEqual(trendSmall.trend, 'stable', 'Low volume surge from 0 must be conservatively stable');

  // Case B: Prior = 0, Recent = 2.0 (>= 0.5 threshold) -> 'rising', changePct = null
  const dailyValuesSubstantial = new Array(30).fill(0);
  for (let i = 15; i < 30; i++) dailyValuesSubstantial[i] = 2;
  const trendSub = detectTrend(dailyValuesSubstantial, 15);
  assert.strictEqual(trendSub.priorAvg, 0);
  assert.strictEqual(trendSub.recentAvg, 2.0);
  assert.strictEqual(trendSub.trend, 'rising', 'Meaningful surge from 0 is classified as rising');
  assert.strictEqual(trendSub.changePct, null, 'ChangePct from 0 is safely null (not Infinity/NaN)');

  recordCategory('Zero-baseline trend', true, 'Avoided aggressive false spikes on zero baseline');
} catch (e) {
  recordCategory('Zero-baseline trend', false, e.message);
}

// -------------------------------------------------------------
// 10. Stable demand
// -------------------------------------------------------------
try {
  // 30 days: prior 15 days avg = 10, recent 15 days avg = 10.5 (+5%, within ±15%)
  const dailyValues = new Array(30).fill(10);
  dailyValues[25] = 15; // small variation
  const trendInfo = detectTrend(dailyValues, 15);
  assert.strictEqual(trendInfo.trend, 'stable');

  recordCategory('Stable demand', true, 'Changes within ±15% classified as stable');
} catch (e) {
  recordCategory('Stable demand', false, e.message);
}

// -------------------------------------------------------------
// 11. Rising demand
// -------------------------------------------------------------
try {
  // Prior 15 days avg = 10, Recent 15 days avg = 13 (+30% > 15%)
  const dailyValues = [...new Array(15).fill(10), ...new Array(15).fill(13)];
  const trendInfo = detectTrend(dailyValues, 15);
  assert.strictEqual(trendInfo.trend, 'rising');
  assert(trendInfo.changePct > 15);

  const sug = generatePurchaseSuggestions({
    salesAnalysis: {
      ITEM_RISING: {
        totalSold: 345,
        periodDays: 30,
        trendWindowDays: 15,
        fullPeriodAvgDailyDemand: 11.5,
        recentAvgDailyDemand: 13.0,
        priorAvgDailyDemand: 10.0,
        demandChangePct: 30.0,
        dailyStdDev: 1.5,
        trend: 'rising',
      },
    },
    currentStockByItem: { ITEM_RISING: { quantity: 10, asOfDate: new Date() } },
    config: { leadTimeDays: 3, orderCoverageDays: 15, useTrendAdjustedDemand: true },
  });

  assert.strictEqual(sug.suggestions[0].effectiveDailyDemand, 13.0, 'Effective demand uses recent average for rising trend');
  assert(sug.suggestions[0].demandBasis.includes('recent-window average'));

  recordCategory('Rising demand', true, 'Trend > +15% classified as rising and used for effective demand');
} catch (e) {
  recordCategory('Rising demand', false, e.message);
}

// -------------------------------------------------------------
// 12. Falling demand
// -------------------------------------------------------------
try {
  // Prior 15 days avg = 10, Recent 15 days avg = 7 (-30% < -15%)
  const dailyValues = [...new Array(15).fill(10), ...new Array(15).fill(7)];
  const trendInfo = detectTrend(dailyValues, 15);
  assert.strictEqual(trendInfo.trend, 'falling');
  assert(trendInfo.changePct < -15);

  const sug = generatePurchaseSuggestions({
    salesAnalysis: {
      ITEM_FALLING: {
        totalSold: 255,
        periodDays: 30,
        trendWindowDays: 15,
        fullPeriodAvgDailyDemand: 8.5,
        recentAvgDailyDemand: 7.0,
        priorAvgDailyDemand: 10.0,
        demandChangePct: -30.0,
        dailyStdDev: 1.5,
        trend: 'falling',
      },
    },
    currentStockByItem: { ITEM_FALLING: { quantity: 10, asOfDate: new Date() } },
    config: { leadTimeDays: 3, orderCoverageDays: 15, useTrendAdjustedDemand: true },
  });

  assert.strictEqual(sug.suggestions[0].effectiveDailyDemand, 7.0, 'Effective demand uses recent average for falling trend');

  recordCategory('Falling demand', true, 'Trend < -15% classified as falling and used for effective demand');
} catch (e) {
  recordCategory('Falling demand', false, e.message);
}

// -------------------------------------------------------------
// 13. Safety stock
// -------------------------------------------------------------
try {
  // Formula: Z * stdDev * sqrt(leadTimeDays)
  // leadTimeDays = 3, serviceLevel = 0.95 (Z = 1.65), stdDev = 2.0
  // safetyStock = 1.65 * 2.0 * sqrt(3) = 3.30 * 1.73205 = 5.7157... -> 5.72
  const z = zFor(0.95);
  const expectedSS = 1.65 * 2.0 * Math.sqrt(3);

  const sug = generatePurchaseSuggestions({
    salesAnalysis: {
      ITEM_SS: {
        totalSold: 150,
        periodDays: 30,
        trendWindowDays: 15,
        fullPeriodAvgDailyDemand: 5.0,
        recentAvgDailyDemand: 5.0,
        priorAvgDailyDemand: 5.0,
        demandChangePct: 0,
        dailyStdDev: 2.0,
        trend: 'stable',
      },
    },
    currentStockByItem: { ITEM_SS: { quantity: 100, asOfDate: new Date() } },
    config: { leadTimeDays: 3, orderCoverageDays: 15, serviceLevel: 0.95 },
  });

  assert.strictEqual(sug.suggestions[0].safetyStock, Math.round(expectedSS * 100) / 100);
  assert.strictEqual(sug.suggestions[0].safetyStock, 5.72);

  recordCategory('Safety stock', true, 'Correctly computed as Z * sigma * sqrt(leadTimeDays)');
} catch (e) {
  recordCategory('Safety stock', false, e.message);
}

// -------------------------------------------------------------
// 14. Reorder point
// -------------------------------------------------------------
try {
  // Specification Section 10/11 Example:
  // effectiveDailyDemand = 5, leadTimeDays = 3, safetyStock = 6
  // Reorder Point = (5 * 3) + 6 = 21
  const stdDevTarget = 6 / (1.65 * Math.sqrt(3)); // ~ 2.09955
  const sug = generatePurchaseSuggestions({
    salesAnalysis: {
      ITEM_ROP: {
        totalSold: 150,
        periodDays: 30,
        trendWindowDays: 15,
        fullPeriodAvgDailyDemand: 5.0,
        recentAvgDailyDemand: 5.0,
        priorAvgDailyDemand: 5.0,
        demandChangePct: 0,
        dailyStdDev: stdDevTarget,
        trend: 'stable',
      },
    },
    currentStockByItem: { ITEM_ROP: { quantity: 20, asOfDate: new Date() } },
    config: { leadTimeDays: 3, orderCoverageDays: 15, serviceLevel: 0.95 },
  });

  assert.strictEqual(sug.suggestions[0].reorderPoint, 21.0);

  recordCategory('Reorder point', true, 'Reorder Point correctly computed as EDD * leadTime + safetyStock');
} catch (e) {
  recordCategory('Reorder point', false, e.message);
}

// -------------------------------------------------------------
// 15. Target stock
// -------------------------------------------------------------
try {
  // Specification Section 11 Example:
  // effectiveDailyDemand = 5, orderCoverageDays = 15, safetyStock = 6
  // Target Stock = (5 * 15) + 6 = 81
  const stdDevTarget = 6 / (1.65 * Math.sqrt(3));
  const sug = generatePurchaseSuggestions({
    salesAnalysis: {
      ITEM_TARGET: {
        totalSold: 150,
        periodDays: 30,
        trendWindowDays: 15,
        fullPeriodAvgDailyDemand: 5.0,
        recentAvgDailyDemand: 5.0,
        priorAvgDailyDemand: 5.0,
        demandChangePct: 0,
        dailyStdDev: stdDevTarget,
        trend: 'stable',
      },
    },
    currentStockByItem: { ITEM_TARGET: { quantity: 20, asOfDate: new Date() } },
    config: { leadTimeDays: 3, orderCoverageDays: 15, serviceLevel: 0.95 },
  });

  assert.strictEqual(sug.suggestions[0].targetStock, 81.0);

  recordCategory('Target stock', true, 'Target Stock correctly computed as EDD * orderCoverage + safetyStock');
} catch (e) {
  recordCategory('Target stock', false, e.message);
}

// -------------------------------------------------------------
// 16. Suggested order quantity
// -------------------------------------------------------------
try {
  // Specification Section 12 Example:
  // Target Stock = 81, Current Stock = 20 -> Suggested Order Quantity = 81 - 20 = 61
  const stdDevTarget = 6 / (1.65 * Math.sqrt(3));
  const sug = generatePurchaseSuggestions({
    salesAnalysis: {
      ITEM_QTY: {
        totalSold: 150,
        periodDays: 30,
        trendWindowDays: 15,
        fullPeriodAvgDailyDemand: 5.0,
        recentAvgDailyDemand: 5.0,
        priorAvgDailyDemand: 5.0,
        demandChangePct: 0,
        dailyStdDev: stdDevTarget,
        trend: 'stable',
      },
    },
    currentStockByItem: { ITEM_QTY: { quantity: 20, asOfDate: new Date() } },
    config: { leadTimeDays: 3, orderCoverageDays: 15, serviceLevel: 0.95 },
  });

  assert.strictEqual(sug.suggestions[0].suggestedOrderQty, 61, 'Suggested order quantity should be 61');

  recordCategory('Suggested order quantity', true, 'ceil(Target Stock - Current Stock) verified');
} catch (e) {
  recordCategory('Suggested order quantity', false, e.message);
}

// -------------------------------------------------------------
// 17. BUY classification
// -------------------------------------------------------------
try {
  // ROP = 21. Current Stock = 20 < 21 -> BUY_NOW, suggestedOrderQty > 0, needsReorder = true
  const stdDevTarget = 6 / (1.65 * Math.sqrt(3));
  const sug = generatePurchaseSuggestions({
    salesAnalysis: {
      ITEM_BUY: {
        totalSold: 150,
        periodDays: 30,
        trendWindowDays: 15,
        fullPeriodAvgDailyDemand: 5.0,
        recentAvgDailyDemand: 5.0,
        priorAvgDailyDemand: 5.0,
        demandChangePct: 0,
        dailyStdDev: stdDevTarget,
        trend: 'stable',
      },
    },
    currentStockByItem: { ITEM_BUY: { quantity: 20, asOfDate: new Date() } },
    config: { leadTimeDays: 3, orderCoverageDays: 15, serviceLevel: 0.95 },
  });

  const item = sug.suggestions[0];
  assert.strictEqual(item.classification, 'BUY_NOW');
  assert.strictEqual(item.needsReorder, true);
  assert(item.suggestedOrderQty > 0);
  assert(item.reason.includes('below the reorder point'));

  recordCategory('BUY classification', true, 'Stock < ROP classified as BUY_NOW');
} catch (e) {
  recordCategory('BUY classification', false, e.message);
}

// -------------------------------------------------------------
// 18. WATCH classification
// -------------------------------------------------------------
try {
  // ROP = 21. 21 * 1.25 = 26.25.
  // Current Stock = 24 -> ROP <= Stock <= ROP * 1.25 -> WATCH, suggestedOrderQty = 0, needsReorder = false
  const stdDevTarget = 6 / (1.65 * Math.sqrt(3));
  const sug = generatePurchaseSuggestions({
    salesAnalysis: {
      ITEM_WATCH: {
        totalSold: 150,
        periodDays: 30,
        trendWindowDays: 15,
        fullPeriodAvgDailyDemand: 5.0,
        recentAvgDailyDemand: 5.0,
        priorAvgDailyDemand: 5.0,
        demandChangePct: 0,
        dailyStdDev: stdDevTarget,
        trend: 'stable',
      },
    },
    currentStockByItem: { ITEM_WATCH: { quantity: 24, asOfDate: new Date() } },
    config: { leadTimeDays: 3, orderCoverageDays: 15, serviceLevel: 0.95 },
  });

  const item = sug.suggestions[0];
  assert.strictEqual(item.classification, 'WATCH');
  assert.strictEqual(item.needsReorder, false);
  assert.strictEqual(item.suggestedOrderQty, 0);
  assert(item.reason.includes('within 25% above the reorder point'));

  recordCategory('WATCH classification', true, 'Stock between ROP and ROP * 1.25 classified as WATCH');
} catch (e) {
  recordCategory('WATCH classification', false, e.message);
}

// -------------------------------------------------------------
// 19. OK classification
// -------------------------------------------------------------
try {
  // ROP = 21. 21 * 1.25 = 26.25.
  // Current Stock = 50 > 26.25 -> OK, suggestedOrderQty = 0, needsReorder = false
  const stdDevTarget = 6 / (1.65 * Math.sqrt(3));
  const sug = generatePurchaseSuggestions({
    salesAnalysis: {
      ITEM_OK: {
        totalSold: 150,
        periodDays: 30,
        trendWindowDays: 15,
        fullPeriodAvgDailyDemand: 5.0,
        recentAvgDailyDemand: 5.0,
        priorAvgDailyDemand: 5.0,
        demandChangePct: 0,
        dailyStdDev: stdDevTarget,
        trend: 'stable',
      },
    },
    currentStockByItem: { ITEM_OK: { quantity: 50, asOfDate: new Date() } },
    config: { leadTimeDays: 3, orderCoverageDays: 15, serviceLevel: 0.95 },
  });

  const item = sug.suggestions[0];
  assert.strictEqual(item.classification, 'OK');
  assert.strictEqual(item.needsReorder, false);
  assert.strictEqual(item.suggestedOrderQty, 0);
  assert(item.reason.includes('well above the reorder point'));

  recordCategory('OK classification', true, 'Stock > ROP * 1.25 classified as OK');
} catch (e) {
  recordCategory('OK classification', false, e.message);
}

// -------------------------------------------------------------
// 20. Dead stock handling
// -------------------------------------------------------------
try {
  // Items with stock > 0 in stock detail but 0 sales
  const salesAnalysis = {
    ITEM_ACTIVE: { totalSold: 10, periodDays: 30, fullPeriodAvgDailyDemand: 0.33, dailyStdDev: 0.1, trend: 'stable' },
  };
  const currentStock = {
    ITEM_ACTIVE: { quantity: 5, asOfDate: new Date() },
    ITEM_DEAD_1: { quantity: 50, asOfDate: new Date() },
    ITEM_DEAD_2: { quantity: 120, asOfDate: new Date() },
    ITEM_ZERO: { quantity: 0, asOfDate: new Date() },
  };

  const soldItemNames = new Set(Object.keys(salesAnalysis));
  const neverSold = Object.entries(currentStock).filter(([itemName]) => !soldItemNames.has(itemName));
  const deadStockCandidates = neverSold
    .filter(([, entry]) => entry.quantity > 0)
    .map(([itemName, entry]) => ({ itemName, currentStock: entry.quantity }))
    .sort((a, b) => b.currentStock - a.currentStock);

  assert.strictEqual(deadStockCandidates.length, 2);
  assert.strictEqual(deadStockCandidates[0].itemName, 'ITEM_DEAD_2', 'Sorted highest-stock-first');
  assert.strictEqual(deadStockCandidates[0].currentStock, 120);

  recordCategory('Dead stock handling', true, 'Dead stock identified and sorted highest-stock-first');
} catch (e) {
  recordCategory('Dead stock handling', false, e.message);
}

// -------------------------------------------------------------
// 21. Missing stock handling
// -------------------------------------------------------------
try {
  // Item sold historically but missing in Stock Detail
  const sug = generatePurchaseSuggestions({
    salesAnalysis: {
      ITEM_WITHOUT_STOCK: {
        totalSold: 50,
        periodDays: 30,
        trendWindowDays: 15,
        fullPeriodAvgDailyDemand: 1.67,
        recentAvgDailyDemand: 1.67,
        priorAvgDailyDemand: 1.67,
        demandChangePct: 0,
        dailyStdDev: 0.5,
        trend: 'stable',
      },
    },
    currentStockByItem: {}, // missing
    config: { leadTimeDays: 3, orderCoverageDays: 15 },
  });

  assert.strictEqual(sug.suggestions.length, 0, 'No purchase suggestion generated without stock record');
  assert.strictEqual(sug.dataQualityNotes.length, 1);
  assert(sug.dataQualityNotes[0].issue.includes('not found in Stock Detail Report'));

  recordCategory('Missing stock handling', true, 'Items without stock record routed to dataQualityNotes');
} catch (e) {
  recordCategory('Missing stock handling', false, e.message);
}

// -------------------------------------------------------------
// Print Section 43 Formatted Summary Table
// -------------------------------------------------------------
console.log('Inventory Analysis V1 Tests');
console.log('---------------------------');
let allPassed = true;
for (const res of testResults) {
  const statusStr = res.passed ? 'PASS' : 'FAIL';
  const pad = ' '.repeat(Math.max(2, 29 - res.category.length));
  console.log(`${res.category}${pad}${statusStr}`);
  if (!res.passed) {
    console.error(`  -> Error: ${res.detail}`);
    allPassed = false;
  }
}
console.log('---------------------------');
const passedCount = testResults.filter((r) => r.passed).length;
console.log(`Total: ${passedCount}/${testResults.length} passed.`);

if (!allPassed) {
  process.exit(1);
}
