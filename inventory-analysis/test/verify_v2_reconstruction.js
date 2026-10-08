const assert = require('assert');
const { reconstructSkuStock, toDayKey } = require('../stockReconstruction');

console.log('================================================================');
console.log('  RUNNING INVENTORY ASSISTANT V2 DIAGNOSTIC RECONSTRUCTION TESTS  ');
console.log('================================================================\n');

// -------------------------------------------------------------
// Test Case 1: Normal Continuously Stocked Product
// -------------------------------------------------------------
console.log('--- Test 1: Continuously Stocked SKU ---');
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
    skuKey: 'SKU-001',
    itemName: 'AMUL BUTTER 500 GM',
    itemCode: '890126201',
    openingStock,
    stockDetailClosing: 12,
    stockDetailIn: 0,
    stockDetailOut: 8,
    movements,
    periodBounds: { from: new Date(2026, 4, 1), to: new Date(2026, 4, 5) },
  });

  console.log(`  Analysis Days: ${res.metrics.analysisPeriodDays}, Available: ${res.metrics.availableDays}, Stockout: ${res.metrics.stockoutDays}`);
  console.log(`  Availability: ${res.metrics.availabilityPercent}%, Avg Demand: ${res.metrics.averageDailyDemandWhileAvailable}`);
  console.log(`  Closing Stock: Reconstructed = ${res.reconstructedClosingStock}, Stock Detail = ${res.stockDetailClosing} -> ${res.reconciliationStatus}`);

  assert.strictEqual(res.metrics.analysisPeriodDays, 5);
  assert.strictEqual(res.metrics.availableDays, 5);
  assert.strictEqual(res.metrics.stockoutDays, 0);
  assert.strictEqual(res.metrics.availabilityPercent, 100);
  assert.strictEqual(res.metrics.salesWhileAvailable, 8);
  assert.strictEqual(res.metrics.averageDailyDemandWhileAvailable, 1.6);
  assert.strictEqual(res.reconstructedClosingStock, 12);
  assert.strictEqual(res.reconciliationStatus, 'RECONCILED');
  assert.strictEqual(res.metrics.stockConstrained, false);
  console.log('  ✅ Test 1 Passed: 100% available, demand matches sales rate, reconciled perfectly.\n');
}

// -------------------------------------------------------------
// Test Case 2: Product Sold Out and Later Replenished
// -------------------------------------------------------------
console.log('--- Test 2: Sold Out Then Replenished SKU ---');
{
  // 5 days: starts at 4. Sells 4 on Day 1 (ending 0).
  // Days 2 & 3: in stockout (stock 0, sales 0).
  // Day 4: Replenished +10 by Purchase. Sells 2 (ending 8).
  // Day 5: Sells 1 (ending 7).
  const movements = [
    { date: new Date(2026, 4, 1), quantity: 4, transactionType: 'Sale' },
    { date: new Date(2026, 4, 4), quantity: 10, transactionType: 'Purchase' },
    { date: new Date(2026, 4, 4), quantity: 2, transactionType: 'Sale' },
    { date: new Date(2026, 4, 5), quantity: 1, transactionType: 'Sale' },
  ];

  const res = reconstructSkuStock({
    skuKey: 'SKU-002',
    itemName: 'KNR MUSTARD OIL 1 LTR',
    itemCode: '890126202',
    openingStock: 4,
    stockDetailClosing: 7,
    stockDetailIn: 10,
    stockDetailOut: 7,
    movements,
    periodBounds: { from: new Date(2026, 4, 1), to: new Date(2026, 4, 5) },
  });

  console.log(`  Analysis Days: ${res.metrics.analysisPeriodDays}, Available: ${res.metrics.availableDays}, Stockout: ${res.metrics.stockoutDays}`);
  console.log(`  First Stockout: ${toDayKey(res.metrics.firstStockoutDate)}, Replenished After Stockout: ${res.metrics.replenishedAfterStockout}`);
  console.log(`  Sales While Available: ${res.metrics.salesWhileAvailable}, Demand While Available: ${res.metrics.averageDailyDemandWhileAvailable}`);
  console.log(`  Closing Stock: Reconstructed = ${res.reconstructedClosingStock}, Stock Detail = ${res.stockDetailClosing} -> ${res.reconciliationStatus}`);

  assert.strictEqual(res.metrics.analysisPeriodDays, 5);
  assert.strictEqual(res.metrics.availableDays, 3); // Days 1, 4, 5
  assert.strictEqual(res.metrics.stockoutDays, 2);  // Days 2, 3
  assert.strictEqual(res.metrics.replenishedAfterStockout, true);
  assert.strictEqual(res.metrics.salesWhileAvailable, 7); // 4 on Day 1 + 2 on Day 4 + 1 on Day 5
  assert.strictEqual(res.metrics.averageDailyDemandWhileAvailable, 2.33); // 7 / 3 available days
  assert.strictEqual(res.reconstructedClosingStock, 7);
  assert.strictEqual(res.reconciliationStatus, 'RECONCILED');
  assert.strictEqual(res.metrics.stockConstrained, true);
  console.log('  ✅ Test 2 Passed: Stockout excluded from demand denominator, replenishment detected.\n');
}

// -------------------------------------------------------------
// Test Case 3: Product Sold Out and Never Replenished
// -------------------------------------------------------------
console.log('--- Test 3: Sold Out and Never Replenished SKU ---');
{
  // 5 days: starts at 4. Sells 4 on Day 1. Sits at 0 for Days 2, 3, 4, 5 with zero sales.
  const movements = [
    { date: new Date(2026, 4, 1), quantity: 4, transactionType: 'Sale' }
  ];

  const res = reconstructSkuStock({
    skuKey: 'SKU-003',
    itemName: 'HIMA PURI NEEM FW',
    itemCode: '890126203',
    openingStock: 4,
    stockDetailClosing: 0,
    stockDetailIn: 0,
    stockDetailOut: 4,
    movements,
    periodBounds: { from: new Date(2026, 4, 1), to: new Date(2026, 4, 5) },
  });

  console.log(`  Analysis Days: ${res.metrics.analysisPeriodDays}, Available: ${res.metrics.availableDays}, Stockout: ${res.metrics.stockoutDays}`);
  console.log(`  First Stockout: ${toDayKey(res.metrics.firstStockoutDate)}, Replenished: ${res.metrics.replenishedAfterStockout}`);
  console.log(`  Demand While Available: ${res.metrics.averageDailyDemandWhileAvailable}/day (Calendar Avg would be: ${(4/5).toFixed(2)}/day)`);

  assert.strictEqual(res.metrics.analysisPeriodDays, 5);
  assert.strictEqual(res.metrics.availableDays, 1);
  assert.strictEqual(res.metrics.stockoutDays, 4);
  assert.strictEqual(res.metrics.replenishedAfterStockout, false);
  assert.strictEqual(res.metrics.salesWhileAvailable, 4);
  assert.strictEqual(res.metrics.averageDailyDemandWhileAvailable, 4.0); // Not diluted to 0.8!
  assert.strictEqual(res.reconstructedClosingStock, 0);
  assert.strictEqual(res.reconciliationStatus, 'RECONCILED');
  assert.strictEqual(res.metrics.stockConstrained, true);
  console.log('  ✅ Test 3 Passed: Zero sales during stockout are NOT misinterpreted as demand collapse!\n');
}

// -------------------------------------------------------------
// Test Case 4: Product with Genuine Zero-Sales Days While in Stock
// -------------------------------------------------------------
console.log('--- Test 4: Genuine In-Stock Zero-Sales Days SKU ---');
{
  // 5 days: starts at 10. Sells 2 on Day 1, 0 on Day 2, 0 on Day 3, 1 on Day 4, 0 on Day 5.
  // Physical stock remains > 0 every day (10 -> 8 -> 8 -> 8 -> 7 -> 7).
  const movements = [
    { date: new Date(2026, 4, 1), quantity: 2, transactionType: 'Sale' },
    { date: new Date(2026, 4, 4), quantity: 1, transactionType: 'Sale' },
  ];

  const res = reconstructSkuStock({
    skuKey: 'SKU-004',
    itemName: 'PARLE G 250 GM',
    itemCode: '890126204',
    openingStock: 10,
    stockDetailClosing: 7,
    stockDetailIn: 0,
    stockDetailOut: 3,
    movements,
    periodBounds: { from: new Date(2026, 4, 1), to: new Date(2026, 4, 5) },
  });

  console.log(`  Analysis Days: ${res.metrics.analysisPeriodDays}, Available: ${res.metrics.availableDays}, Stockout: ${res.metrics.stockoutDays}`);
  console.log(`  Demand While Available: ${res.metrics.averageDailyDemandWhileAvailable}/day`);

  assert.strictEqual(res.metrics.analysisPeriodDays, 5);
  assert.strictEqual(res.metrics.availableDays, 5); // All 5 days available
  assert.strictEqual(res.metrics.stockoutDays, 0);
  assert.strictEqual(res.metrics.salesWhileAvailable, 3);
  assert.strictEqual(res.metrics.averageDailyDemandWhileAvailable, 0.6); // 3 / 5 days, zero days legitimately counted!
  assert.strictEqual(res.reconstructedClosingStock, 7);
  assert.strictEqual(res.reconciliationStatus, 'RECONCILED');
  assert.strictEqual(res.metrics.stockConstrained, false);
  console.log('  ✅ Test 4 Passed: Zero-sales days with stock > 0 are correctly preserved as valid zero-demand observations.\n');
}

// -------------------------------------------------------------
// Test Case 5: Product with Stock Reconciliation Mismatch & Debit Note
// -------------------------------------------------------------
console.log('--- Test 5: Reconciliation Mismatch SKU & Movement-Type-Aware Ledger ---');
{
  // Opening: 10. Purchases: 10. Debit Note: -3. Sales: 5.
  // Reconstructed ending: 10 + 10 - 3 - 5 = 12.
  // But Stock Detail recorded closingQty: 8 (perhaps unlogged shrink or barcode error).
  const movements = [
    { date: new Date(2026, 4, 1), quantity: 10, transactionType: 'Purchase' },
    { date: new Date(2026, 4, 2), quantity: 3, transactionType: 'Debit Note', isDebitNote: true },
    { date: new Date(2026, 4, 3), quantity: 5, transactionType: 'Sale' },
  ];

  const res = reconstructSkuStock({
    skuKey: 'SKU-005',
    itemName: 'PTNJLI DISHWASH BAR 600G',
    itemCode: '890126205',
    openingStock: 10,
    stockDetailClosing: 8, // Discrepancy!
    stockDetailIn: 7,      // 10 - 3 = 7
    stockDetailOut: 5,
    movements,
    periodBounds: { from: new Date(2026, 4, 1), to: new Date(2026, 4, 3) },
  });

  console.log(`  Totals: Purchases = +${res.totals.purchases}, Debit Notes = -${res.totals.debitNotes}, Sales = -${res.totals.sales}`);
  console.log(`  Closing Stock: Reconstructed = ${res.reconstructedClosingStock}, Stock Detail = ${res.stockDetailClosing}`);
  console.log(`  Reconciliation Status: ${res.reconciliationStatus}`);
  console.log(`  Mismatch Reasons:`, res.reconciliationMismatchReasons);

  assert.strictEqual(res.totals.purchases, 10);
  assert.strictEqual(res.totals.debitNotes, 3);
  assert.strictEqual(res.totals.sales, 5);
  assert.strictEqual(res.reconstructedClosingStock, 12);
  assert.strictEqual(res.stockDetailClosing, 8);
  assert.strictEqual(res.reconciliationStatus, 'STOCK_RECONSTRUCTION_MISMATCH');
  assert.strictEqual(res.reconciliationDifference, 4); // 12 - 8
  assert(res.reconciliationMismatchReasons.length > 0);
  console.log('  ✅ Test 5 Passed: Movement-type-aware signs verified and mismatch flagged without silent forcing.\n');
}

console.log('================================================================');
console.log('  ALL 5 V2 DIAGNOSTIC RECONSTRUCTION TEST CASES PASSED (100%)    ');
console.log('================================================================\n');
