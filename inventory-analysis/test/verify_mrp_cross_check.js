const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
  evaluateCandidateMatch,
  resolveCatalogIdentity,
  CatalogLedger,
  computeMrpCheck
} = require('../nameResolver');
const { loadMrpMaster, getMasterMrpDetail } = require('../mrpMaster');

console.log('Running MRP Name-Resolution Cross-Check Tests...\n');

const testResults = [];
function recordTest(name, passed, detail = '') {
  testResults.push({ name, passed, detail });
  console.log(`  ${passed ? '✅' : '❌'} ${name} ${detail ? '(' + detail + ')' : ''}`);
}

// -----------------------------------------------------------------------------
// Test 1: Name variant + same MRP -> MRP CONSISTENT
// -----------------------------------------------------------------------------
try {
  const customMaster = {
    loaded: true,
    detailsByNormalizedName: new Map([
      ['AMUL BTTR 500 GM', { mrp: 295, itemCode: 'AMUL500', itemName: 'AMUL BTTR 500 GM' }],
      ['AMUL BUTTER 500 GM', { mrp: 295, itemCode: 'AMUL500', itemName: 'AMUL BUTTER 500 GM' }]
    ]),
    detailsByCode: new Map(),
    detailsByRawName: new Map()
  };

  const evalRes = evaluateCandidateMatch(
    'AMUL BTTR 500 GM',
    'AMUL BUTTER 500 GM',
    { mrpMaster: customMaster }
  );

  assert.strictEqual(evalRes.isMatch, true, 'Should match variants');
  assert(evalRes.mrpCheck, 'Should have mrpCheck');
  assert.strictEqual(evalRes.mrpCheck.status, 'MRP_CONSISTENT');
  assert.strictEqual(evalRes.mrpCheck.statusLabel, 'MRP CONSISTENT');
  assert.strictEqual(evalRes.mrpCheck.badgeText, '✓ ₹295 = ₹295');
  assert.strictEqual(evalRes.identityCheck.mrp.match, true);
  assert.strictEqual(evalRes.identityCheck.mrp.warning, false);

  recordTest('Test 1: Variant + Same MRP -> MRP CONSISTENT', true, 'Evaluated status=MRP_CONSISTENT, badge="✓ ₹295 = ₹295"');
} catch (e) {
  recordTest('Test 1: Variant + Same MRP -> MRP CONSISTENT', false, e.message);
}

// -----------------------------------------------------------------------------
// Test 2: Name variant + different MRP -> MRP CONFLICT
// -----------------------------------------------------------------------------
try {
  const customMasterConflict = {
    loaded: true,
    detailsByNormalizedName: new Map([
      ['AMUL BTTR 500 GM', { mrp: 295, itemCode: 'AMUL-A', itemName: 'AMUL BTTR 500 GM' }],
      ['AMUL BUTTER 500 GM', { mrp: 365, itemCode: 'AMUL-B', itemName: 'AMUL BUTTER 500 GM' }]
    ]),
    detailsByCode: new Map(),
    detailsByRawName: new Map()
  };

  const evalConflict = evaluateCandidateMatch(
    'AMUL BTTR 500 GM',
    'AMUL BUTTER 500 GM',
    { mrpMaster: customMasterConflict }
  );

  assert.strictEqual(evalConflict.isMatch, true, 'Variants are candidate match');
  assert(evalConflict.mrpCheck, 'Should have mrpCheck');
  assert.strictEqual(evalConflict.mrpCheck.status, 'MRP_CONFLICT');
  assert.strictEqual(evalConflict.mrpCheck.statusLabel, 'MRP CONFLICT');
  assert.strictEqual(evalConflict.mrpCheck.badgeText, '⚠ ₹295 ≠ ₹365');
  assert.strictEqual(evalConflict.hasWarning, true, 'Must flag hasWarning on MRP conflict');
  assert.strictEqual(evalConflict.matchStatus, 'HUMAN_REVIEW_REQUIRED', 'Must NOT auto-merge; must require human review');
  assert.strictEqual(evalConflict.identityCheck.mrp.warning, true);

  recordTest('Test 2: Variant + Different MRP -> MRP CONFLICT', true, 'Evaluated status=MRP_CONFLICT, matchStatus=HUMAN_REVIEW_REQUIRED, hasWarning=true');
} catch (e) {
  recordTest('Test 2: Variant + Different MRP -> MRP CONFLICT', false, e.message);
}

// -----------------------------------------------------------------------------
// Test 3: Name variant + missing MRP -> MRP UNKNOWN
// -----------------------------------------------------------------------------
try {
  const customMasterEmpty = {
    detailsByNormalizedName: new Map(),
    detailsByCode: new Map(),
    detailsByRawName: new Map()
  };

  const evalUnknown = evaluateCandidateMatch(
    'AMUL BTTR 500 GM',
    'AMUL BUTTER 500 GM',
    { mrpMaster: customMasterEmpty }
  );

  assert.strictEqual(evalUnknown.isMatch, true, 'Variants are candidate match');
  assert(evalUnknown.mrpCheck, 'Should have mrpCheck');
  assert.strictEqual(evalUnknown.mrpCheck.status, 'MRP_UNKNOWN');
  assert.strictEqual(evalUnknown.mrpCheck.statusLabel, 'MRP UNKNOWN');
  assert.strictEqual(evalUnknown.mrpCheck.badgeText, '— Not available');
  assert.strictEqual(evalUnknown.hasWarning, false, 'Do not penalize candidate solely because MRP is unavailable');
  assert.strictEqual(evalUnknown.identityCheck.mrp.warning, false);

  recordTest('Test 3: Variant + Missing MRP -> MRP UNKNOWN', true, 'Evaluated status=MRP_UNKNOWN, badge="— Not available", not penalized');
} catch (e) {
  recordTest('Test 3: Variant + Missing MRP -> MRP UNKNOWN', false, e.message);
}

// -----------------------------------------------------------------------------
// Test 4: Same MRP alone must NOT create a merge between distinct products
// -----------------------------------------------------------------------------
try {
  const customMasterSameMrp = {
    detailsByNormalizedName: new Map([
      ['AMUL BUTTER 500 GM', { mrp: 295, itemCode: 'AMUL-BTR', itemName: 'AMUL BUTTER 500 GM' }],
      ['AMUL CHEESE 500 GM', { mrp: 295, itemCode: 'AMUL-CHS', itemName: 'AMUL CHEESE 500 GM' }]
    ]),
    detailsByCode: new Map(),
    detailsByRawName: new Map()
  };

  const evalDifferentProducts = evaluateCandidateMatch(
    'AMUL BUTTER 500 GM',
    'AMUL CHEESE 500 GM',
    { mrpMaster: customMasterSameMrp }
  );

  assert.strictEqual(evalDifferentProducts.isMatch, false, 'Different products with same MRP must NEVER match');

  recordTest('Test 4: Same MRP alone must NOT merge distinct products', true, 'Amul Butter vs Amul Cheese returns isMatch=false');
} catch (e) {
  recordTest('Test 4: Same MRP alone must NOT merge distinct products', false, e.message);
}

// -----------------------------------------------------------------------------
// Test 5: Real MRP Master resolution (Consistent & Conflict checks)
// -----------------------------------------------------------------------------
try {
  const activeMrpMaster = loadMrpMaster();
  assert(activeMrpMaster.loaded, 'MRP Master should be loaded');

  // Verify getMasterMrpDetail retrieves valid authoritative entries
  const detailA = getMasterMrpDetail({ itemName: 'AMUL BUTTER 500 GM' }, activeMrpMaster);
  const detailB = getMasterMrpDetail({ itemName: 'AMUL BTTR 500 GM' }, activeMrpMaster);

  assert(detailA.mrp > 0, 'AMUL BUTTER 500 GM has valid MRP');
  assert(detailB.mrp > 0, 'AMUL BTTR 500 GM has valid MRP');

  // Test full candidate resolution in pipeline
  const testLedgerPath = path.join(__dirname, 'test_mrp_pipe_ledger.json');
  if (fs.existsSync(testLedgerPath)) fs.unlinkSync(testLedgerPath);
  const testLedger = new CatalogLedger(testLedgerPath);

  const res = resolveCatalogIdentity({
    saleRecords: [{ itemName: 'AMUL BUTTER 500 GM', quantity: 10 }],
    stockRecords: [{ rawItemName: 'AMUL BTTR 500 GM', closingQty: 5 }],
    ledger: testLedger,
    mrpMaster: activeMrpMaster
  });

  assert.strictEqual(res.pendingCandidates.length, 1, 'Should find 1 candidate pair');
  const cand = res.pendingCandidates[0];
  assert(cand.mrpCheck, 'Candidate has mrpCheck');
  assert(['MRP_CONSISTENT', 'MRP_CONFLICT'].includes(cand.mrpCheck.status));
  assert(cand.mrpCheck.mrpA > 0);
  assert(cand.mrpCheck.mrpB > 0);

  if (fs.existsSync(testLedgerPath)) fs.unlinkSync(testLedgerPath);

  recordTest('Test 5: AMUL resolution against active MRP Master in pipeline', true, `Resolved candidates with mrpCheck: ${cand.mrpCheck.statusLabel} (${cand.mrpCheck.badgeText})`);
} catch (e) {
  recordTest('Test 5: AMUL resolution against active MRP Master in pipeline', false, e.message);
}

// -----------------------------------------------------------------------------
// Test 6: CatalogLedger persistence (MERGE and KEEP_SEPARATE) remains unchanged
// -----------------------------------------------------------------------------
try {
  const tempJsonPath = path.join(__dirname, 'temp_cross_check_ledger.json');
  if (fs.existsSync(tempJsonPath)) fs.unlinkSync(tempJsonPath);

  const ledger = new CatalogLedger(tempJsonPath);
  ledger.recordMerge('RAW AMUL VARIANT', 'AMUL BUTTER 500 GM');
  ledger.recordKeepSeparate('AMUL BUTTER 500 GM', 'AMUL CHEESE 500 GM');

  const merges = ledger.getAllMerges();
  const separates = ledger.getAllSeparates();

  assert(merges.some(m => m.rawName === 'RAW AMUL VARIANT' && m.canonicalName === 'AMUL BUTTER 500 GM'));
  assert(separates.some(s => (s.itemA.includes('AMUL BUTTER') && s.itemB.includes('AMUL CHEESE')) || (s.itemB.includes('AMUL BUTTER') && s.itemA.includes('AMUL CHEESE'))));

  if (fs.existsSync(tempJsonPath)) fs.unlinkSync(tempJsonPath);

  recordTest('Test 6: CatalogLedger MERGE & KEEP_SEPARATE persistence intact', true, 'Schema and persistence behavior strictly preserved');
} catch (e) {
  recordTest('Test 6: CatalogLedger MERGE & KEEP_SEPARATE persistence intact', false, e.message);
}

// -----------------------------------------------------------------------------
// Summary
// -----------------------------------------------------------------------------
console.log('\n--- Test Summary ---');
const total = testResults.length;
const passed = testResults.filter(t => t.passed).length;
console.log(`Passed: ${passed}/${total}`);

if (passed < total) {
  process.exit(1);
} else {
  console.log('All MRP Cross-Check Tests Passed Successfully!\n');
}
