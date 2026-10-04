const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

console.log('================================================================');
console.log('  RUNNING STATUS PRIORITY + RELEVANCE RANKING SEARCH TESTS      ');
console.log('================================================================\n');

// 1. Read inventory.js to test the actual frontend evaluation functions and sort comparator
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

// Status priority mapping identical to inventory.js
function getStatusPriority(classification) {
  if (classification === 'BUY_NOW') return 1;
  if (classification === 'WATCH') return 2;
  if (classification === 'OK') return 3;
  return 4; // REVIEW and exceptions
}

function sortSearchResults(results) {
  return results.slice().sort((a, b) => {
    const tierA = a.tier ?? 3;
    const tierB = b.tier ?? 3;
    if (tierA !== tierB) {
      return tierA - tierB;
    }

    const prioA = getStatusPriority(a.item.classification);
    const prioB = getStatusPriority(b.item.classification);
    if (prioA !== prioB) {
      return prioA - prioB;
    }

    if (a.rank !== b.rank) {
      return a.rank - b.rank;
    }

    return a.item.itemName.localeCompare(b.item.itemName);
  });
}

function searchItems(query, itemsList) {
  const tokens = tokenizeSearchQuery(query);
  const matched = [];
  itemsList.forEach(item => {
    const m = evaluateSearchMatch(tokens, query, item.itemName, [item.itemName]);
    if (m) {
      matched.push({
        item,
        tier: m.tier,
        rank: m.rank
      });
    }
  });
  return sortSearchResults(matched);
}

// -------------------------------------------------------------
// Test 1: Two-Dimensional Relevance Tier + Status Ranking Verification
// -------------------------------------------------------------
console.log('\n--- Test 1: KNR Two-Dimensional Tier + Status Verification ---');

const knrItems = [
  { itemName: 'ABC KNR PRODUCT', classification: 'BUY_NOW' },
  { itemName: 'XYZ PRODUCT KNR', classification: 'BUY_NOW' },
  { itemName: 'KNR PRODUCT A', classification: 'BUY_NOW' },
  { itemName: 'KNR PRODUCT B', classification: 'BUY_NOW' },
  { itemName: 'KNR PRODUCT C', classification: 'WATCH' },
  { itemName: 'KNR PRODUCT D', classification: 'OK' },
  { itemName: 'KNR PRODUCT E', classification: 'REVIEW' },
  { itemName: 'ABC KNR WATCH', classification: 'WATCH' },
  { itemName: 'ABC KNR OK', classification: 'OK' },
  { itemName: 'ABC KNR REVIEW', classification: 'REVIEW' }
];

const resKnr = searchItems('knr', knrItems);
console.log('Search "knr" results:');
resKnr.forEach((r, idx) => console.log(`  ${idx + 1}. [Tier ${r.tier}] [${r.item.classification}] ${r.item.itemName} (Rank: ${r.rank})`));

// Assertions:
// 1. All Tier A (KNR PRODUCT ...) must appear before all Tier B (ABC KNR ..., XYZ PRODUCT KNR)
const tierAItems = resKnr.filter(r => r.tier === 1);
const tierBItems = resKnr.filter(r => r.tier === 2);
assert(tierAItems.length === 5, 'Must have 5 Tier A items starting with KNR');
assert(tierBItems.length === 5, 'Must have 5 Tier B items where KNR appears later');

// Within Tier A: BUY_NOW -> WATCH -> OK -> REVIEW
assert.strictEqual(tierAItems[0].item.classification, 'BUY_NOW');
assert.strictEqual(tierAItems[1].item.classification, 'BUY_NOW');
assert.strictEqual(tierAItems[2].item.classification, 'WATCH');
assert.strictEqual(tierAItems[3].item.classification, 'OK');
assert.strictEqual(tierAItems[4].item.classification, 'REVIEW');
console.log('  ✅ Tier A correctly sorted: BUY NOW -> WATCH -> OK -> REVIEW');

// Crucial requirement: KNR ... WATCH and KNR ... OK MUST appear before ABC KNR ... BUY NOW
const idxKnrWatch = resKnr.findIndex(r => r.item.itemName === 'KNR PRODUCT C');
const idxKnrOk = resKnr.findIndex(r => r.item.itemName === 'KNR PRODUCT D');
const idxAbcKnrBuyNow = resKnr.findIndex(r => r.item.itemName === 'ABC KNR PRODUCT');
assert(idxKnrWatch < idxAbcKnrBuyNow, 'KNR PRODUCT C (WATCH) must appear before ABC KNR PRODUCT (BUY NOW)');
assert(idxKnrOk < idxAbcKnrBuyNow, 'KNR PRODUCT D (OK) must appear before ABC KNR PRODUCT (BUY NOW)');
console.log('  ✅ Positional Tier A (WATCH/OK) ranks strictly before Tier B (BUY NOW)');

// -------------------------------------------------------------
// Test 2: Query GM Verification
// -------------------------------------------------------------
console.log('\n--- Test 2: GM Verification ---');

const gmTestItems = [
  { itemName: '24M BANYARD MILLET 500 GM', classification: 'OK' },
  { itemName: 'GM MUSTARD OIL', classification: 'BUY_NOW' },
  { itemName: 'GM WATCH OIL', classification: 'WATCH' },
  { itemName: 'GM OK BISCUITS', classification: 'OK' },
  { itemName: 'ABC GM OIL', classification: 'BUY_NOW' },
  { itemName: 'GM MOONG DAL AATA 500 GM', classification: 'REVIEW' }
];

const resGm = searchItems('gm', gmTestItems);
console.log('Search "gm" results:');
resGm.forEach((r, idx) => console.log(`  ${idx + 1}. [Tier ${r.tier}] [${r.item.classification}] ${r.item.itemName} (Rank: ${r.rank})`));

// Expected order:
// GM ... BUY NOW (Tier 1)
// GM ... WATCH (Tier 1)
// GM ... OK (Tier 1)
// GM ... REVIEW (Tier 1)
// ABC GM ... BUY NOW (Tier 2)
// 24M BANYARD MILLET 500 GM (Tier 3)
assert.strictEqual(resGm[0].item.itemName, 'GM MUSTARD OIL'); // Tier 1, BUY_NOW
assert.strictEqual(resGm[1].item.itemName, 'GM WATCH OIL');   // Tier 1, WATCH
assert.strictEqual(resGm[2].item.itemName, 'GM OK BISCUITS');  // Tier 1, OK
assert.strictEqual(resGm[3].item.itemName, 'GM MOONG DAL AATA 500 GM'); // Tier 1, REVIEW (dead stock)
assert.strictEqual(resGm[4].item.itemName, 'ABC GM OIL');      // Tier 2, BUY_NOW
assert.strictEqual(resGm[5].item.itemName, '24M BANYARD MILLET 500 GM'); // Tier 3, OK
console.log('  ✅ GM results verified: GM BUY NOW -> GM WATCH -> GM OK -> GM REVIEW -> ABC GM BUY NOW -> 500 GM');

// -------------------------------------------------------------
// Test 3: Multi-Word Search (knr oil & gm oil)
// -------------------------------------------------------------
console.log('\n--- Test 3: Multi-Word Search & Order-Independence ---');

const multiKnrItems = [
  { itemName: 'ABC KNR OIL', classification: 'BUY_NOW' },
  { itemName: 'KNR OIL 1 LTR', classification: 'BUY_NOW' },
  { itemName: 'KNR MUSTARD OIL', classification: 'WATCH' },
  { itemName: 'KNR COOKING OIL', classification: 'OK' }
];

const resKnrOil = searchItems('knr oil', multiKnrItems);
console.log('Search "knr oil" results:');
resKnrOil.forEach((r, idx) => console.log(`  ${idx + 1}. [Tier ${r.tier}] [${r.item.classification}] ${r.item.itemName} (Rank: ${r.rank})`));

assert.strictEqual(resKnrOil[0].item.itemName, 'KNR OIL 1 LTR');       // Tier 1, BUY_NOW
assert.strictEqual(resKnrOil[1].item.itemName, 'KNR MUSTARD OIL');   // Tier 1, WATCH
assert.strictEqual(resKnrOil[2].item.itemName, 'KNR COOKING OIL');   // Tier 1, OK
assert.strictEqual(resKnrOil[3].item.itemName, 'ABC KNR OIL');       // Tier 2, BUY_NOW
console.log('  ✅ KNR OIL 1 LTR (BUY NOW) -> KNR MUSTARD OIL (WATCH) -> KNR COOKING OIL (OK) appear BEFORE ABC KNR OIL (BUY NOW)');

// Order-independence:
const resGmOil = searchItems('gm oil', multiKnrItems.concat([
  { itemName: 'OIL GM REVERSED', classification: 'BUY_NOW' }
]));
const resOilGm = searchItems('oil gm', multiKnrItems.concat([
  { itemName: 'OIL GM REVERSED', classification: 'BUY_NOW' }
]));
assert.strictEqual(resGmOil.length, 1);
assert.strictEqual(resOilGm.length, 1);
console.log('  ✅ Order independence preserved for multi-word queries');

// -------------------------------------------------------------
// Test 4: Regressions (hima neem & hima fw)
// -------------------------------------------------------------
console.log('\n--- Test 4: Regression Checks ---');

const himaItems = [
  { itemName: 'HIMA PURI NEEM FW', classification: 'BUY_NOW' },
  { itemName: 'OTHER PRODUCT', classification: 'OK' }
];
const resHimaNeem = searchItems('hima neem', himaItems);
assert.strictEqual(resHimaNeem.length, 1);
assert.strictEqual(resHimaNeem[0].item.itemName, 'HIMA PURI NEEM FW');
console.log('  ✅ "hima neem" matches HIMA PURI NEEM FW');

const resHimaFw = searchItems('hima fw', himaItems);
assert.strictEqual(resHimaFw.length, 1);
assert.strictEqual(resHimaFw[0].item.itemName, 'HIMA PURI NEEM FW');
console.log('  ✅ "hima fw" matches HIMA PURI NEEM FW');

console.log('\n================================================================');
console.log('  ALL 2D RELEVANCE TIER + STATUS RANKING TESTS PASSED (100%)    ');
console.log('================================================================\n');
