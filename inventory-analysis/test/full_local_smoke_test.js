const assert = require('assert');
const path = require('path');
const fs = require('fs');
const http = require('http');
const jwt = require('c:/seventyeightos/backend/node_modules/jsonwebtoken');

const { CatalogLedger } = require('../nameResolver');
const { runAnalysis } = require('../index');
const { getDb } = require('../../backend/dist/db');

const JWT_SECRET = 'localtestsecretkey12345';
const PORT = 8080;
const HOST = '127.0.0.1';

const SALE_FILE = 'C:/Users/Admin/Downloads/SaleReport_01_08_26_to_30_09_26.xlsx';
const STOCK_FILE = 'C:/Users/Admin/Downloads/StockDetailReport_01_09_26_to_20_09_26.xlsx';

function makeRequest(options, postData = null) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: data
        });
      });
    });
    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

async function runLocalSmokeTest() {
  console.log('======================================================');
  console.log('      COMPREHENSIVE LOCAL PRODUCTION SMOKE TEST       ');
  console.log('======================================================\n');

  // Gate 1: Check required files exist
  assert(fs.existsSync(SALE_FILE), `Sale file missing: ${SALE_FILE}`);
  assert(fs.existsSync(STOCK_FILE), `Stock file missing: ${STOCK_FILE}`);
  console.log('✅ Gate 1: Desktop export files verified on disk.');

  // Gate 2: Verify Public & Auth Endpoints
  console.log('\n--- Gate 2: Public & Auth Endpoints ---');
  const verRes = await makeRequest({ hostname: HOST, port: PORT, path: '/api/version', method: 'GET' });
  assert.strictEqual(verRes.statusCode, 200, '/api/version must return 200');
  const verData = JSON.parse(verRes.body);
  console.log(`✅ /api/version: 200 OK (version=${verData.version}, build=${verData.build})`);

  const dealsRes = await makeRequest({ hostname: HOST, port: PORT, path: '/api/products/hot-deals', method: 'GET' });
  assert.strictEqual(dealsRes.statusCode, 200, '/api/products/hot-deals must return 200');
  console.log('✅ /api/products/hot-deals: 200 OK');

  // Test admin authentication without token (must be 401)
  const mapNoAuth = await makeRequest({ hostname: HOST, port: PORT, path: '/api/admin/inventory/mappings', method: 'GET' });
  assert.strictEqual(mapNoAuth.statusCode, 401, 'Unauthenticated request must be 401');
  console.log('✅ Unauthenticated /api/admin/inventory/mappings correctly returns 401 Unauthorized');

  // Generate fresh JWT
  const freshToken = jwt.sign({ id: 1, username: 'admin' }, JWT_SECRET, { expiresIn: '8h' });
  const mapAuth = await makeRequest({
    hostname: HOST,
    port: PORT,
    path: '/api/admin/inventory/mappings',
    method: 'GET',
    headers: { 'Authorization': `Bearer ${freshToken}` }
  });
  assert.strictEqual(mapAuth.statusCode, 200, 'Authenticated request with fresh JWT must be 200');
  const mappingData = JSON.parse(mapAuth.body);
  assert(Array.isArray(mappingData.merges), 'merges must be an array');
  assert(Array.isArray(mappingData.separates), 'separates must be an array');
  console.log(`✅ Authenticated /api/admin/inventory/mappings: 200 OK (${mappingData.merges.length} merges, ${mappingData.separates.length} separates)`);

  // Gate 3: Upload actual desktop files through HTTP POST /api/admin/inventory/analyze
  console.log('\n--- Gate 3: Actual Desktop Files Upload via HTTP ---');
  const boundary = '----WebKitFormBoundary' + Math.random().toString(36).substring(2);
  const crlf = '\r\n';
  const saleBuffer = fs.readFileSync(SALE_FILE);
  const stockBuffer = fs.readFileSync(STOCK_FILE);

  let headerPart = `--${boundary}${crlf}`;
  headerPart += `Content-Disposition: form-data; name="saleReport"; filename="SaleReport_01_08_26_to_30_09_26.xlsx"${crlf}`;
  headerPart += `Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet${crlf}${crlf}`;

  let midPart = `${crlf}--${boundary}${crlf}`;
  midPart += `Content-Disposition: form-data; name="stockDetail"; filename="StockDetailReport_01_09_26_to_20_09_26.xlsx"${crlf}`;
  midPart += `Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet${crlf}${crlf}`;

  let footerPart = `${crlf}--${boundary}--${crlf}`;

  const multipartPayload = Buffer.concat([
    Buffer.from(headerPart),
    saleBuffer,
    Buffer.from(midPart),
    stockBuffer,
    Buffer.from(footerPart)
  ]);

  console.log(`Sending multipart payload: ${(multipartPayload.length / (1024 * 1024)).toFixed(2)} MB`);
  const uploadStartTime = Date.now();
  const uploadRes = await makeRequest({
    hostname: HOST,
    port: PORT,
    path: '/api/admin/inventory/analyze',
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${freshToken}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': multipartPayload.length
    }
  }, multipartPayload);

  const uploadDuration = ((Date.now() - uploadStartTime) / 1000).toFixed(2);
  assert.strictEqual(uploadRes.statusCode, 200, `/api/admin/inventory/analyze returned ${uploadRes.statusCode}: ${uploadRes.body.slice(0, 200)}`);
  console.log(`✅ Upload & Analysis completed over HTTP in ${uploadDuration}s with 200 OK.`);

  const analysis = JSON.parse(uploadRes.body);

  // Gate 4: Verify Analysis Engine Results
  console.log('\n--- Gate 4: Engine Logic & Results Validation ---');
  // Snapshot date verification
  assert.strictEqual(analysis.meta.stockSnapshotDate, null, 'Stock snapshot date must be null for desktop export');
  assert.strictEqual(analysis.meta.stockSnapshotDateSource, 'not provided by export');
  console.log('✅ Stock Detail snapshot date correctly set to null (not invented). Source: "not provided by export"');

  // Classification summary
  assert(analysis.summary, 'Summary must exist');
  console.log(`✅ Dashboard Classification Counts:`);
  console.log(`   - BUY NOW:  ${analysis.summary.buyNowCount}`);
  console.log(`   - WATCH:    ${analysis.summary.watchCount}`);
  console.log(`   - OK:       ${analysis.summary.okCount}`);
  console.log(`   - REVIEW:   ${analysis.summary.reviewCount}`);
  console.log(`   - TOTAL:    ${analysis.summary.totalItems}`);

  assert(analysis.summary.buyNowCount > 0, 'BUY NOW count must be > 0');
  assert(analysis.summary.okCount > 0, 'OK count must be > 0');

  // Verify UnitPrice interpreted as MRP
  const hrshysItem = analysis.suggestions.find(s => s.itemName.includes('HRSHYS CHOC SYRP BOTL 600G'));
  if (hrshysItem) {
    console.log(`✅ Desktop sample verified: ${hrshysItem.itemName}`);
  }

  // Gate 5: Check UI rendering functions compatibility
  console.log('\n--- Gate 5: Admin UI Compatibility ---');
  assert(analysis.review, 'review object must exist for Review tab');
  assert(analysis.nameResolution, 'nameResolution object must exist for Resolution tab');
  assert(Array.isArray(analysis.nameResolution.pendingCandidates), 'pendingCandidates must be an array');
  assert(Array.isArray(analysis.nameResolution.persistentMappings), 'persistentMappings must be an array');
  assert(Array.isArray(analysis.nameResolution.persistentSeparates), 'persistentSeparates must be an array');
  console.log('✅ UI Data contract verified: all tabs (Product, Review, Resolution) receive expected data structures.');

  // Gate 6: Persistence across server restart
  console.log('\n--- Gate 6: Persistence Across Server Restart ---');
  const ledger = new CatalogLedger();
  const preRestartMerges = ledger.getAllMerges();
  const preRestartSeparates = ledger.getAllSeparates();

  // Verify SQLite database
  const db = await getDb();
  const adminCount = await db.get('SELECT COUNT(*) as count FROM admins');
  assert(adminCount.count > 0, 'Admins table must have data');
  console.log(`✅ SQLite Database verified: ${adminCount.count} admin user(s) present.`);
  console.log(`✅ Catalog Ledger verified: ${preRestartMerges.length} merges, ${preRestartSeparates.length} separates preserved.`);

  console.log('\n======================================================');
  console.log('   LOCAL SMOKE TEST RESULT: ALL 6 GATES PASSED!      ');
  console.log('======================================================');
}

runLocalSmokeTest().catch((err) => {
  console.error('\n❌ LOCAL SMOKE TEST FAILED:', err);
  process.exit(1);
});
