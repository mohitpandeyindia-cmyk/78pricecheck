const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
  normalizeDeterministic,
  extractProductIdentity,
  evaluateCandidateMatch,
  selectCanonicalName,
  CatalogLedger,
  resolveCatalogIdentity,
} = require('../nameResolver');
const { computeAvgMrpByItem } = require('../reportReaders');

console.log('Running V1.1 Catalog & Stock Name Resolution Tests...\n');

const testResults = [];
function recordTest(name, passed, detail = '') {
  testResults.push({ name, passed, detail });
}

// -------------------------------------------------------------
// 1. Level 1 Deterministic Normalization
// -------------------------------------------------------------
try {
  assert.strictEqual(normalizeDeterministic('AMUL BTTR 500 GM N'), 'AMUL BTTR 500 GM');
  assert.strictEqual(normalizeDeterministic('AMUL BTTR 500GM N N'), 'AMUL BTTR 500 GM');
  assert.strictEqual(normalizeDeterministic('PTNJLI DK NTRL TP 100G N'), 'PTNJLI DK NTRL TP 100 GM');
  assert.strictEqual(normalizeDeterministic('FORTUNE OIL 1L N'), 'FORTUNE OIL 1 LTR');
  assert.strictEqual(normalizeDeterministic('GILLETTE FUSION 2N'), 'GILLETTE FUSION 2N', 'Should NOT strip N when part of 2N token');

  recordTest('Level 1 Normalization', true, 'Trailing N markers and unit spacing normalized deterministically');
} catch (e) {
  recordTest('Level 1 Normalization', false, e.message);
}

// -------------------------------------------------------------
// 2. Identity Extraction & Pack Size Protection
// -------------------------------------------------------------
try {
  const id1 = extractProductIdentity('AMUL BUTTER 500 GM');
  assert.strictEqual(id1.brand, 'AMUL');
  assert.strictEqual(id1.size, 500);
  assert.strictEqual(id1.unit, 'GM');
  assert.deepStrictEqual(id1.productTokens, ['BUTTER']);

  const id2 = extractProductIdentity('AMUL BUTTER 100 GM');
  assert.strictEqual(id2.size, 100);

  // Different pack size must NEVER match
  const matchSize = evaluateCandidateMatch('AMUL BUTTER 500 GM', 'AMUL BUTTER 100 GM');
  assert.strictEqual(matchSize.isMatch, false, '500 GM and 100 GM must NEVER be candidate match');
  assert(matchSize.reason.includes('pack sizes'));

  recordTest('Pack Size Protection', true, 'Guarantees different pack sizes (500 GM vs 100 GM) never match');
} catch (e) {
  recordTest('Pack Size Protection', false, e.message);
}

// -------------------------------------------------------------
// 3. Product Category Protection
// -------------------------------------------------------------
try {
  const matchCat = evaluateCandidateMatch('AMUL BUTTER 500 GM', 'AMUL CHEESE 500 GM');
  assert.strictEqual(matchCat.isMatch, false, 'BUTTER and CHEESE must NEVER match');

  recordTest('Product Category Protection', true, 'Guarantees different products (BUTTER vs CHEESE) never match');
} catch (e) {
  recordTest('Product Category Protection', false, e.message);
}

// -------------------------------------------------------------
// 4. Variant/Flavour Conflict Protection
// -------------------------------------------------------------
try {
  const matchVar = evaluateCandidateMatch('AMUL BUTTER SALTED 500 GM', 'AMUL BUTTER UNSALTED 500 GM');
  assert.strictEqual(matchVar.isMatch, false, 'SALTED vs UNSALTED must NEVER match');
  assert(matchVar.reason.includes('Conflicting variant'));

  recordTest('Variant Conflict Protection', true, 'Guarantees conflicting flavours (SALTED vs UNSALTED) never match');
} catch (e) {
  recordTest('Variant Conflict Protection', false, e.message);
}

// -------------------------------------------------------------
// 5. Abbreviation Candidate Matching
// -------------------------------------------------------------
try {
  const matchAbbr = evaluateCandidateMatch('AMUL BUTTER 500 GM', 'AMUL BTTR 500 GM');
  assert.strictEqual(matchAbbr.isMatch, true, 'BTTR and BUTTER must match as candidate');
  assert(matchAbbr.reason.includes('BUTTER ↔ BTTR') || matchAbbr.reason.includes('BTTR ↔ BUTTER'));

  recordTest('Abbreviation Candidate Match', true, 'Accurately recognizes BTTR ↔ BUTTER candidate match');
} catch (e) {
  recordTest('Abbreviation Candidate Match', false, e.message);
}

// -------------------------------------------------------------
// 6. Deterministic Canonical Name Selection Rule
// -------------------------------------------------------------
try {
  const variants = ['AMUL BUTTER 500 GM', 'AMUL BTTR 500 GM', 'AMUL BTTR 500 GM N'];
  const stockNamesSet = new Set(['AMUL BTTR 500 GM']);
  const salesNamesSet = new Set(['AMUL BUTTER 500 GM', 'AMUL BTTR 500 GM N']);

  const canonical = selectCanonicalName(variants, null, stockNamesSet, salesNamesSet);
  assert.strictEqual(canonical, 'AMUL BTTR 500 GM', 'Stock name without N suffix must be selected as canonical');

  recordTest('Canonical Selection Rule', true, 'Prioritizes stock-master name without N suffix as canonical SKU');
} catch (e) {
  recordTest('Canonical Selection Rule', false, e.message);
}

// -------------------------------------------------------------
// 7. Persistent Decision State (MERGE and KEEP_SEPARATE)
// -------------------------------------------------------------
try {
  const testLedgerPath = path.join(__dirname, 'test_catalog_ledger.json');
  if (fs.existsSync(testLedgerPath)) fs.unlinkSync(testLedgerPath);

  const ledger = new CatalogLedger(testLedgerPath);
  ledger.recordMerge('AMUL BUTTER 500 GM', 'AMUL BTTR 500 GM', 'MANUAL');
  ledger.recordKeepSeparate('LAYS CHIPS 50 GM', 'LAYS CHIPS 50 GM SPICY');

  // Verify persistence
  const ledgerReloaded = new CatalogLedger(testLedgerPath);
  assert.strictEqual(ledgerReloaded.getCanonical('AMUL BUTTER 500 GM'), 'AMUL BTTR 500 GM');
  assert.strictEqual(ledgerReloaded.isKeptSeparate('LAYS CHIPS 50 GM', 'LAYS CHIPS 50 GM SPICY'), true);

  if (fs.existsSync(testLedgerPath)) fs.unlinkSync(testLedgerPath);
  recordTest('Persistent Decision State', true, 'Persists both MERGE and KEEP_SEPARATE across restarts');
} catch (e) {
  recordTest('Persistent Decision State', false, e.message);
}

// -------------------------------------------------------------
// 8. Pre- and Post-Resolution Quantity Auditing
// -------------------------------------------------------------
try {
  const mockSales = [
    { itemName: 'AMUL BUTTER 500 GM', quantity: 132, date: new Date('2026-08-01') },
    { itemName: 'AMUL BTTR 500 GM', quantity: 87, date: new Date('2026-08-02') },
    { itemName: 'AMUL BTTR 500 GM N', quantity: 14, date: new Date('2026-08-03') },
  ];
  const mockStock = [
    { rawItemName: 'AMUL BTTR 500 GM', closingQty: 1, date: new Date('2026-09-13') },
    { rawItemName: 'AMUL BTTR 500 GM N', closingQty: 3, date: new Date('2026-09-13') },
  ];

  const testLedgerPath = path.join(__dirname, 'test_audit_ledger.json');
  if (fs.existsSync(testLedgerPath)) fs.unlinkSync(testLedgerPath);
  const ledger = new CatalogLedger(testLedgerPath);
  ledger.recordMerge('AMUL BUTTER 500 GM', 'AMUL BTTR 500 GM', 'MANUAL');

  const result = resolveCatalogIdentity({
    saleRecords: mockSales,
    stockRecords: mockStock,
    ledger,
  });

  const butterReport = result.validationReport.find((r) => r.canonicalName === 'AMUL BTTR 500 GM');
  assert(butterReport, 'Canonical AMUL BTTR 500 GM must exist in report');

  // Verify pre-resolution quantities sum correctly
  assert.strictEqual(butterReport.totalSalesQuantity, 132 + 87 + 14, 'Total sales should be 233 units');
  assert.strictEqual(butterReport.totalStockQuantity, 1 + 3, 'Total stock should be 4 units');
  assert.strictEqual(butterReport.salesVariants.length, 3);
  assert.strictEqual(butterReport.stockVariants.length, 2);

  if (fs.existsSync(testLedgerPath)) fs.unlinkSync(testLedgerPath);
  recordTest('Quantity Audit Trail', true, 'Calculates pre- and post-resolution sums: 233 sales, 4 stock');
} catch (e) {
  recordTest('Quantity Audit Trail', false, e.message);
}

// -------------------------------------------------------------
// 9. THE STRONG SUCCESS CRITERION TEST
// -------------------------------------------------------------
try {
  // Input:
  // Raw Sales: AMUL BUTTER 500 GM (qty: 132), AMUL BTTR 500 GM N (qty: 14)
  // Raw Stock: AMUL BTTR 500 GM (qty: 1), AMUL BTTR 500 GM N (qty: 3)
  const sales = [
    { itemName: 'AMUL BUTTER 500 GM', quantity: 132, date: new Date('2026-08-01') },
    { itemName: 'AMUL BTTR 500 GM N', quantity: 14, date: new Date('2026-08-02') },
  ];
  const stock = [
    { rawItemName: 'AMUL BTTR 500 GM', closingQty: 1, date: new Date('2026-09-13') },
    { rawItemName: 'AMUL BTTR 500 GM N', closingQty: 3, date: new Date('2026-09-13') },
  ];

  // Manual mapping from review: AMUL BUTTER 500 GM -> AMUL BTTR 500 GM
  const testLedgerPath = path.join(__dirname, 'test_success_ledger.json');
  if (fs.existsSync(testLedgerPath)) fs.unlinkSync(testLedgerPath);
  const ledger = new CatalogLedger(testLedgerPath);
  ledger.recordMerge('AMUL BUTTER 500 GM', 'AMUL BTTR 500 GM', 'MANUAL');

  const res = resolveCatalogIdentity({
    saleRecords: sales,
    stockRecords: stock,
    ledger,
  });

  // 1. One canonical product
  assert.strictEqual(res.validationReport.length, 1, 'Must have exactly ONE canonical product');
  const report = res.validationReport[0];
  assert.strictEqual(report.canonicalName, 'AMUL BTTR 500 GM');

  // 2. Sales variants merged: 2
  assert.strictEqual(report.salesVariants.length, 2);
  const salesNames = report.salesVariants.map((v) => v.rawName);
  assert(salesNames.includes('AMUL BUTTER 500 GM'));
  assert(salesNames.includes('AMUL BTTR 500 GM N'));

  // 3. Stock variants merged: 2
  assert.strictEqual(report.stockVariants.length, 2);
  const stockNames = report.stockVariants.map((v) => v.rawName);
  assert(stockNames.includes('AMUL BTTR 500 GM'));
  assert(stockNames.includes('AMUL BTTR 500 GM N'));

  // 4. Total quantities
  assert.strictEqual(report.totalSalesQuantity, 146); // 132 + 14
  assert.strictEqual(report.totalStockQuantity, 4);   // 1 + 3

  // 5. Resolution message
  assert.strictEqual(report.resolutionStatus, 'MANUAL_MERGED');

  if (fs.existsSync(testLedgerPath)) fs.unlinkSync(testLedgerPath);
  recordTest('Strong Success Criterion', true, 'Full identity flow: 1 canonical SKU, 2 sales variants, 2 stock variants, 0 duplicates');
} catch (e) {
  recordTest('Strong Success Criterion', false, e.message);
}

// -------------------------------------------------------------
// 10. Unresolved Identity Safeguard (Separation from Reorder)
// -------------------------------------------------------------
try {
  // Scenario: Sales has 'AMUL BUTTER 500 GM', Stock has 'AMUL BTTR 500 GM', but NO mapping yet
  const sales = [
    { itemName: 'AMUL BUTTER 500 GM', quantity: 100, date: new Date('2026-08-01') },
  ];
  const stock = [
    { rawItemName: 'AMUL BTTR 500 GM', closingQty: 1, date: new Date('2026-09-13') },
  ];

  const testLedgerPath = path.join(__dirname, 'test_unresolved_ledger.json');
  if (fs.existsSync(testLedgerPath)) fs.unlinkSync(testLedgerPath);
  const ledger = new CatalogLedger(testLedgerPath);

  const res = resolveCatalogIdentity({
    saleRecords: sales,
    stockRecords: stock,
    ledger,
  });

  // Candidate engine must detect abbreviation match
  assert.strictEqual(res.pendingCandidates.length, 1);
  assert.strictEqual(res.pendingCandidates[0].itemA, 'AMUL BUTTER 500 GM');
  assert.strictEqual(res.pendingCandidates[0].itemB, 'AMUL BTTR 500 GM');

  // Both sides must be flagged as UNRESOLVED / MATCH REQUIRED
  assert.strictEqual(res.unresolvedItems.length, 2);
  for (const unres of res.unresolvedItems) {
    assert.strictEqual(unres.resolutionStatus, 'UNRESOLVED');
    assert(unres.resolutionDetail.includes('MATCH REQUIRED'));
  }

  if (fs.existsSync(testLedgerPath)) fs.unlinkSync(testLedgerPath);
  recordTest('Unresolved Identity Safeguard', true, 'Unresolved candidate items flagged MATCH REQUIRED and isolated from downstream reorders');
} catch (e) {
  recordTest('Unresolved Identity Safeguard', false, e.message);
}

// -------------------------------------------------------------
// 11. Standalone Numeric Token Classification & Protection
// -------------------------------------------------------------
try {
  // Conflicting numeric tokens: 20 vs 5 must NEVER match
  const matchConflict = evaluateCandidateMatch('MAG MSLA E MAGIC SCHT 20', 'MAG MSLA E MAGIC SCHT 5');
  assert.strictEqual(matchConflict.isMatch, false, 'MAG 20 and MAG 5 have conflicting counts and must NEVER match');
  assert(matchConflict.reason.includes('Conflicting numeric pack/count tokens'));

  // Asymmetric numeric token: none vs 20 -> Candidate with warning (HUMAN REVIEW REQUIRED, NEVER AUTO-MERGE)
  const matchAsymmetric = evaluateCandidateMatch('MAG MSLA E MAGIC SCHT', 'MAG MSLA E MAGIC SCHT 20');
  assert.strictEqual(matchAsymmetric.isMatch, true);
  assert.strictEqual(matchAsymmetric.hasWarning, true, 'Must flag hasWarning for asymmetric numeric tokens');
  assert(matchAsymmetric.reason.includes('numeric pack/count token differs'));
  assert.strictEqual(matchAsymmetric.packCountCheck.warning, true);
  assert.strictEqual(matchAsymmetric.packCountCheck.label, 'none vs 20');

  recordTest('Numeric Token Protection', true, 'Conflicting tokens (20 vs 5) rejected; asymmetric (none vs 20) flagged for human review');
} catch (e) {
  recordTest('Numeric Token Protection', false, e.message);
}

// -------------------------------------------------------------
// 12. Sourced MRP Evidence Attachment & Priority
// -------------------------------------------------------------
try {
  const masterCatalogMap = new Map([
    ['AMUL BUTTER 500 GM', 295],
  ]);

  const sales = [
    { rawItemName: 'AMUL BTTR 500 GM', quantity: 5, pricePerUnit: 295 },
  ];
  const stock = [
    { rawItemName: 'AMUL BUTTER 500 GM', closingQty: 10 },
    { rawItemName: 'AMUL BTTR 500 GM', closingQty: 8 },
  ];

  const testLedgerPath = path.join(__dirname, 'test_mrp_ledger.json');
  if (fs.existsSync(testLedgerPath)) fs.unlinkSync(testLedgerPath);
  const ledger = new CatalogLedger(testLedgerPath);

  const res = resolveCatalogIdentity({
    saleRecords: sales,
    stockRecords: stock,
    masterCatalogMap,
    ledger,
  });

  if (fs.existsSync(testLedgerPath)) fs.unlinkSync(testLedgerPath);

  assert(res.pendingCandidates.length >= 1);
  const cand = res.pendingCandidates[0];

  // Identify variants by name
  const butterVar = cand.variantA.name.includes('BUTTER') ? cand.variantA : cand.variantB;
  const bttrVar = cand.variantA.name.includes('BTTR') ? cand.variantA : cand.variantB;

  // Variant A (AMUL BUTTER) should have MRP from Master Catalog
  assert.strictEqual(butterVar.mrp, 295);
  assert.strictEqual(butterVar.mrpSource, 'Master Catalog');

  // Variant B (AMUL BTTR) should have MRP from Sale Report (Price/Unit interpreted as MRP)
  assert.strictEqual(bttrVar.mrp, 295);
  assert.strictEqual(bttrVar.mrpSource, 'Sale Report');

  // Verify identity check matrix
  assert.strictEqual(cand.identityCheck.brand.match, true);
  assert.strictEqual(cand.identityCheck.mrp.valA, '₹295');
  assert.strictEqual(cand.identityCheck.mrp.valB, '₹295');
  assert.strictEqual(cand.identityCheck.mrp.label, '₹295 vs ₹295');

  recordTest('Sourced MRP Evidence', true, 'Correctly tags MRP origin (Master Catalog vs Sale Report) and populates identity matrix');
} catch (e) {
  recordTest('Sourced MRP Evidence', false, e.message);
}

// -------------------------------------------------------------
// 13. Multi-Upload Persistence Acceptance Test
// -------------------------------------------------------------
try {
  const multiLedgerPath = path.join(__dirname, 'test_multi_upload_ledger.json');
  if (fs.existsSync(multiLedgerPath)) fs.unlinkSync(multiLedgerPath);
  const persistentLedger = new CatalogLedger(multiLedgerPath);

  // UPLOAD 1: Merchant approves MERGE for AMUL variants, and KEEP_SEPARATE for items
  persistentLedger.recordMerge('AMUL BTTR 500 GM', 'AMUL BUTTER 500 GM', 'MANUAL');
  persistentLedger.recordKeepSeparate('ITEM A 100 GM', 'ITEM B 100 GM');

  // UPLOAD 2: Brand new upload with identical variants + Level 1 N-suffix variant
  const sales2 = [
    { rawItemName: 'AMUL BUTTER 500 GM', quantity: 20 },
    { rawItemName: 'AMUL BTTR 500 GM N', quantity: 15 },
  ];
  const stock2 = [
    { rawItemName: 'AMUL BTTR 500 GM', closingQty: 10 },
    { rawItemName: 'ITEM A 100 GM', closingQty: 5 },
    { rawItemName: 'ITEM B 100 GM', closingQty: 5 },
  ];

  // Load fresh ledger from file to prove persistence
  const reloadedLedger = new CatalogLedger(multiLedgerPath);
  const resUpload2 = resolveCatalogIdentity({
    saleRecords: sales2,
    stockRecords: stock2,
    ledger: reloadedLedger,
  });

  // Expected 1: All AMUL variants resolved automatically to AMUL BUTTER 500 GM
  const amulReport = resUpload2.validationReport.find(r => r.canonicalName === 'AMUL BUTTER 500 GM');
  assert(amulReport, 'Must find unified canonical AMUL BUTTER 500 GM');
  assert.strictEqual(amulReport.resolutionStatus, 'MANUAL_MERGED');
  assert.strictEqual(amulReport.resolutionSource, 'MANUAL_MERGE');
  assert.strictEqual(amulReport.totalSalesQuantity, 35); // 20 + 15
  assert.strictEqual(amulReport.totalStockQuantity, 10);

  // Expected 2: 0 candidate cards generated for AMUL BUTTER vs AMUL BTTR
  const amulCand = resUpload2.pendingCandidates.find(c =>
    (c.itemA.includes('AMUL') && c.itemB.includes('AMUL'))
  );
  assert.strictEqual(amulCand, undefined, 'Previously merged variants must NOT appear as candidates in future uploads');

  // Expected 3: ITEM A and ITEM B were kept separate, must NOT appear as candidates
  const itemCand = resUpload2.pendingCandidates.find(c =>
    (c.itemA === 'ITEM A 100 GM' && c.itemB === 'ITEM B 100 GM') ||
    (c.itemA === 'ITEM B 100 GM' && c.itemB === 'ITEM A 100 GM')
  );
  assert.strictEqual(itemCand, undefined, 'Previously kept separate pair must NOT reappear as candidates in future uploads');

  if (fs.existsSync(multiLedgerPath)) fs.unlinkSync(multiLedgerPath);
  recordTest('Multi-Upload Persistence', true, 'Confirms approved MERGE and KEEP_SEPARATE decisions apply across future uploads automatically');
} catch (e) {
  recordTest('Multi-Upload Persistence', false, e.message);
}

// -------------------------------------------------------------
// 14. Resolution Source Classification
// -------------------------------------------------------------
try {
  const sales = [
    { rawItemName: 'PARLE G 100 GM N', quantity: 50 },
    { rawItemName: 'BRITANNIA GOOD DAY 200 GM', quantity: 30 },
  ];
  const stock = [
    { rawItemName: 'PARLE G 100 GM', closingQty: 25 },
    { rawItemName: 'BRITANNIA GOOD DAY 200 GM', closingQty: 10 },
  ];

  const res = resolveCatalogIdentity({
    saleRecords: sales,
    stockRecords: stock,
  });

  const parleReport = res.validationReport.find(r => r.canonicalName === 'PARLE G 100 GM');
  assert.strictEqual(parleReport.resolutionSource, 'AUTO_NORMALIZED');

  const goodDayReport = res.validationReport.find(r => r.canonicalName === 'BRITANNIA GOOD DAY 200 GM');
  assert.strictEqual(goodDayReport.resolutionSource, 'AUTO_MATCHED');

  recordTest('Resolution Source Classification', true, 'Accurately tags AUTO_NORMALIZED and AUTO_MATCHED for catalog auditing');
} catch (e) {
  recordTest('Resolution Source Classification', false, e.message);
}

// -------------------------------------------------------------
// 15. Explicit MRP Verification Tests (Tests A, B, C, D, E)
// -------------------------------------------------------------

// Test A: Sale Report Price/Unit = 295 produces mrp = 295
try {
  const saleRecords = [
    { itemName: 'AMUL BUTTER 500 GM', rawItemName: 'AMUL BUTTER 500 GM', quantity: 2, pricePerUnit: 295 },
  ];
  const avgMrp = computeAvgMrpByItem(saleRecords);
  assert.strictEqual(avgMrp['AMUL BUTTER 500 GM'], 295);

  const saleRecordsWithMrp = [
    { itemName: 'AMUL BUTTER 500 GM', rawItemName: 'AMUL BUTTER 500 GM', quantity: 2, mrp: 295 },
  ];
  const avgMrp2 = computeAvgMrpByItem(saleRecordsWithMrp);
  assert.strictEqual(avgMrp2['AMUL BUTTER 500 GM'], 295);

  recordTest('Test A: Sale Report Price/Unit -> MRP', true, 'Price/Unit is parsed and mapped directly to authoritative mrp = 295');
} catch (e) {
  recordTest('Test A: Sale Report Price/Unit -> MRP', false, e.message);
}

// Test B: Candidate card displays MRP: ₹295 and Source: Sale Report
try {
  const testLedgerPathB = path.join(__dirname, 'test_mrp_b_ledger.json');
  if (fs.existsSync(testLedgerPathB)) fs.unlinkSync(testLedgerPathB);
  const ledgerB = new CatalogLedger(testLedgerPathB);

  const sales = [
    { rawItemName: 'PARLE BSCT 100 GM', quantity: 5, pricePerUnit: 295 },
  ];
  const stock = [
    { rawItemName: 'PARLE BISCUIT 100 GM', closingQty: 10 },
    { rawItemName: 'PARLE BSCT 100 GM', closingQty: 8 },
  ];
  const res = resolveCatalogIdentity({ saleRecords: sales, stockRecords: stock, ledger: ledgerB });
  if (fs.existsSync(testLedgerPathB)) fs.unlinkSync(testLedgerPathB);

  const cand = res.pendingCandidates.find(c => c.itemA.includes('PARLE') && c.itemB.includes('PARLE'));
  assert(cand, 'Must find PARLE candidate');
  const saleVar = cand.variantA.name.includes('BSCT') ? cand.variantA : cand.variantB;
  assert.strictEqual(saleVar.mrp, 295);
  assert.strictEqual(saleVar.mrpSource, 'Sale Report');

  recordTest('Test B: Candidate Card MRP & Source', true, 'Displays MRP: ₹295 and Source: Sale Report');
} catch (e) {
  recordTest('Test B: Candidate Card MRP & Source', false, e.message);
}

// Test C: Two variants both having Price/Unit = 295 show MRP Evidence: ₹295 vs ₹295
try {
  const testLedgerPathC = path.join(__dirname, 'test_mrp_c_ledger.json');
  if (fs.existsSync(testLedgerPathC)) fs.unlinkSync(testLedgerPathC);
  const ledgerC = new CatalogLedger(testLedgerPathC);

  const sales = [
    { rawItemName: 'PARLE BISCUIT 100 GM', quantity: 10, pricePerUnit: 295 },
    { rawItemName: 'PARLE BSCT 100 GM', quantity: 5, pricePerUnit: 295 },
  ];
  const stock = [
    { rawItemName: 'PARLE BISCUIT 100 GM', closingQty: 10 },
    { rawItemName: 'PARLE BSCT 100 GM', closingQty: 8 },
  ];
  const res = resolveCatalogIdentity({ saleRecords: sales, stockRecords: stock, ledger: ledgerC });
  if (fs.existsSync(testLedgerPathC)) fs.unlinkSync(testLedgerPathC);

  const cand = res.pendingCandidates.find(c => c.itemA.includes('PARLE') && c.itemB.includes('PARLE'));
  assert(cand, 'Must find PARLE candidate');
  assert.strictEqual(cand.identityCheck.mrp.valA, '₹295');
  assert.strictEqual(cand.identityCheck.mrp.valB, '₹295');
  assert.strictEqual(cand.identityCheck.mrp.label, '₹295 vs ₹295');

  recordTest('Test C: MRP Evidence Matrix', true, 'Shows MRP Evidence: ₹295 vs ₹295 when both have Price/Unit = 295');
} catch (e) {
  recordTest('Test C: MRP Evidence Matrix', false, e.message);
}

// Test D: Variant with no sales record has mrp: null, mrpSource: 'Not available'
try {
  const testLedgerPathD = path.join(__dirname, 'test_mrp_d_ledger.json');
  if (fs.existsSync(testLedgerPathD)) fs.unlinkSync(testLedgerPathD);
  const ledgerD = new CatalogLedger(testLedgerPathD);

  const stock = [
    { rawItemName: 'PARLE BISCUIT 100 GM', closingQty: 10 },
    { rawItemName: 'PARLE BSCT 100 GM', closingQty: 5 },
  ];
  const res = resolveCatalogIdentity({ saleRecords: [], stockRecords: stock, ledger: ledgerD });
  if (fs.existsSync(testLedgerPathD)) fs.unlinkSync(testLedgerPathD);

  const cand = res.pendingCandidates.find(c => c.itemA.includes('PARLE') && c.itemB.includes('PARLE'));
  assert(cand, 'Must find PARLE candidate');
  assert.strictEqual(cand.variantA.mrp, null);
  assert.strictEqual(cand.variantA.mrpSource, 'Not available');
  assert.strictEqual(cand.variantB.mrp, null);
  assert.strictEqual(cand.variantB.mrpSource, 'Not available');

  recordTest('Test D: Unavailable MRP Handling', true, 'Unrecorded items have mrp: null and mrpSource: Not available');
} catch (e) {
  recordTest('Test D: Unavailable MRP Handling', false, e.message);
}

// Test E: Numeric-token conflict (PRODUCT 5 vs PRODUCT 20) rejected even when both have identical MRP
try {
  const sales = [
    { rawItemName: 'MAG MSLA E MAGIC SCHT 5', quantity: 10, pricePerUnit: 50 },
    { rawItemName: 'MAG MSLA E MAGIC SCHT 20', quantity: 10, pricePerUnit: 50 },
  ];
  const stock = [
    { rawItemName: 'MAG MSLA E MAGIC SCHT 5', closingQty: 10 },
    { rawItemName: 'MAG MSLA E MAGIC SCHT 20', closingQty: 10 },
  ];
  const res = resolveCatalogIdentity({ saleRecords: sales, stockRecords: stock });
  const magCand = res.pendingCandidates.find(c =>
    (c.itemA.includes('MAGIC SCHT 5') && c.itemB.includes('MAGIC SCHT 20')) ||
    (c.itemA.includes('MAGIC SCHT 20') && c.itemB.includes('MAGIC SCHT 5'))
  );
  assert.strictEqual(magCand, undefined, 'Numeric pack/count conflict must NEVER produce a candidate even if MRP is identical');

  const matchEval = evaluateCandidateMatch('MAG MSLA E MAGIC SCHT 20', 'MAG MSLA E MAGIC SCHT 5');
  assert.strictEqual(matchEval.isMatch, false);

  recordTest('Test E: Numeric Token Conflict Rejection', true, 'Numeric conflict (5 vs 20) rejected even with identical MRP');
} catch (e) {
  recordTest('Test E: Numeric Token Conflict Rejection', false, e.message);
}

// -------------------------------------------------------------
// Print Summary
// -------------------------------------------------------------
console.log('V1.1 Catalog & Stock Name Resolution Tests');
console.log('------------------------------------------');
let allPassed = true;
for (const t of testResults) {
  const statusStr = t.passed ? 'PASS' : 'FAIL';
  const pad = ' '.repeat(Math.max(2, 35 - t.name.length));
  console.log(`${t.name}${pad}${statusStr}`);
  if (!t.passed) {
    console.error(`  -> Error: ${t.detail}`);
    allPassed = false;
  }
}
console.log('------------------------------------------');
const passedCount = testResults.filter((r) => r.passed).length;
console.log(`Total: ${passedCount}/${testResults.length} passed.`);

if (!allPassed) {
  process.exit(1);
}
