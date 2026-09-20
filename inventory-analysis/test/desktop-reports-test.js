const assert = require('assert');
const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');

const { parseSaleReport, parseStockDetailReport } = require('../reportReaders');
const { runAnalysis } = require('../index');

console.log('Running Desktop Vyapar Reports Test Suite...\n');

const testResults = [];
function recordTest(name, passed, detail = '') {
  testResults.push({ name, passed, detail });
}

const DESKTOP_SALE_FILE = 'C:/Users/Admin/Downloads/SaleReport_01_08_26_to_30_09_26.xlsx';
const DESKTOP_STOCK_FILE = 'C:/Users/Admin/Downloads/StockDetailReport_01_09_26_to_20_09_26.xlsx';

// -------------------------------------------------------------
// 1. Desktop Sale Report Parsing (Item Details sheet auto-detection)
// -------------------------------------------------------------
try {
  assert(fs.existsSync(DESKTOP_SALE_FILE), `Sale report file not found at ${DESKTOP_SALE_FILE}`);

  const parsed = parseSaleReport(DESKTOP_SALE_FILE);
  assert(parsed.records.length > 0, 'Should parse records from desktop sale report');
  console.log(`  -> Desktop sale records parsed: ${parsed.records.length}`);

  const first = parsed.records[0];
  assert(first.itemName, 'Item name must be present');
  assert(typeof first.quantity === 'number', 'Quantity must be numeric');
  assert(first.date instanceof Date, 'Date must be valid Date object');
  assert(first.mrp !== null, 'MRP should be populated from UnitPrice');
  assert.strictEqual(first.mrpSource, 'Sale Report / UnitPrice', 'mrpSource must be "Sale Report / UnitPrice"');

  recordTest('Desktop Sale Report Parser', true, `${parsed.records.length} records parsed, UnitPrice mapped to MRP`);
} catch (e) {
  recordTest('Desktop Sale Report Parser', false, e.message);
}

// -------------------------------------------------------------
// 2. Desktop Stock Detail Report Parsing (Row 0 headers, no title date)
// -------------------------------------------------------------
try {
  assert(fs.existsSync(DESKTOP_STOCK_FILE), `Stock detail file not found at ${DESKTOP_STOCK_FILE}`);

  const parsed = parseStockDetailReport(DESKTOP_STOCK_FILE);
  assert(parsed.records.length > 0, 'Should parse records from desktop stock detail report');
  console.log(`  -> Desktop stock records parsed: ${parsed.records.length}`);

  assert.strictEqual(parsed.generationDate, null, 'generationDate must be null when title row is absent');
  assert.strictEqual(parsed.snapshotDateSource, 'not provided by export', 'snapshotDateSource must be "not provided by export"');

  // Verify item with known stock from real export
  const knownItem = parsed.records.find((r) => r.itemName === '10 NO PLATE');
  assert(knownItem, 'Expected to find "10 NO PLATE" in desktop stock detail');
  assert.strictEqual(knownItem.openingQty, 25, 'Opening quantity should match 25');
  assert.strictEqual(knownItem.closingQty, 25, 'Closing quantity should match 25');

  recordTest('Desktop Stock Detail Parser', true, `${parsed.records.length} records parsed, null generationDate handled cleanly`);
} catch (e) {
  recordTest('Desktop Stock Detail Parser', false, e.message);
}

// -------------------------------------------------------------
// 3. Mobile Stock Report Compatibility (Title date row preserved)
// -------------------------------------------------------------
try {
  // Create a synthetic mobile stock report with "Generated on <date>" at row 0
  const tmpDir = path.resolve(__dirname, '../../test_tmp');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
  const mobileStockPath = path.join(tmpDir, 'synthetic_mobile_stock.xlsx');

  const mobileRows = [
    ['Generated on Sept 15,2026 at 10:00 am'],
    [''],
    ['SL No.', 'Item Name', 'Opening Quantity', 'Quantity In', 'Quantity Out', 'Closing Quantity'],
    ['1', 'TEST ITEM 1', '10', '5', '3', '12'],
    ['2', 'TEST ITEM 2 N', '5', '0', '2', '3'],
  ];
  const ws = XLSX.utils.aoa_to_sheet(mobileRows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Stock Detail Report');
  XLSX.writeFile(wb, mobileStockPath);

  const mobileParsed = parseStockDetailReport(mobileStockPath);
  assert(mobileParsed.generationDate instanceof Date, 'Should parse generationDate from title');
  assert.strictEqual(mobileParsed.generationDate.getDate(), 15);
  assert.strictEqual(mobileParsed.generationDate.getMonth(), 8); // Sept = 8
  assert.strictEqual(mobileParsed.snapshotDateSource, 'title');
  assert.strictEqual(mobileParsed.records.length, 2);

  // Clean up
  if (fs.existsSync(mobileStockPath)) fs.unlinkSync(mobileStockPath);

  recordTest('Mobile Format Compatibility', true, 'Title generation date extracted and preserved');
} catch (e) {
  recordTest('Mobile Format Compatibility', false, e.message);
}

// -------------------------------------------------------------
// 4. Full Pipeline Integration with Real Desktop Reports
// -------------------------------------------------------------
try {
  const result = runAnalysis({
    saleReportPath: DESKTOP_SALE_FILE,
    stockDetailPath: DESKTOP_STOCK_FILE,
  });

  assert(result, 'runAnalysis should return a result object');
  assert(result.summary, 'result must have summary');
  assert(result.suggestions, 'result must have suggestions');
  assert(result.meta, 'result must have meta');
  assert.strictEqual(result.meta.stockSnapshotDate, null, 'meta.stockSnapshotDate must be null for desktop export');
  assert.strictEqual(result.meta.stockSnapshotDateSource, 'not provided by export');

  console.log(`  -> Full pipeline success:`);
  console.log(`     Total items: ${result.summary.totalItems}`);
  console.log(`     BUY_NOW: ${result.summary.buyNowCount}`);
  console.log(`     WATCH: ${result.summary.watchCount}`);
  console.log(`     OK: ${result.summary.okCount}`);
  console.log(`     Pending candidates: ${result.summary.pendingCandidatesCount}`);

  recordTest('Full Pipeline with Desktop Reports', true, 'Complete runAnalysis execution verified');
} catch (e) {
  recordTest('Full Pipeline with Desktop Reports', false, e.message);
}

// -------------------------------------------------------------
// Summary
// -------------------------------------------------------------
console.log('\nDesktop Vyapar Reports Validation Summary');
console.log('-----------------------------------------');
let allPassed = true;
for (const t of testResults) {
  const statusStr = t.passed ? 'PASS' : 'FAIL';
  const pad = ' '.repeat(Math.max(2, 38 - t.name.length));
  console.log(`${t.name}${pad}${statusStr}`);
  if (!t.passed) {
    console.error(`  -> Error: ${t.detail}`);
    allPassed = false;
  }
}
console.log('-----------------------------------------');
const passedCount = testResults.filter((r) => r.passed).length;
console.log(`Total: ${passedCount}/${testResults.length} passed.`);

if (!allPassed) {
  process.exit(1);
}
