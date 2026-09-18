const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { resolveCatalogIdentity, CatalogLedger } = require('../nameResolver');

const demoLedgerFile = path.join(__dirname, 'demo_persistence_ledger.json');
if (fs.existsSync(demoLedgerFile)) fs.unlinkSync(demoLedgerFile);

console.log('================================================================');
console.log('   EXPLICIT MULTI-UPLOAD PERSISTENCE VERIFICATION TEST          ');
console.log('================================================================\n');

// -------------------------------------------------------------
// STEP 1: UPLOAD 1 (Unresolved initial state)
// -------------------------------------------------------------
console.log('[STEP 1] Initial Upload 1: Raw reports contain unmerged variants:');
console.log('         Sales: "AMUL BUTTER 500 GM" (qty: 25)');
console.log('         Stock: "AMUL BTTR 500 GM" (qty: 12)');
console.log('         Stock: "ITEM A 100 GM" (qty: 5)');
console.log('         Stock: "ITEM B 100 GM" (qty: 5)');

const salesUpload1 = [
  { rawItemName: 'AMUL BUTTER 500 GM', quantity: 25 },
];
const stockUpload1 = [
  { rawItemName: 'AMUL BTTR 500 GM', closingQty: 12 },
  { rawItemName: 'ITEM A 100 GM', closingQty: 5 },
  { rawItemName: 'ITEM B 100 GM', closingQty: 5 },
];

const ledger1 = new CatalogLedger(demoLedgerFile);
const res1 = resolveCatalogIdentity({
  saleRecords: salesUpload1,
  stockRecords: stockUpload1,
  ledger: ledger1,
});

console.log(`\n  -> Pending Candidates generated in Upload 1: ${res1.pendingCandidates.length}`);
res1.pendingCandidates.forEach(c => {
  console.log(`     Candidate: "${c.itemA}" ↔ "${c.itemB}" (Suggested Canonical: "${c.suggestedCanonical}")`);
});

const amulCand1 = res1.pendingCandidates.find(c =>
  (c.itemA === 'AMUL BUTTER 500 GM' && c.itemB === 'AMUL BTTR 500 GM') ||
  (c.itemA === 'AMUL BTTR 500 GM' && c.itemB === 'AMUL BUTTER 500 GM')
);
assert(amulCand1, 'Upload 1 must generate AMUL candidate pair');

// -------------------------------------------------------------
// STEP 2: USER DECISION RECORDED & SAVED TO LEDGER
// -------------------------------------------------------------
console.log('\n[STEP 2] Merchant takes review actions:');
console.log('         Action A: MERGE "AMUL BTTR 500 GM" -> "AMUL BUTTER 500 GM"');
ledger1.recordMerge('AMUL BTTR 500 GM', 'AMUL BUTTER 500 GM', 'MANUAL');

console.log('         Action B: KEEP SEPARATE "ITEM A 100 GM" ≠ "ITEM B 100 GM"');
ledger1.recordKeepSeparate('ITEM A 100 GM', 'ITEM B 100 GM');

console.log('         -> Decisions persistently saved to JSON on disk:');
const savedContent = JSON.parse(fs.readFileSync(demoLedgerFile, 'utf8'));
console.log('            Merges in ledger:', JSON.stringify(savedContent.merges.map(m => `${m.rawName} -> ${m.canonicalName}`)));
console.log('            Separates in ledger:', JSON.stringify(savedContent.separates));

// -------------------------------------------------------------
// STEP 3: UPLOAD 2 (Subsequent report upload days later)
// -------------------------------------------------------------
console.log('\n[STEP 3] Upload 2 (New weekly report upload with same variants + "AMUL BTTR 500 GM N"):');
const salesUpload2 = [
  { rawItemName: 'AMUL BUTTER 500 GM', quantity: 30 },
  { rawItemName: 'AMUL BTTR 500 GM N', quantity: 10 },
];
const stockUpload2 = [
  { rawItemName: 'AMUL BTTR 500 GM', closingQty: 18 },
  { rawItemName: 'ITEM A 100 GM', closingQty: 4 },
  { rawItemName: 'ITEM B 100 GM', closingQty: 6 },
];

// Re-instantiate a fresh ledger instance from disk to guarantee persistence
const freshReloadedLedger = new CatalogLedger(demoLedgerFile);

const res2 = resolveCatalogIdentity({
  saleRecords: salesUpload2,
  stockRecords: stockUpload2,
  ledger: freshReloadedLedger,
});

console.log(`\n  -> Pending Candidates generated in Upload 2: ${res2.pendingCandidates.length}`);
res2.pendingCandidates.forEach(c => {
  console.log(`     Candidate: "${c.itemA}" ↔ "${c.itemB}"`);
});

// Check AMUL candidate in Upload 2
const amulCand2 = res2.pendingCandidates.find(c =>
  c.itemA.includes('AMUL') || c.itemB.includes('AMUL')
);
console.log(`     AMUL Candidates in Upload 2: ${amulCand2 ? 'FOUND (FAIL)' : 'NONE (0 candidates - PASS)'}`);
assert.strictEqual(amulCand2, undefined, 'AMUL variants must NOT appear as candidates in Upload 2');

// Check KEEP_SEPARATE in Upload 2
const itemCand2 = res2.pendingCandidates.find(c =>
  (c.itemA === 'ITEM A 100 GM' && c.itemB === 'ITEM B 100 GM') ||
  (c.itemA === 'ITEM B 100 GM' && c.itemB === 'ITEM A 100 GM')
);
console.log(`     ITEM A vs ITEM B in Upload 2: ${itemCand2 ? 'FOUND (FAIL)' : 'NONE (0 candidates - PASS)'}`);
assert.strictEqual(itemCand2, undefined, 'ITEM A and ITEM B must NOT reappear in review');

// Verify Canonical Unified SKU
const amulReport = res2.validationReport.find(r => r.canonicalName === 'AMUL BUTTER 500 GM');
assert(amulReport, 'AMUL BUTTER 500 GM must exist as unified canonical SKU');
console.log('\n[STEP 4] Validation Report Status for Canonical "AMUL BUTTER 500 GM":');
console.log(`         Canonical Name:    ${amulReport.canonicalName}`);
console.log(`         Resolution Status: ${amulReport.resolutionStatus}`);
console.log(`         Resolution Source: ${amulReport.resolutionSource}`);
console.log(`         Total Merged Sales:${amulReport.totalSalesQuantity} units (30 + 10)`);
console.log(`         Total Merged Stock:${amulReport.totalStockQuantity} units (18)`);
console.log('         Sales Variants:   ', amulReport.salesVariants.map(v => `${v.rawName} (${v.quantitySold}u, [${v.resolutionSource}])`));
console.log('         Stock Variants:   ', amulReport.stockVariants.map(v => `${v.rawName} (${v.currentStock}u, [${v.resolutionSource}])`));

assert.strictEqual(amulReport.resolutionStatus, 'MANUAL_MERGED');
assert.strictEqual(amulReport.resolutionSource, 'MANUAL_MERGE');
assert.strictEqual(amulReport.totalSalesQuantity, 40);
assert.strictEqual(amulReport.totalStockQuantity, 18);
assert.strictEqual(amulReport.salesVariants.length, 2);
assert.strictEqual(amulReport.stockVariants.length, 1);

// Clean up demo file
if (fs.existsSync(demoLedgerFile)) fs.unlinkSync(demoLedgerFile);

console.log('\n================================================================');
console.log('   ✔ ALL PERSISTENCE ACCEPTANCE REQUIREMENTS VERIFIED!          ');
console.log('================================================================\n');
