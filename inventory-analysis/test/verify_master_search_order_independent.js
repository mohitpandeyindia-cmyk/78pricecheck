const assert = require('assert');
const fs = require('fs');
const path = require('path');

console.log('================================================================');
console.log('  RUNNING ORDER-INDEPENDENT & TOKEN-BASED MASTER SEARCH TESTS   ');
console.log('================================================================\n');

// 1. Read inventory.js to ensure the exact matching and evaluation functions are tested
const jsContent = fs.readFileSync(path.join(__dirname, '../../frontend/admin/js/inventory.js'), 'utf8');

// Extract normalizeSearchText, tokenizeSearchQuery, evaluateSearchMatch using VM sandbox
const vm = require('vm');
const sandbox = {};
// We extract the functions using a regex or by wrapping in a scope
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

console.log('✅ Helper functions successfully extracted from frontend/admin/js/inventory.js');

// -------------------------------------------------------------
// Test Case 1: HIMA PURI NEEM FW User Scenarios
// -------------------------------------------------------------
console.log('\n--- Test 1: HIMA PURI NEEM FW Order-Independent Tests ---');

const primaryProduct = 'HIMA PURI NEEM FW';

function checkMatch(query, searchableTexts = [primaryProduct]) {
  const tokens = tokenizeSearchQuery(query);
  return evaluateSearchMatch(tokens, query, primaryProduct, searchableTexts);
}

// 1. hima -> match
const resHima = checkMatch('hima');
assert(resHima !== null, 'hima must match');
console.log('  ✅ "hima" -> MATCH (rank:', resHima.rank, ')');

// 2. neem -> match
const resNeem = checkMatch('neem');
assert(resNeem !== null, 'neem must match');
console.log('  ✅ "neem" -> MATCH (rank:', resNeem.rank, ')');

// 3. fw -> match
const resFw = checkMatch('fw');
assert(resFw !== null, 'fw must match');
console.log('  ✅ "fw" -> MATCH (rank:', resFw.rank, ')');

// 4. hima neem -> match
const resHimaNeem = checkMatch('hima neem');
assert(resHimaNeem !== null, 'hima neem must match');
console.log('  ✅ "hima neem" -> MATCH (rank:', resHimaNeem.rank, ')');

// 5. neem hima -> match
const resNeemHima = checkMatch('neem hima');
assert(resNeemHima !== null, 'neem hima must match');
console.log('  ✅ "neem hima" -> MATCH (rank:', resNeemHima.rank, ')');

// 6. hima fw -> match
const resHimaFw = checkMatch('hima fw');
assert(resHimaFw !== null, 'hima fw must match');
console.log('  ✅ "hima fw" -> MATCH (rank:', resHimaFw.rank, ')');

// 7. fw hima -> match
const resFwHima = checkMatch('fw hima');
assert(resFwHima !== null, 'fw hima must match');
console.log('  ✅ "fw hima" -> MATCH (rank:', resFwHima.rank, ')');

// 8. puri hima -> match
const resPuriHima = checkMatch('puri hima');
assert(resPuriHima !== null, 'puri hima must match');
console.log('  ✅ "puri hima" -> MATCH (rank:', resPuriHima.rank, ')');

// 9. hima puri fw -> match
const resHimaPuriFw = checkMatch('hima puri fw');
assert(resHimaPuriFw !== null, 'hima puri fw must match');
console.log('  ✅ "hima puri fw" -> MATCH (rank:', resHimaPuriFw.rank, ')');

// 10. hima xyz -> NO match
const resHimaXyz = checkMatch('hima xyz');
assert.strictEqual(resHimaXyz, null, 'hima xyz must NOT match');
console.log('  ✅ "hima xyz" -> NO MATCH (correctly rejected missing token)');

// -------------------------------------------------------------
// Test Case 2: Partial Token Matching
// -------------------------------------------------------------
console.log('\n--- Test 2: Partial Token Matching ---');
const partials = [
  { q: 'him', expected: true },
  { q: 'nee', expected: true },
  { q: 'pur', expected: true },
  { q: 'fw', expected: true },
  { q: 'him nee', expected: true },
  { q: 'nee him', expected: true }
];

partials.forEach(p => {
  const match = checkMatch(p.q);
  assert.strictEqual(match !== null, p.expected, `Query "${p.q}" partial match failed`);
  console.log(`  ✅ Partial "${p.q}" -> MATCH (rank: ${match.rank})`);
});

// -------------------------------------------------------------
// Test Case 3: Ranking Verification
// -------------------------------------------------------------
console.log('\n--- Test 3: Ranking Verification ---');
// 1. Exact full-name match -> rank 1
const exactMatch = checkMatch('hima puri neem fw');
assert.strictEqual(exactMatch.rank, 1, 'Exact full-name match must have rank 1');
console.log('  ✅ Rank Tier 1 (Exact Full-Name): "hima puri neem fw" has rank 1');

// 2. Exact phrase match -> rank 2
const phraseMatch = checkMatch('puri neem');
assert.strictEqual(phraseMatch.rank, 2, 'Exact phrase match must have rank 2');
console.log('  ✅ Rank Tier 2 (Exact Phrase): "puri neem" has rank 2');

// 3. All tokens whole words out-of-order -> rank 3
const wholeWordsOutOfOrder = checkMatch('neem hima');
assert.strictEqual(wholeWordsOutOfOrder.rank, 3, 'Whole words out-of-order must have rank 3');
console.log('  ✅ Rank Tier 3 (Whole Words Out-of-Order): "neem hima" has rank 3');

// 4. Substring partials out-of-order -> rank 4
const partialSubstrings = checkMatch('nee him');
assert.strictEqual(partialSubstrings.rank, 4, 'Partial substrings out-of-order must have rank 4');
console.log('  ✅ Rank Tier 4 (Partial Substrings Out-of-Order): "nee him" has rank 4');

assert(exactMatch.rank < phraseMatch.rank, 'Rank 1 must be higher priority than Rank 2');
assert(phraseMatch.rank < wholeWordsOutOfOrder.rank, 'Rank 2 must be higher priority than Rank 3');
assert(wholeWordsOutOfOrder.rank < partialSubstrings.rank, 'Rank 3 must be higher priority than Rank 4');

// -------------------------------------------------------------
// Test Case 4: Searchable Identity (Canonical Name & Aliases)
// -------------------------------------------------------------
console.log('\n--- Test 4: Searchable Identity with Canonical Names & Aliases ---');
const amulCanonical = 'AMUL BTTR 500 GM';
const amulAliases = ['AMUL BUTTER 500 GM', 'AMUL MAKHAN 500G'];

// Searching alias "makhan" on item whose itemName is "AMUL BTTR 500 GM"
const tokensMakhan = tokenizeSearchQuery('makhan amul');
const aliasMatch = evaluateSearchMatch(tokensMakhan, 'makhan amul', amulCanonical, [amulCanonical, ...amulAliases]);
assert(aliasMatch !== null, 'Search query with alias token must match searchable identity');
console.log('  ✅ Alias matching: "makhan amul" matches AMUL BTTR 500 GM via alias');

// Out of order tokens with alias: "500 butter"
const tokensButter = tokenizeSearchQuery('500 butter');
const butterMatch = evaluateSearchMatch(tokensButter, '500 butter', amulCanonical, [amulCanonical, ...amulAliases]);
assert(butterMatch !== null, 'Search query "500 butter" must match AMUL BTTR 500 GM via alias');
console.log('  ✅ Out-of-order alias token matching: "500 butter" matches AMUL BTTR 500 GM');

console.log('\n================================================================');
console.log('  ALL ORDER-INDEPENDENT SEARCH TESTS PASSED (100% SUCCESS)      ');
console.log('================================================================');
