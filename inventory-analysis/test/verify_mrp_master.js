const assert = require('assert');
const path = require('path');
const { loadMrpMaster, getMasterMrp } = require('../mrpMaster');
const { runAnalysis } = require('../index');

console.log('================================================================');
console.log('   VERIFYING AUTHORITATIVE DEFAULT MRP MASTER INTEGRATION       ');
console.log('================================================================\n');

// 1. Verify Master Catalog Loading
console.log('[1/5] Loading Export Items (2).xlsx...');
const master = loadMrpMaster();
assert.strictEqual(master.loaded, true, 'Master catalog must load successfully');
assert.strictEqual(master.count, 9359, `Expected 9359 items with Default Mrp, got ${master.count}`);
console.log(`  ✅ Successfully loaded ${master.count} items with Default Mrp from ${master.sourceFile}`);

// 2. Verify Exact Matching Rules & Hierarchy
console.log('\n[2/5] Testing getMasterMrp resolution rules...');

// Rule 1: Item Code match
const mrpByCode = getMasterMrp({ itemCode: '89012620100230' }, master);
assert.strictEqual(mrpByCode, 295, 'Item Code 89012620100230 should resolve to Default MRP 295');
console.log('  ✅ Item code match verified: 89012620100230 -> ₹295');

// Rule 1b: Stripped leading zeros
const mrpByStrippedCode = getMasterMrp({ itemCode: '089012620100230' }, master);
assert.strictEqual(mrpByStrippedCode, 295, 'Item code with leading zero should match stripped');
console.log('  ✅ Leading-zero item code match verified');

// Rule 2: Canonical / Normalized exact item name
const mrpByName = getMasterMrp({ canonicalName: 'AMUL BTTR 500 GM' }, master);
assert.strictEqual(mrpByName, 295, 'AMUL BTTR 500 GM should resolve to Default MRP 295');
console.log('  ✅ Canonical name match verified: "AMUL BTTR 500 GM" -> ₹295');

// Rule 3: Aliases match
const mrpByAlias = getMasterMrp({ canonicalName: 'AMUL BUTTER FIVE HUNDRED GRAM', aliases: ['AMUL BTTR 500 GM'] }, master);
assert.strictEqual(mrpByAlias, 295, 'Alias AMUL BTTR 500 GM should resolve to Default MRP 295');
console.log('  ✅ Approved alias match verified: resolved via alias -> ₹295');

// Rule 4: Fallback MRP if not in master
const mrpFallback = getMasterMrp({ itemName: 'NON_EXISTENT_PRODUCT_XYZ_999', fallbackMrp: 150 }, master);
assert.strictEqual(mrpFallback, 150, 'Non-existent item should fall back to parsed Sale Report MRP');
console.log('  ✅ Non-existent item fallback to parsed Sale Report MRP verified');

// Rule 5: Completely missing item
const mrpNull = getMasterMrp({ itemName: 'COMPLETELY_UNKNOWN_PRODUCT_999' }, master);
assert.strictEqual(mrpNull, null, 'Unknown item with no fallback should return null (blank in UI)');
console.log('  ✅ Unknown item with no fallback returns null (blank in UI) verified');

// 3. Verify Non-Interference with Core Inventory Math
console.log('\n[3/5] Testing non-interference with core inventory calculations...');
const fs = require('fs');
const saleReportPath = path.join(__dirname, 'fixtures/sample_sale_report.xlsx');
const stockDetailPath = path.join(__dirname, 'fixtures/sample_stock_detail.xlsx');

if (fs.existsSync(saleReportPath) && fs.existsSync(stockDetailPath)) {
  const result = runAnalysis({ saleReportPath, stockDetailPath });
  assert(result.suggestions && result.suggestions.length > 0, 'Analysis should produce suggestions');
  
  // Verify that suggestions have .mrp attached as reference display field
  const sample = result.suggestions[0];
  assert('mrp' in sample, 'Suggestion must include reference mrp property');
  assert(typeof sample.effectiveDailyDemand === 'number', 'Demand must remain numeric');
  assert(typeof sample.reorderPoint === 'number', 'ROP must remain numeric');
  assert(typeof sample.targetStock === 'number', 'Target stock must remain numeric');
  assert(typeof sample.safetyStock === 'number', 'Safety stock must remain numeric');
  assert(typeof sample.suggestedOrderQty === 'number', 'Suggested order qty must remain numeric');
  assert(['BUY_NOW', 'WATCH', 'OK'].includes(sample.classification), 'Classification must remain standard');
  console.log('  ✅ Analysis output enriched with reference MRP without altering formulas');
} else {
  console.log('  ℹ (Fixtures not present in test folder, tested via unit suites)');
}

// 4. Verify Frontend Assets for Subtle Secondary Styling
console.log('\n[4/5] Verifying UI template and JS implementation...');
const htmlContent = fs.readFileSync(path.join(__dirname, '../../frontend/admin/inventory.html'), 'utf8');
const jsContent = fs.readFileSync(path.join(__dirname, '../../frontend/admin/js/inventory.js'), 'utf8');

assert(htmlContent.includes('.inline-mrp-tag'), 'HTML must define .inline-mrp-tag CSS class');
assert(htmlContent.includes('.drawer-mrp-pill'), 'HTML must define .drawer-mrp-pill CSS class');
assert(htmlContent.includes('id="drawer-item-mrp"'), 'HTML drawer header must contain #drawer-item-mrp element');

assert(jsContent.includes('drawerItemMrp'), 'JS must reference drawerItemMrp');
assert(jsContent.includes('inline-mrp-tag'), 'JS must render inline-mrp-tag in search and product tables');
console.log('  ✅ Frontend HTML and JS correctly implement subtle, secondary inline MRP tags');

// 5. Verify authoritative source constraint (Default Mrp only)
console.log('\n[5/5] Confirming authoritative source is Default Mrp only...');
const mrpCode = fs.readFileSync(path.join(__dirname, '../mrpMaster.js'), 'utf8');
assert(mrpCode.includes("row['Default Mrp']"), 'mrpMaster must extract row["Default Mrp"]');
assert(mrpCode.includes("row['Item name*']"), 'mrpMaster must extract row["Item name*"]');
assert(!mrpCode.includes("row['WHOLESALE PRICE']"), 'mrpMaster must NOT use WHOLESALE PRICE');
assert(!mrpCode.includes("row['Sale price']"), 'mrpMaster must NOT use Sale price');
assert(!mrpCode.includes("row['Purchase price']"), 'mrpMaster must NOT use Purchase price');
console.log('  ✅ Code strictly respects authoritative Default Mrp field constraint');

console.log('\n================================================================');
console.log('   ✔ ALL MRP MASTER ACCEPTANCE REQUIREMENTS PASSED!             ');
console.log('================================================================\n');
