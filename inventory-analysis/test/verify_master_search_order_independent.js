const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

console.log('================================================================');
console.log('  RUNNING IMPROVED COVERAGE & RELEVANCE RANKING SEARCH TESTS    ');
console.log('================================================================\n');

// 1. Read inventory.js to test the actual frontend evaluation functions
const jsContent = fs.readFileSync(path.join(__dirname, '../../frontend/admin/js/inventory.js'), 'utf8');

const sandbox = {};
const funcCode = `
  ${jsContent.match(/function normalizeSearchText[\s\S]*?function evaluateSearchMatch[\s\S]*?\n  \}/)[0]}
  sandbox.normalizeSearchText = normalizeSearchText;
  sandbox.tokenizeSearchQuery = tokenizeSearchQuery;
  sandbox.evaluateSearchMatch = evaluateSearchMatch;
`;

vm.runInNewContext(funcCode, { sandbox });
const { normalizeSearchText, tokenizeSearchQuery, evaluateSearchMatch } = sandbox;

assert(typeof normalizeSearchText === 'function', 'normalizeSearchText must be defined');
assert(typeof tokenizeSearchQuery === 'function', 'tokenizeSearchQuery must be defined');
assert(typeof evaluateSearchMatch === 'function', 'evaluateSearchMatch must be defined');

console.log('✅ Helper functions extracted successfully.');

// -------------------------------------------------------------
// Test Case 1: HIMA PURI NEEM FW User Scenarios (Regression Check)
// -------------------------------------------------------------
console.log('\n--- Test 1: HIMA PURI NEEM FW Preserved Order-Independent Tests ---');
const himaProduct = 'HIMA PURI NEEM FW';

function checkHima(query) {
  const tokens = tokenizeSearchQuery(query);
  return evaluateSearchMatch(tokens, query, himaProduct, [himaProduct]);
}

assert(checkHima('hima') !== null, '"hima" must match');
assert(checkHima('neem') !== null, '"neem" must match');
assert(checkHima('fw') !== null, '"fw" must match');
assert(checkHima('hima neem') !== null, '"hima neem" must match');
assert(checkHima('neem hima') !== null, '"neem hima" must match');
assert(checkHima('hima fw') !== null, '"hima fw" must match');
assert(checkHima('fw hima') !== null, '"fw hima" must match');
assert(checkHima('puri hima') !== null, '"puri hima" must match');
assert(checkHima('hima puri fw') !== null, '"hima puri fw" must match');
assert.strictEqual(checkHima('hima xyz'), null, '"hima xyz" must NOT match');
console.log('  ✅ All 10 HIMA query tests passed.');

// -------------------------------------------------------------
// Test Case 2: Single-Word Search Ranking (GM brand vs ... 500 GM)
// -------------------------------------------------------------
console.log('\n--- Test 2: Single-Word Search Ranking (Token: "gm") ---');

const gmDataset = [
  '24M BANYARD MILLET 500 GM',
  'ABC GM OIL',
  'GM BISCUITS',
  'GM MUSTARD OIL 1 LTR',
  'GM SOAP',
  'GMD PRODUCTS'
];

function scoreItems(query, items) {
  const tokens = tokenizeSearchQuery(query);
  const matches = [];
  items.forEach(it => {
    const res = evaluateSearchMatch(tokens, query, it, [it]);
    if (res) matches.push({ name: it, rank: res.rank });
  });
  matches.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    return a.name.localeCompare(b.name);
  });
  return matches;
}

const gmResults = scoreItems('gm', gmDataset);
console.log('Ranked results for "gm":');
gmResults.forEach((r, idx) => console.log(`  ${idx + 1}. [rank: ${r.rank}] ${r.name}`));

// Assertions on ranking order:
// 1. GM-brand items (starting with GM) must rank highest (rank: 20)
const gmBrandItems = ['GM BISCUITS', 'GM MUSTARD OIL 1 LTR', 'GM SOAP'];
gmBrandItems.forEach(item => {
  const r = gmResults.find(x => x.name === item);
  assert(r && r.rank === 20, `${item} must have Priority 1 (rank: 20)`);
});

// 2. GMD PRODUCTS (prefix match on first word) should be rank: 25
const gmd = gmResults.find(x => x.name === 'GMD PRODUCTS');
assert(gmd && gmd.rank === 25, 'GMD PRODUCTS must have rank 25');

// 3. ABC GM OIL (later word starts with GM) should be rank 30-39
const abcGm = gmResults.find(x => x.name === 'ABC GM OIL');
assert(abcGm && abcGm.rank >= 30 && abcGm.rank < 40, 'ABC GM OIL must have Priority 2 (rank: 30-39)');

// 4. 24M BANYARD MILLET 500 GM (... 500 GM at end) must rank below actual GM brand items
const millet = gmResults.find(x => x.name === '24M BANYARD MILLET 500 GM');
assert(millet && millet.rank === 60, '24M BANYARD MILLET 500 GM must have Priority 3 (rank: 60)');

// Confirm all GM-starting items rank before 24M BANYARD MILLET 500 GM
const milletIndex = gmResults.findIndex(x => x.name === '24M BANYARD MILLET 500 GM');
gmBrandItems.forEach(item => {
  const itemIndex = gmResults.findIndex(x => x.name === item);
  assert(itemIndex < milletIndex, `${item} (idx: ${itemIndex}) must rank above 24M BANYARD MILLET 500 GM (idx: ${milletIndex})`);
});
console.log('  ✅ GM brand items rank strictly above "... 500 GM"');

// -------------------------------------------------------------
// Test Case 3: Multi-Word Search (Query: "gm oil")
// -------------------------------------------------------------
console.log('\n--- Test 3: Multi-Word Search Ranking (Query: "gm oil") ---');

const gmOilDataset = [
  'PRODUCT OIL SOME OTHER WORDS GM',
  'MUSTARD OIL GM',
  'ABC GM OIL',
  'GM MUSTARD OIL',
  'GM OIL 1 LTR',
  'UNMATCHED PRODUCT OIL'
];

const gmOilResults = scoreItems('gm oil', gmOilDataset);
console.log('Ranked results for "gm oil":');
gmOilResults.forEach((r, idx) => console.log(`  ${idx + 1}. [rank: ${r.rank}] ${r.name}`));

// 1. Both tokens are required (UNMATCHED PRODUCT OIL must NOT match)
const unmatched = gmOilResults.find(x => x.name === 'UNMATCHED PRODUCT OIL');
assert.strictEqual(unmatched, undefined, 'Products missing "gm" must NOT match');
console.log('  ✅ Both tokens strictly required (unmatched product rejected)');

// 2. Token order is irrelevant: "oil gm" produces same matches
const oilGmResults = scoreItems('oil gm', gmOilDataset);
assert.strictEqual(oilGmResults.length, gmOilResults.length, 'Token order must not prevent matches');
console.log('  ✅ Out-of-order query "oil gm" matches all candidate products');

// 3. Verify rank ordering:
// GM OIL 1 LTR > GM MUSTARD OIL > ABC GM OIL / MUSTARD OIL GM
const idxGmOil = gmOilResults.findIndex(x => x.name === 'GM OIL 1 LTR');
const idxGmMustardOil = gmOilResults.findIndex(x => x.name === 'GM MUSTARD OIL');
const idxMustardOilGm = gmOilResults.findIndex(x => x.name === 'MUSTARD OIL GM');

assert(idxGmOil < idxGmMustardOil, 'GM OIL 1 LTR must rank above GM MUSTARD OIL');
assert(idxGmMustardOil < idxMustardOilGm, 'GM MUSTARD OIL must rank above MUSTARD OIL GM');
console.log('  ✅ Ranking priority: GM OIL 1 LTR > GM MUSTARD OIL > MUSTARD OIL GM verified');

// -------------------------------------------------------------
// Test Case 4: Entire Analysed Dataset Search Corpus (Dead Stock inclusion)
// -------------------------------------------------------------
console.log('\n--- Test 4: Dead Stock & Complete Analysis Dataset Coverage ---');

const mockAnalysisData = {
  suggestions: [
    { itemName: 'GM JWR ATTA 500 GM', classification: 'BUY_NOW', mrp: 75 }
  ],
  review: {
    matchRequiredItems: [
      { canonicalName: 'GM SPECIAL SPICE 100G', mrp: 45, totalStockQuantity: 10 }
    ],
    negativeStockItems: [
      { itemName: 'GM CHANA SATTU 500 GM', recordedClosingQty: -2, mrp: 90 }
    ],
    deadStockCandidates: [
      { itemName: 'GM MOONG DAL AATA 500 GM', currentStock: 5, mrp: 102 },
      { itemName: 'GM BEDMI AATA 500 GM', currentStock: 3, mrp: 99 }
    ],
    zeroStockNeverSold: [
      { itemName: 'GM BHATURA 400 GM', currentStock: 0, mrp: 82 }
    ],
    suggestedMerges: [],
    dataQualityNotes: []
  }
};

// Simulate corpus build across analysis data
function searchMockAnalysis(query, data) {
  const tokens = tokenizeSearchQuery(query);
  const items = [];
  const seen = new Set();

  function addItem(item, classification, badge) {
    const name = item.itemName || item.canonicalName;
    if (!name) return;
    const key = name.toLowerCase();
    if (seen.has(key)) return;
    const match = evaluateSearchMatch(tokens, query, name, [name]);
    if (match) {
      seen.add(key);
      items.push({
        name,
        classification,
        badge,
        mrp: item.mrp,
        rank: match.rank
      });
    }
  }

  (data.suggestions || []).forEach(s => addItem(s, s.classification, null));
  if (data.review) {
    (data.review.matchRequiredItems || []).forEach(m => addItem(m, 'REVIEW', '⚠️ Match Required'));
    (data.review.negativeStockItems || []).forEach(n => addItem(n, 'REVIEW', '⚠️ Negative Stock'));
    (data.review.deadStockCandidates || []).forEach(d => addItem(d, 'REVIEW', '📦 Dead Stock'));
    (data.review.zeroStockNeverSold || []).forEach(z => addItem(z, 'REVIEW', '⏳ Zero Stock'));
  }

  items.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
  return items;
}

const deadStockSearchResults = searchMockAnalysis('gm', mockAnalysisData);
console.log('Search across complete analysed dataset:');
deadStockSearchResults.forEach(r => console.log(`  [${r.classification} | ${r.badge || 'SUGGESTION'}] ${r.name} (₹${r.mrp} MRP)`));

assert(deadStockSearchResults.some(r => r.name === 'GM MOONG DAL AATA 500 GM' && r.badge === '📦 Dead Stock'),
  'GM MOONG DAL AATA 500 GM from dead stock MUST appear in search results');
assert(deadStockSearchResults.some(r => r.name === 'GM BEDMI AATA 500 GM' && r.badge === '📦 Dead Stock'),
  'GM BEDMI AATA 500 GM from dead stock MUST appear in search results');
assert(deadStockSearchResults.some(r => r.name === 'GM SPECIAL SPICE 100G'),
  'Match Required item MUST appear in search results');
console.log('  ✅ Dead-stock and review items are fully included in search corpus');

console.log('\n================================================================');
console.log('  ALL IMPROVED COVERAGE & RELEVANCE RANKING TESTS PASSED (100%) ');
console.log('================================================================');
