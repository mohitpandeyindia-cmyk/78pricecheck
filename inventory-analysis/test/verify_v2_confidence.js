const assert = require('assert');
const { reconstructSkuStock, toDayKey } = require('../stockReconstruction');
const { analyzeSalesPatterns, detectTrend } = require('../salesAnalysis');
const { generatePurchaseSuggestions } = require('../purchaseSuggestions');

console.log('================================================================');
console.log('  RUNNING INVENTORY ASSISTANT V2 COMPREHENSIVE ACCEPTANCE SUITE ');
console.log('================================================================\n');

// -------------------------------------------------------------
// Test A: Continuously Stocked SKU (VERIFIED Confidence)
// -------------------------------------------------------------
console.log('--- Test A: Continuously Stocked SKU (Verified) ---');
{
  const openingStock = 20;
  const movements = [
    { date: new Date(2026, 4, 1), quantity: 2, transactionType: 'Sale' },
    { date: new Date(2026, 4, 2), quantity: 1, transactionType: 'Sale' },
    { date: new Date(2026, 4, 3), quantity: 2, transactionType: 'Sale' },
    { date: new Date(2026, 4, 4), quantity: 1, transactionType: 'Sale' },
    { date: new Date(2026, 4, 5), quantity: 2, transactionType: 'Sale' },
  ];

  const res = reconstructSkuStock({
    skuKey: 'SKU-A',
    itemName: 'AMUL BUTTER 500 GM',
    itemCode: '890126201',
    openingStock,
    hasExplicitOpeningEvidence: true,
    stockDetailClosing: 12,
    stockDetailIn: 0,
    stockDetailOut: 8,
    movements,
    periodBounds: { from: new Date(2026, 4, 1), to: new Date(2026, 4, 5) },
  });

  assert.strictEqual(res.metrics.availabilityConfidence, 'VERIFIED');
  assert.strictEqual(res.metrics.availableDays, 5);
  assert.strictEqual(res.metrics.stockoutDays, 0);
  assert.strictEqual(res.metrics.salesWhileAvailable, 8);
  assert.strictEqual(res.metrics.averageDailyDemandWhileAvailable, 1.6);
  assert.strictEqual(res.reconstructedClosingStock, 12);
  assert.strictEqual(res.reconciliationStatus, 'RECONCILED');
  assert.strictEqual(res.metrics.stockConstrained, false);
  console.log('  ✅ Test A Passed: 100% available, VERIFIED confidence, reconciled perfectly.\n');
}

// -------------------------------------------------------------
// Test B: Sold Out Then Replenished SKU
// -------------------------------------------------------------
console.log('--- Test B: Sold Out Then Replenished SKU ---');
{
  const movements = [
    { date: new Date(2026, 4, 1), quantity: 4, transactionType: 'Sale' },
    { date: new Date(2026, 4, 4), quantity: 10, transactionType: 'Purchase' },
    { date: new Date(2026, 4, 4), quantity: 2, transactionType: 'Sale' },
    { date: new Date(2026, 4, 5), quantity: 1, transactionType: 'Sale' },
  ];

  const res = reconstructSkuStock({
    skuKey: 'SKU-B',
    itemName: 'KNR MUSTARD OIL 1 LTR',
    itemCode: '890126202',
    openingStock: 4,
    hasExplicitOpeningEvidence: true,
    stockDetailClosing: 7,
    stockDetailIn: 10,
    stockDetailOut: 7,
    movements,
    periodBounds: { from: new Date(2026, 4, 1), to: new Date(2026, 4, 5) },
  });

  assert.strictEqual(res.metrics.availabilityConfidence, 'VERIFIED');
  assert.strictEqual(res.metrics.availableDays, 3); // Days 1, 4, 5
  assert.strictEqual(res.metrics.stockoutDays, 2);  // Days 2, 3
  assert.strictEqual(res.metrics.replenishedAfterStockout, true);
  assert.strictEqual(res.metrics.salesWhileAvailable, 7);
  assert.strictEqual(res.metrics.averageDailyDemandWhileAvailable, 2.33); // 7 / 3
  assert.strictEqual(res.reconstructedClosingStock, 7);
  assert.strictEqual(res.reconciliationStatus, 'RECONCILED');
  assert.strictEqual(res.metrics.stockConstrained, true);
  console.log('  ✅ Test B Passed: Stockout excluded from denominator, replenishment detected.\n');
}

// -------------------------------------------------------------
// Test C: Sold Out and Never Replenished SKU
// -------------------------------------------------------------
console.log('--- Test C: Sold Out and Never Replenished SKU ---');
{
  const movements = [
    { date: new Date(2026, 4, 1), quantity: 4, transactionType: 'Sale' },
  ];

  const res = reconstructSkuStock({
    skuKey: 'SKU-C',
    itemName: 'HIMA PURI NEEM FW',
    itemCode: '890126203',
    openingStock: 4,
    hasExplicitOpeningEvidence: true,
    stockDetailClosing: 0,
    stockDetailIn: 0,
    stockDetailOut: 4,
    movements,
    periodBounds: { from: new Date(2026, 4, 1), to: new Date(2026, 4, 5) },
  });

  assert.strictEqual(res.metrics.availabilityConfidence, 'VERIFIED');
  assert.strictEqual(res.metrics.availableDays, 1);
  assert.strictEqual(res.metrics.stockoutDays, 4);
  assert.strictEqual(res.metrics.replenishedAfterStockout, false);
  assert.strictEqual(res.metrics.averageDailyDemandWhileAvailable, 4.0); // 4 / 1, NOT diluted to 0.8
  assert.strictEqual(res.reconstructedClosingStock, 0);
  assert.strictEqual(res.reconciliationStatus, 'RECONCILED');
  console.log('  ✅ Test C Passed: Zero-sales in stockout excluded from demand denominator.\n');
}

// -------------------------------------------------------------
// Test D: Undated Inward SKU (Stock Detail In > Billed Purchase In)
// -------------------------------------------------------------
console.log('--- Test D: Undated Inward SKU (Bounded Confidence) ---');
{
  const movements = [
    { date: new Date(2026, 4, 2), quantity: 5, transactionType: 'Sale' },
    { date: new Date(2026, 4, 4), quantity: 5, transactionType: 'Sale' },
  ];

  const res = reconstructSkuStock({
    skuKey: 'SKU-D',
    itemName: 'UNBILLED INWARD ITEM',
    itemCode: '890126204',
    openingStock: 0,
    stockDetailClosing: 0,
    stockDetailIn: 10, // Undated inward
    stockDetailOut: 10,
    movements,
    periodBounds: { from: new Date(2026, 4, 1), to: new Date(2026, 4, 5) },
  });

  assert.strictEqual(res.metrics.availabilityConfidence, 'BOUNDED');
  assert.strictEqual(res.metrics.isProvisional, true);
  assert.strictEqual(res.metrics.firstStockoutDate, null); // No fabricated exact date!
  assert.strictEqual(res.metrics.stockoutWindow.type, 'INTERVAL');
  console.log('  ✅ Test D Passed: Undated inward triggers BOUNDED confidence and interval window without fake dates.\n');
}

// -------------------------------------------------------------
// Test E.1: Aggregate Reconciliation with Different Dated Inward Histories
// -------------------------------------------------------------
console.log('--- Test E.1: Same Aggregate Totals with Different Chronology ---');
{
  const bounds = { from: new Date(2026, 4, 1), to: new Date(2026, 4, 5) };

  // History 1: Inward arrives on Day 1
  const movesHist1 = [
    { date: new Date(2026, 4, 1), quantity: 10, transactionType: 'Purchase' },
    { date: new Date(2026, 4, 2), quantity: 5, transactionType: 'Sale' },
    { date: new Date(2026, 4, 5), quantity: 10, transactionType: 'Sale' },
  ];
  const res1 = reconstructSkuStock({
    skuKey: 'SKU-E1',
    itemName: 'CHRONOLOGY TEST 1',
    openingStock: 5,
    hasExplicitOpeningEvidence: true,
    stockDetailClosing: 0,
    stockDetailIn: 10,
    stockDetailOut: 15,
    movements: movesHist1,
    periodBounds: bounds,
  });

  // History 2: Inward arrives on Day 4
  const movesHist2 = [
    { date: new Date(2026, 4, 2), quantity: 5, transactionType: 'Sale' },
    { date: new Date(2026, 4, 4), quantity: 10, transactionType: 'Purchase' },
    { date: new Date(2026, 4, 5), quantity: 10, transactionType: 'Sale' },
  ];
  const res2 = reconstructSkuStock({
    skuKey: 'SKU-E2',
    itemName: 'CHRONOLOGY TEST 2',
    openingStock: 5,
    hasExplicitOpeningEvidence: true,
    stockDetailClosing: 0,
    stockDetailIn: 10,
    stockDetailOut: 15,
    movements: movesHist2,
    periodBounds: bounds,
  });

  assert.strictEqual(res1.reconciliationStatus, 'RECONCILED');
  assert.strictEqual(res2.reconciliationStatus, 'RECONCILED');

  assert.strictEqual(res1.metrics.availableDays, 5);
  assert.strictEqual(res1.metrics.stockoutDays, 0);
  assert.strictEqual(res1.metrics.averageDailyDemandWhileAvailable, 3.0); // 15 / 5

  assert.strictEqual(res2.metrics.availableDays, 4);
  assert.strictEqual(res2.metrics.stockoutDays, 1); // Day 3 stockout
  assert.strictEqual(res2.metrics.averageDailyDemandWhileAvailable, 3.75); // 15 / 4

  console.log('  ✅ Test E.1 Passed: Chronology distinguishes stockout and demand velocity despite identical aggregate totals.\n');
}

// -------------------------------------------------------------
// Test E.2: Identical Aggregate Totals with Unknown Inward Dates & No Reliable Opening Chronology
// -------------------------------------------------------------
console.log('--- Test E.2: Unknown Inward Dates & No Reliable Opening Chronology ---');
{
  // Opening = 0 (assumed), Sales = 15, Inward = 15 (no dated purchase bills). Closing = 0.
  const moves = [
    { date: new Date(2026, 4, 2), quantity: 5, transactionType: 'Sale' },
    { date: new Date(2026, 4, 5), quantity: 10, transactionType: 'Sale' },
  ];

  const res = reconstructSkuStock({
    skuKey: 'SKU-E2-UNDATED',
    itemName: 'UNDATED INWARD ITEM',
    openingStock: 0,
    hasExplicitOpeningEvidence: false,
    stockDetailClosing: 0,
    stockDetailIn: 15,
    stockDetailOut: 15,
    movements: moves,
    periodBounds: { from: new Date(2026, 4, 1), to: new Date(2026, 4, 5) },
  });

  // Must be BOUNDED, not VERIFIED; firstStockoutDate must be null (no fake date)
  assert.strictEqual(res.metrics.availabilityConfidence, 'BOUNDED');
  assert.strictEqual(res.metrics.firstStockoutDate, null);
  assert.strictEqual(res.metrics.stockoutWindow.type, 'INTERVAL');
  assert.strictEqual(res.metrics.isProvisional, true);
  console.log('  ✅ Test E.2 Passed: Engine returns BOUNDED with interval window without manufacturing an exact stockout date.\n');
}

// -------------------------------------------------------------
// Test E.3: VERIFIED Availability with Fewer Than 14 Valid Available Days (Sparse Warning Preserved)
// -------------------------------------------------------------
console.log('--- Test E.3: VERIFIED Availability with < 14 Available Days ---');
{
  // Period = 30 days. Starts with 10 (verified opening). Sells 10 over 5 days (2/day).
  const movements = [
    { date: new Date(2026, 4, 1), quantity: 2, transactionType: 'Sale' },
    { date: new Date(2026, 4, 2), quantity: 2, transactionType: 'Sale' },
    { date: new Date(2026, 4, 3), quantity: 2, transactionType: 'Sale' },
    { date: new Date(2026, 4, 4), quantity: 2, transactionType: 'Sale' },
    { date: new Date(2026, 4, 5), quantity: 2, transactionType: 'Sale' },
  ];

  const res = reconstructSkuStock({
    skuKey: 'SKU-E3',
    itemName: 'SPARSE VERIFIED ITEM',
    openingStock: 10,
    hasExplicitOpeningEvidence: true,
    stockDetailClosing: 0,
    stockDetailIn: 0,
    stockDetailOut: 10,
    movements,
    periodBounds: { from: new Date(2026, 4, 1), to: new Date(2026, 4, 30) },
  });

  assert.strictEqual(res.metrics.availabilityConfidence, 'VERIFIED');
  assert.strictEqual(res.metrics.availableDays, 5); // < 14 days

  // Now pass to salesAnalysis:
  const reconMap = new Map();
  reconMap.set('SPARSE VERIFIED ITEM', res);

  const saleRecords = movements.map(m => ({ itemName: 'SPARSE VERIFIED ITEM', ...m }));
  const analysis = analyzeSalesPatterns(saleRecords, { reconstructedMap: reconMap });
  const item = analysis.items['SPARSE VERIFIED ITEM'];

  // Critical assertion: VERIFIED availability must NOT override sparse-demand warning!
  assert.strictEqual(item.isProvisional, true);
  assert.ok(item.provisionalReason.includes('Sparse observations'));
  assert.strictEqual(item.trend, 'insufficient-data');
  console.log('  ✅ Test E.3 Passed: VERIFIED availability correctly retains sparse-demand provisional warning.\n');
}

// -------------------------------------------------------------
// Test E.4: BOUNDED Availability with Insufficient Evidence for Reliable Demand Estimate
// -------------------------------------------------------------
console.log('--- Test E.4: BOUNDED Availability with Insufficient Evidence ---');
{
  const saleRecords = [
    { itemName: 'BOUNDED SPARSE', date: new Date(2026, 4, 2), quantity: 1, transactionType: 'Sale' },
    { itemName: 'BOUNDED SPARSE', date: new Date(2026, 4, 20), quantity: 1, transactionType: 'Sale' },
  ];

  const res = reconstructSkuStock({
    skuKey: 'SKU-E4',
    itemName: 'BOUNDED SPARSE',
    openingStock: 0,
    hasExplicitOpeningEvidence: false,
    stockDetailClosing: 0,
    stockDetailIn: 2, // undated
    stockDetailOut: 2,
    movements: saleRecords,
    periodBounds: { from: new Date(2026, 4, 1), to: new Date(2026, 4, 30) },
  });

  assert.strictEqual(res.metrics.availabilityConfidence, 'BOUNDED');

  const reconMap = new Map();
  reconMap.set('BOUNDED SPARSE', res);
  const analysis = analyzeSalesPatterns(saleRecords, { reconstructedMap: reconMap });
  const item = analysis.items['BOUNDED SPARSE'];

  // Calendar baseline must be retained with provisional warning; not silently made an availability-adjusted forecast
  assert.strictEqual(item.isProvisional, true);
  assert.strictEqual(item.fullPeriodAvgDailyDemand, item.calendarAvgDailyDemand);
  assert.ok(item.provisionalReason.includes('Bounded availability'));
  console.log('  ✅ Test E.4 Passed: BOUNDED item uses calendar baseline demand with provisional disclosure.\n');
}

// -------------------------------------------------------------
// Test E.5: A Trend Window with Zero Valid Available Days
// -------------------------------------------------------------
console.log('--- Test E.5: Trend Window with Zero Valid Available Days ---');
{
  const dailyValues = [
    ...Array(14).fill(2), // prior window: 2/day
    ...Array(14).fill(0), // recent window: 0 sales (due to stockout)
  ];
  const dailyStates = [
    ...Array.from({ length: 14 }, () => ({ status: 'AVAILABLE', sales: 2 })),
    ...Array.from({ length: 14 }, () => ({ status: 'STOCKOUT', sales: 0 })),
  ];

  const trendResult = detectTrend(dailyValues, 14, dailyStates);
  assert.strictEqual(trendResult.trend, 'insufficient-data');
  assert.ok(trendResult.reason.includes('Stockout in recent window'));
  console.log('  ✅ Test E.5 Passed: Zero available days in recent window triggers insufficient-data trend.\n');
}

// -------------------------------------------------------------
// Test E.6: Recent Trend Window with Some Available Days and Unchanged Velocity Despite Stockout
// -------------------------------------------------------------
console.log('--- Test E.6: Recent Trend Window with Unchanged Velocity Despite Stockout ---');
{
  // 28 days total: 14 prior, 14 recent.
  // Prior: 14 days available, 28 sold -> velocity = 2.0 units/day.
  // Recent: 7 days available (selling 2/day = 14 units total), 7 days stockout (0 units sold).
  // Total calendar sales dropped from 28 to 14 (-50% naive calendar drop).
  // BUT velocity while available was 2.0 in prior and 2.0 in recent!
  const dailyValues = [
    ...Array(14).fill(2),
    ...Array(7).fill(2),
    ...Array(7).fill(0),
  ];
  const dailyStates = [
    ...Array.from({ length: 14 }, () => ({ status: 'AVAILABLE', sales: 2 })),
    ...Array.from({ length: 7 }, () => ({ status: 'AVAILABLE', sales: 2 })),
    ...Array.from({ length: 7 }, () => ({ status: 'STOCKOUT', sales: 0 })),
  ];

  const trendResult = detectTrend(dailyValues, 14, dailyStates);
  assert.strictEqual(trendResult.trend, 'stable'); // Unchanged velocity of 2.0/day recognized!
  assert.strictEqual(trendResult.recentAvg, 2.0);
  assert.strictEqual(trendResult.priorAvg, 2.0);
  assert.strictEqual(trendResult.changePct, 0);
  console.log('  ✅ Test E.6 Passed: Unchanged demand velocity recognized as STABLE despite 50% stockout exposure.\n');
}

// -------------------------------------------------------------
// Test E.7: Fresh Stock Snapshot Later Than Latest Dated Transaction
// -------------------------------------------------------------
console.log('--- Test E.7: Stock Snapshot Later Than Latest Dated Transaction ---');
{
  // Transactions end on Oct 1. Stock snapshot taken on Oct 6 (5 days later).
  const movements = [
    { date: new Date(2026, 9, 1), quantity: 5, transactionType: 'Sale' },
  ];
  const snapshotDate = new Date(2026, 9, 6);

  const res = reconstructSkuStock({
    skuKey: 'SKU-E7',
    itemName: 'GAP TEST ITEM',
    openingStock: 10,
    hasExplicitOpeningEvidence: true,
    stockDetailClosing: 5,
    stockDetailIn: 0,
    stockDetailOut: 5,
    movements,
    periodBounds: { from: new Date(2026, 8, 1), to: snapshotDate },
  });

  assert.strictEqual(res.reconciliationStatus, 'RECONCILED');
  assert.strictEqual(res.metrics.analysisPeriodDays, 36); // Sept 1 to Oct 6 = 36 days
  assert.strictEqual(res.metrics.availableDays, 36); // Remains at 5 units through snapshot
  assert.strictEqual(res.reconstructedClosingStock, 5);
  console.log('  ✅ Test E.7 Passed: Engine handles transaction-to-snapshot gap cleanly across 36 calendar days.\n');
}

// -------------------------------------------------------------
// Test F: Genuine In-Stock Zero-Sales SKU
// -------------------------------------------------------------
console.log('--- Test F: Genuine In-Stock Zero-Sales Days SKU ---');
{
  const movements = [
    { date: new Date(2026, 4, 1), quantity: 2, transactionType: 'Sale' },
    { date: new Date(2026, 4, 4), quantity: 1, transactionType: 'Sale' },
  ];

  const res = reconstructSkuStock({
    skuKey: 'SKU-F',
    itemName: 'PARLE G 250 GM',
    openingStock: 10,
    hasExplicitOpeningEvidence: true,
    stockDetailClosing: 7,
    stockDetailIn: 0,
    stockDetailOut: 3,
    movements,
    periodBounds: { from: new Date(2026, 4, 1), to: new Date(2026, 4, 5) },
  });

  assert.strictEqual(res.metrics.availableDays, 5);
  assert.strictEqual(res.metrics.stockoutDays, 0);
  assert.strictEqual(res.metrics.salesWhileAvailable, 3);
  assert.strictEqual(res.metrics.averageDailyDemandWhileAvailable, 0.6); // 3 / 5 days
  assert.strictEqual(res.reconstructedClosingStock, 7);
  assert.strictEqual(res.reconciliationStatus, 'RECONCILED');
  console.log('  ✅ Test F Passed: Zero-sales with stock > 0 retained as valid zero-demand observations.\n');
}

// -------------------------------------------------------------
// Test G: Movement-Type-Aware Reversals & Discrepancy
// -------------------------------------------------------------
console.log('--- Test G: Movement-Type-Aware Reversals & Discrepancy ---');
{
  const movements = [
    { date: new Date(2026, 4, 1), quantity: 10, transactionType: 'Purchase' },
    { date: new Date(2026, 4, 2), quantity: 3, transactionType: 'Debit Note', isDebitNote: true },
    { date: new Date(2026, 4, 3), quantity: 5, transactionType: 'Sale' },
  ];

  const res = reconstructSkuStock({
    skuKey: 'SKU-G',
    itemName: 'PTNJLI DISHWASH BAR 600G',
    openingStock: 10,
    hasExplicitOpeningEvidence: true,
    stockDetailClosing: 8, // Discrepancy (reconstructed = 12)
    stockDetailIn: 7,      // 10 - 3
    stockDetailOut: 5,
    movements,
    periodBounds: { from: new Date(2026, 4, 1), to: new Date(2026, 4, 3) },
  });

  assert.strictEqual(res.totals.purchases, 10);
  assert.strictEqual(res.totals.debitNotes, 3);
  assert.strictEqual(res.totals.sales, 5);
  assert.strictEqual(res.reconstructedClosingStock, 12);
  assert.strictEqual(res.operationalStock, 8); // clamped to physical stock detail closing
  assert.strictEqual(res.reconciliationStatus, 'STOCK_RECONSTRUCTION_MISMATCH');
  assert.strictEqual(res.reconciliationDifference, 4);
  console.log('  ✅ Test G Passed: Movement-type signs verified; discrepancy flagged without forced figures.\n');
}

// -------------------------------------------------------------
// Test I: Negative Running Balance Dip / Unanchored Chronology
// -------------------------------------------------------------
console.log('--- Test I: Negative Running Balance Dip / Unanchored ---');
{
  const movements = [
    { date: new Date(2026, 4, 1), quantity: 5, transactionType: 'Sale' },
    { date: new Date(2026, 4, 3), quantity: 10, transactionType: 'Purchase' },
  ];

  const res = reconstructSkuStock({
    skuKey: 'SKU-I',
    itemName: 'DIP ITEM',
    openingStock: 0,
    stockDetailClosing: 5,
    stockDetailIn: 10,
    stockDetailOut: 5,
    movements,
    periodBounds: { from: new Date(2026, 4, 1), to: new Date(2026, 4, 3) },
  });

  assert.strictEqual(res.metrics.availabilityConfidence, 'INDETERMINATE');
  assert.strictEqual(res.metrics.isProvisional, true);
  console.log('  ✅ Test I Passed: Negative running stock dip classified as INDETERMINATE.\n');
}

// -------------------------------------------------------------
// Test J: Trend Distortion Caused by Stockout
// -------------------------------------------------------------
console.log('--- Test J: Trend Distortion Caused by Stockout ---');
{
  const dailyValues = [
    ...Array(14).fill(2), // prior window: 2/day
    ...Array(14).fill(0), // recent window: 0 sales (due to stockout)
  ];

  const dailyStates = [
    ...Array.from({ length: 14 }, () => ({ status: 'AVAILABLE', sales: 2 })),
    ...Array.from({ length: 14 }, () => ({ status: 'STOCKOUT', sales: 0 })),
  ];

  const naiveTrend = detectTrend(dailyValues, 14, null);
  assert.strictEqual(naiveTrend.trend, 'falling');

  const awareTrend = detectTrend(dailyValues, 14, dailyStates);
  assert.strictEqual(awareTrend.trend, 'insufficient-data');
  assert.ok(awareTrend.reason.includes('Stockout in recent window'));
  console.log('  ✅ Test J Passed: Stockout in recent window prevented false falling demand classification!\n');
}

// -------------------------------------------------------------
// Test K: Safeguard 1 - Raw negative upper bound detected as infeasible / INDETERMINATE, NOT clamped to STOCKOUT
// -------------------------------------------------------------
console.log('--- Test K: Safeguard 1 - Raw Negative Upper Bound Feasibility Check ---');
{
  // Assume opening = 0, purchases = 5 (dated), undated inward = 0.
  // Sales = 10 (dated).
  // rawPastMax = 0 + 5 + 0 - 10 = -5 < 0.
  // Must NOT clamp rawPastMax = -5 to 0 and call it STOCKOUT!
  const movements = [
    { date: new Date(2026, 4, 1), quantity: 5, transactionType: 'Purchase' },
    { date: new Date(2026, 4, 2), quantity: 10, transactionType: 'Sale' },
    { date: new Date(2026, 4, 3), quantity: 0, transactionType: 'Sale' },
  ];

  const res = reconstructSkuStock({
    skuKey: 'SKU-SAFEGUARD-1',
    itemName: 'CONTRADICTORY SALES SKU',
    openingStock: 0,
    hasExplicitOpeningEvidence: true,
    stockDetailClosing: 0,
    stockDetailIn: 5,
    stockDetailOut: 10,
    movements,
    periodBounds: { from: new Date(2026, 4, 1), to: new Date(2026, 4, 3) },
  });

  const day3 = res.dailyStates[2];
  assert.strictEqual(day3.status, 'INDETERMINATE', 'Infeasible raw upper bound must be classified INDETERMINATE, not STOCKOUT');
  assert.ok(day3.rawMaxFeasibleStock < 0, 'rawMaxFeasibleStock must be negative before clamping');
  assert.strictEqual(day3.maxFeasibleStock, 0, 'Clamped operational stock must be non-negative');
  console.log('  ✅ Safeguard 1 Passed: Raw negative upper bound correctly flagged as INDETERMINATE, not converted to STOCKOUT.\n');
}

// -------------------------------------------------------------
// Test L: Safeguard 2 - [0, 8] balance interval producing UNKNOWN
// -------------------------------------------------------------
console.log('--- Test L: Safeguard 2 - [0, 8] Balance Interval Produces UNKNOWN ---');
{
  // Undated inward item with minFeasibleStock = 0, maxFeasibleStock = 8.
  // S_max = 8 > 0, so stockout is NOT proven. S_min = 0, so available is NOT proven.
  const movements = [
    { date: new Date(2026, 4, 1), quantity: 2, transactionType: 'Sale' },
    { date: new Date(2026, 4, 5), quantity: 8, transactionType: 'Sale' },
  ];

  const res = reconstructSkuStock({
    skuKey: 'SKU-SAFEGUARD-2',
    itemName: 'INTERVAL 0 TO 8 SKU',
    openingStock: 0,
    hasExplicitOpeningEvidence: false,
    stockDetailClosing: 0,
    stockDetailIn: 10, // undated inward = 10
    stockDetailOut: 10,
    movements,
    periodBounds: { from: new Date(2026, 4, 1), to: new Date(2026, 4, 5) },
  });

  // Day 3 (2026-05-03): cumulative sales = 2, future sales = 8.
  // rawPastMax = 0 + 0 + 10 - 2 = 8. rawFutureMax = 0 + 8 - 0 = 8.
  // min = 0, max = 8.
  const day3 = res.dailyStates[2];
  assert.strictEqual(day3.minFeasibleStock, 0);
  assert.strictEqual(day3.maxFeasibleStock, 8);
  assert.strictEqual(day3.status, 'UNKNOWN', 'A [0, 8] interval must be classified UNKNOWN');
  console.log('  ✅ Safeguard 2 Passed: [0, 8] balance interval correctly produces UNKNOWN.\n');
}

// -------------------------------------------------------------
// Test M: Safeguard 3 - Unknown inward occurring after candidate stockout date
// -------------------------------------------------------------
console.log('--- Test M: Safeguard 3 - Unknown Inward After Candidate Stockout Date ---');
{
  // If undated inward can arrive at ANY point in the period, a day before future sales cease cannot be declared stockout.
  const movements = [
    { date: new Date(2026, 4, 1), quantity: 5, transactionType: 'Sale' },
    { date: new Date(2026, 4, 4), quantity: 5, transactionType: 'Sale' },
  ];

  const res = reconstructSkuStock({
    skuKey: 'SKU-SAFEGUARD-3',
    itemName: 'UNDATED INWARD PENDING SALES SKU',
    openingStock: 0,
    hasExplicitOpeningEvidence: false,
    stockDetailClosing: 0,
    stockDetailIn: 10,
    stockDetailOut: 10,
    movements,
    periodBounds: { from: new Date(2026, 4, 1), to: new Date(2026, 4, 5) },
  });

  // Day 2 (between sales): sales = 0, but future sales = 5 and undated inward = 10.
  // Stockout cannot be declared because unknown inward could have arrived on Day 2 or Day 3 to satisfy Day 4 sales.
  const day2 = res.dailyStates[1];
  assert.strictEqual(day2.status, 'UNKNOWN');
  assert.ok(day2.maxFeasibleStock > 0);
  console.log('  ✅ Safeguard 3 Passed: Days prior to later sales remain UNKNOWN when undated inward can arrive.\n');
}

// -------------------------------------------------------------
// Test N: Safeguard 4 - Dated future sales without evidence of prior-day availability
// -------------------------------------------------------------
console.log('--- Test N: Safeguard 4 - Dated Future Sales Without Prior Availability Proof ---');
{
  // S_closing = 0, sales on day 5 = 4 units. Day 3 has 0 sales.
  // Does day 3 qualify as AVAILABLE? Absolutely not: without dated inward, availability cannot be proven!
  const movements = [
    { date: new Date(2026, 4, 5), quantity: 4, transactionType: 'Sale' },
  ];

  const res = reconstructSkuStock({
    skuKey: 'SKU-SAFEGUARD-4',
    itemName: 'FUTURE SALES NO PRIOR PROOF SKU',
    openingStock: 0,
    hasExplicitOpeningEvidence: false,
    stockDetailClosing: 0,
    stockDetailIn: 4,
    stockDetailOut: 4,
    movements,
    periodBounds: { from: new Date(2026, 4, 1), to: new Date(2026, 4, 5) },
  });

  const day3 = res.dailyStates[2];
  assert.notStrictEqual(day3.status, 'AVAILABLE', 'Prior-day cannot be inferred AVAILABLE merely because later sales exist');
  assert.strictEqual(day3.status, 'UNKNOWN');
  console.log('  ✅ Safeguard 4 Passed: Future sales do NOT infer earlier availability without dated proof.\n');
}

// -------------------------------------------------------------
// Test O: Safeguard 5 - Valid, proven terminal stockout with closing stock zero and no later movement
// -------------------------------------------------------------
console.log('--- Test O: Safeguard 5 - Valid Proven Terminal Stockout ---');
{
  // Item sells 5 on Day 2. Closing stock is 0. No further purchases or sales on Days 3, 4, 5.
  const movements = [
    { date: new Date(2026, 4, 2), quantity: 5, transactionType: 'Sale' },
  ];

  const res = reconstructSkuStock({
    skuKey: 'SKU-SAFEGUARD-5',
    itemName: 'TERMINAL STOCKOUT VALIDATION SKU',
    openingStock: 0,
    hasExplicitOpeningEvidence: false,
    stockDetailClosing: 0,
    stockDetailIn: 5,
    stockDetailOut: 5,
    movements,
    periodBounds: { from: new Date(2026, 4, 1), to: new Date(2026, 4, 5) },
  });

  // Day 3, 4, 5: future sales = 0, closing stock = 0, past inward exhausted (5 - 5 = 0).
  // rawMaxFeasibleStock = 0, minFeasibleStock = 0.
  const day3 = res.dailyStates[2];
  const day4 = res.dailyStates[3];
  const day5 = res.dailyStates[4];

  assert.strictEqual(day3.status, 'STOCKOUT');
  assert.strictEqual(day4.status, 'STOCKOUT');
  assert.strictEqual(day5.status, 'STOCKOUT');
  assert.strictEqual(day3.maxFeasibleStock, 0);
  console.log('  ✅ Safeguard 5 Passed: Terminal stockout with zero closing stock and zero later movement correctly verified.\n');
}

// -------------------------------------------------------------
// Test P: Safeguard 6 - Reconciliation totals that match but whose constraints are temporally inconsistent
// -------------------------------------------------------------
console.log('--- Test P: Safeguard 6 - Temporally Inconsistent Constraints Flagged INDETERMINATE ---');
{
  // Total purchases = 10, total sales = 10, closing = 0. Aggregate totals match perfectly!
  // BUT sales happen on Day 1 (10 units), and dated purchases arrive on Day 5 (10 units).
  // On Day 2: rawPastMax = 0 + 0 + 0 - 10 = -10 < 0!
  // Temporally impossible without unrecorded opening stock or backdated inward!
  const movements = [
    { date: new Date(2026, 4, 1), quantity: 10, transactionType: 'Sale' },
    { date: new Date(2026, 4, 5), quantity: 10, transactionType: 'Purchase' },
  ];

  const res = reconstructSkuStock({
    skuKey: 'SKU-SAFEGUARD-6',
    itemName: 'TEMPORALLY INCONSISTENT SKU',
    openingStock: 0,
    hasExplicitOpeningEvidence: true,
    stockDetailClosing: 0,
    stockDetailIn: 10,
    stockDetailOut: 10,
    movements,
    periodBounds: { from: new Date(2026, 4, 1), to: new Date(2026, 4, 5) },
  });

  // Day 2 has negative raw upper bound
  const day2 = res.dailyStates[1];
  assert.strictEqual(day2.status, 'INDETERMINATE', 'Temporally inconsistent ledger must be classified INDETERMINATE');
  assert.strictEqual(day2.rawMaxFeasibleStock, -10);
  console.log('  ✅ Safeguard 6 Passed: Temporally inconsistent constraints flagged INDETERMINATE despite aggregate match.\n');
}

// -------------------------------------------------------------
// Test Q: Safeguard 7 - Untrusted opening cannot cause false stockout when true opening is positive
// -------------------------------------------------------------
console.log('--- Test Q: Safeguard 7 - Untrusted Positive Opening Cannot Cause False Stockout ---');
{
  // Physical reality: True opening was 5 units. No dated purchases.
  // Day 1: sells 1 unit. Day 2: 0 sales. Day 3: sells 4 units.
  // Closing stock in Stock Detail is 0. Total sales = 5.
  // BUT in Vyapar, openingStock field was reported as 0 or missing (untrusted)!
  // On Day 2, physical stock was actually 4 units (AVAILABLE).
  // Because opening is untrusted, the engine MUST NOT assume opening = 0, which would give
  // rawPastMax = 0 + 0 - 1 = -1 (or 0) and falsely declare Day 2 a STOCKOUT!
  const movements = [
    { date: new Date(2026, 4, 1), quantity: 1, transactionType: 'Sale' },
    { date: new Date(2026, 4, 3), quantity: 4, transactionType: 'Sale' },
  ];

  const res = reconstructSkuStock({
    skuKey: 'SKU-SAFEGUARD-7',
    itemName: 'UNTRUSTED OPENING POSITIVE SKU',
    openingStock: 0, // untrusted 0 in report
    hasExplicitOpeningEvidence: false,
    stockDetailClosing: 0,
    stockDetailIn: 5, // 5 units in stock detail
    stockDetailOut: 5,
    movements,
    periodBounds: { from: new Date(2026, 4, 1), to: new Date(2026, 4, 3) },
  });

  // Day 2:
  const day2 = res.dailyStates[1];
  assert.notStrictEqual(day2.status, 'STOCKOUT', 'Day 2 must NOT be classified STOCKOUT when true opening was positive');
  assert.strictEqual(day2.status, 'UNKNOWN', 'Day 2 must be classified UNKNOWN due to unverified opening chronology');
  assert.ok(day2.maxFeasibleStock >= 4, 'Day 2 upper bound must reflect potential stock (at least 4 units)');
  console.log('  ✅ Safeguard 7 Passed: Untrusted opening correctly prevented false stockout; marked UNKNOWN with positive upper bound.\n');
}

// -------------------------------------------------------------
// Test R: Pipeline Boundary - Reorder Formula & Classification Gate
// -------------------------------------------------------------
console.log('--- Test R: Pipeline Boundary - Reorder Formula & Classification Gate ---');
{
  const { generatePurchaseSuggestions } = require('../purchaseSuggestions');

  // Case 1 & 2: EDD = 0.45, stdDev = 0.589, L = 3, C = 15, stock = 0
  // SS = ceil(1.65 * 0.589 * sqrt(3)) = ceil(1.683) = 2
  // ROP = ceil(0.45 * 3 + 2) = ceil(3.35) = 4
  // TS = ceil(0.45 * 15 + 2) = ceil(8.75) = 9
  // Q = max(0, ceil(9 - 0)) = 9
  const resCase1 = generatePurchaseSuggestions({
    salesAnalysis: {
      'TEST-SKU-JIMJAM-THEORY': {
        totalSold: 85,
        periodDays: 189,
        fullPeriodAvgDailyDemand: 0.45,
        recentAvgDailyDemand: null,
        priorAvgDailyDemand: null,
        dailyStdDev: 0.589,
        trend: 'stable',
      },
    },
    currentStockByItem: { 'TEST-SKU-JIMJAM-THEORY': { quantity: 0, asOfDate: new Date() } },
    config: { leadTimeDays: 3, orderCoverageDays: 15, serviceLevel: 0.95 },
  });

  const sug1 = resCase1.suggestions[0];
  assert.strictEqual(sug1.safetyStock, 2, 'SS must equal 2');
  assert.strictEqual(sug1.reorderPoint, 4, 'ROP must equal 4');
  assert.strictEqual(sug1.targetStock, 9, 'TS must equal 9');
  assert.strictEqual(sug1.suggestedOrderQty, 9, 'Q must equal 9 for zero physical stock');
  assert.strictEqual(sug1.classification, 'BUY_NOW', 'Classification must be BUY_NOW');

  // Case 3: Stock below ROP (stock = 3 < 4) -> BUY NOW, Q = TS - currentPhysicalStock = 9 - 3 = 6
  const resCase3 = generatePurchaseSuggestions({
    salesAnalysis: {
      'TEST-SKU-BUY': {
        totalSold: 85,
        periodDays: 189,
        fullPeriodAvgDailyDemand: 0.45,
        recentAvgDailyDemand: null,
        priorAvgDailyDemand: null,
        dailyStdDev: 0.589,
        trend: 'stable',
      },
    },
    currentStockByItem: { 'TEST-SKU-BUY': { quantity: 3, asOfDate: new Date() } },
    config: { leadTimeDays: 3, orderCoverageDays: 15, serviceLevel: 0.95 },
  });
  const sug3 = resCase3.suggestions[0];
  assert.strictEqual(sug3.classification, 'BUY_NOW');
  assert.strictEqual(sug3.suggestedOrderQty, 6, 'Q must equal 6 (9 - 3)');

  // Case 4: Stock at ROP (stock = 4) and within watch threshold (4 <= 4 * 1.25 = 5.0) -> WATCH
  // Independent Q formula: Q = max(0, ceilClean(TS - Stock)) = 9 - 4 = 5, and 9 - 5 = 4
  const resCase4 = generatePurchaseSuggestions({
    salesAnalysis: {
      'TEST-SKU-WATCH-1': {
        totalSold: 85,
        periodDays: 189,
        fullPeriodAvgDailyDemand: 0.45,
        recentAvgDailyDemand: null,
        priorAvgDailyDemand: null,
        dailyStdDev: 0.589,
        trend: 'stable',
      },
      'TEST-SKU-WATCH-2': {
        totalSold: 85,
        periodDays: 189,
        fullPeriodAvgDailyDemand: 0.45,
        recentAvgDailyDemand: null,
        priorAvgDailyDemand: null,
        dailyStdDev: 0.589,
        trend: 'stable',
      },
    },
    currentStockByItem: {
      'TEST-SKU-WATCH-1': { quantity: 4, asOfDate: new Date() },
      'TEST-SKU-WATCH-2': { quantity: 5, asOfDate: new Date() },
    },
    config: { leadTimeDays: 3, orderCoverageDays: 15, serviceLevel: 0.95, watchThresholdFactor: 1.25 },
  });
  const sug4_1 = resCase4.suggestions.find(s => s.itemName === 'TEST-SKU-WATCH-1');
  const sug4_2 = resCase4.suggestions.find(s => s.itemName === 'TEST-SKU-WATCH-2');
  assert.strictEqual(sug4_1.classification, 'WATCH', 'Stock = ROP (4) must be classified WATCH');
  assert.strictEqual(sug4_1.suggestedOrderQty, 5, 'Independent formula: TS(9) - Stock(4) = 5');
  assert.strictEqual(sug4_2.classification, 'WATCH', 'Stock = ROP * 1.25 (5) must be classified WATCH');
  assert.strictEqual(sug4_2.suggestedOrderQty, 4, 'Independent formula: TS(9) - Stock(5) = 4');

  // Case 5: Stock above ROP * 1.25 (stock = 6 > 5) -> OK, Q = 9 - 6 = 3 (and stock >= 9 -> Q = 0)
  const resCase5 = generatePurchaseSuggestions({
    salesAnalysis: {
      'TEST-SKU-OK': {
        totalSold: 85,
        periodDays: 189,
        fullPeriodAvgDailyDemand: 0.45,
        recentAvgDailyDemand: null,
        priorAvgDailyDemand: null,
        dailyStdDev: 0.589,
        trend: 'stable',
      },
      'TEST-SKU-OK-COVERED': {
        totalSold: 85,
        periodDays: 189,
        fullPeriodAvgDailyDemand: 0.45,
        recentAvgDailyDemand: null,
        priorAvgDailyDemand: null,
        dailyStdDev: 0.589,
        trend: 'stable',
      },
    },
    currentStockByItem: {
      'TEST-SKU-OK': { quantity: 6, asOfDate: new Date() },
      'TEST-SKU-OK-COVERED': { quantity: 10, asOfDate: new Date() },
    },
    config: { leadTimeDays: 3, orderCoverageDays: 15, serviceLevel: 0.95, watchThresholdFactor: 1.25 },
  });
  const sug5 = resCase5.suggestions.find(s => s.itemName === 'TEST-SKU-OK');
  const sug5_covered = resCase5.suggestions.find(s => s.itemName === 'TEST-SKU-OK-COVERED');
  assert.strictEqual(sug5.classification, 'OK', 'Stock > ROP * 1.25 must be classified OK');
  assert.strictEqual(sug5.suggestedOrderQty, 3, 'Independent formula: TS(9) - Stock(6) = 3');
  assert.strictEqual(sug5_covered.classification, 'OK', 'Stock >= TS must be classified OK');
  assert.strictEqual(sug5_covered.suggestedOrderQty, 0, 'Stock >= TS yields Q = 0');

  // Case 6: Zero demand -> Q = 0, classification OK
  const resCase6 = generatePurchaseSuggestions({
    salesAnalysis: {
      'TEST-SKU-ZERO-DEMAND': {
        totalSold: 0,
        periodDays: 189,
        fullPeriodAvgDailyDemand: 0,
        recentAvgDailyDemand: null,
        priorAvgDailyDemand: null,
        dailyStdDev: 0,
        trend: 'stable',
      },
    },
    currentStockByItem: { 'TEST-SKU-ZERO-DEMAND': { quantity: 0, asOfDate: new Date() } },
    config: { leadTimeDays: 3, orderCoverageDays: 15, serviceLevel: 0.95 },
  });
  const sug6 = resCase6.suggestions[0];
  assert.strictEqual(sug6.classification, 'OK', 'Zero demand must be classified OK');
  assert.strictEqual(sug6.suggestedOrderQty, 0, 'Zero demand must have Q = 0');

  // Case 7: Negative physical stock clamped to 0 for ordering -> Q = TS
  const resCase7 = generatePurchaseSuggestions({
    salesAnalysis: {
      'TEST-SKU-NEG-STOCK': {
        totalSold: 85,
        periodDays: 189,
        fullPeriodAvgDailyDemand: 0.45,
        recentAvgDailyDemand: null,
        priorAvgDailyDemand: null,
        dailyStdDev: 0.589,
        trend: 'stable',
      },
    },
    currentStockByItem: { 'TEST-SKU-NEG-STOCK': { quantity: -5, asOfDate: new Date() } },
    config: { leadTimeDays: 3, orderCoverageDays: 15, serviceLevel: 0.95 },
  });
  const sug7 = resCase7.suggestions[0];
  assert.strictEqual(sug7.classification, 'BUY_NOW');
  assert.strictEqual(sug7.suggestedOrderQty, 9, 'Negative stock clamped to 0 yields Q = TS (9)');

  // Case 8: Fractional-unit input producing consistent ceiling behavior
  // Stock = 2.4, TS = 9 -> unrounded = 9 - 2.4 = 6.6 -> ceil(6.6) = 7
  const resCase8 = generatePurchaseSuggestions({
    salesAnalysis: {
      'TEST-SKU-FRACTIONAL': {
        totalSold: 85,
        periodDays: 189,
        fullPeriodAvgDailyDemand: 0.45,
        recentAvgDailyDemand: null,
        priorAvgDailyDemand: null,
        dailyStdDev: 0.589,
        trend: 'stable',
      },
    },
    currentStockByItem: { 'TEST-SKU-FRACTIONAL': { quantity: 2.4, asOfDate: new Date() } },
    config: { leadTimeDays: 3, orderCoverageDays: 15, serviceLevel: 0.95 },
  });
  const sug8 = resCase8.suggestions[0];
  assert.strictEqual(sug8.classification, 'BUY_NOW');
  assert.strictEqual(sug8.suggestedOrderQty, 7, 'Fractional stock ceil(9 - 2.4) must equal 7');

  console.log('  ✅ Test R Passed: Pipeline boundary reorder formulas & all 8 classification/ceiling test cases verified.\n');
}

console.log('================================================================');
console.log('  ALL ACCEPTANCE GATE SCENARIOS PASSED WITH 100%!               ');
console.log('================================================================\n');
