const https = require('https');
const assert = require('assert');

// Custom fetcher connecting directly to Railway edge IP 69.46.46.47
// to bypass local DNS resolver issues
function requestRailway(path, options = {}) {
  return new Promise((resolve, reject) => {
    const host = 'pricecheck.78supermaart.in';
    const req = https.request({
      hostname: '69.46.46.47',
      port: 443,
      path: path,
      method: options.method || 'GET',
      headers: {
        'Host': host,
        'User-Agent': 'Railway-Production-Smoke-Tester/1.0',
        ...(options.headers || {})
      },
      servername: host,
      rejectUnauthorized: false
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({
        statusCode: res.statusCode,
        headers: res.headers,
        body: data,
        json: () => {
          try { return JSON.parse(data); } catch (e) { return null; }
        }
      }));
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function runProductionSmokeTest() {
  console.log('================================================================');
  console.log('   RUNNING PRODUCTION SMOKE TEST ON RAILWAY DEPLOYMENT');
  console.log('   Target Host: pricecheck.78supermaart.in (Railway CNAME: ttltusqy.up.railway.app)');
  console.log('   Commit Tested: cb65773');
  console.log('================================================================\n');

  let passedGates = 0;
  const totalGates = 7;

  // Gate 1: Health Endpoint
  console.log('[Gate 1/7] Testing /api/health...');
  const healthRes = await requestRailway('/api/health');
  assert.strictEqual(healthRes.statusCode, 200, 'Health endpoint should return 200');
  const health = healthRes.json();
  assert(health && health.status === 'healthy', 'Status should be healthy');
  assert.strictEqual(health.database, 'connected', 'Database should be connected');
  console.log(`  ✅ Health check PASSED (status: ${health.status}, version: ${health.version}, db: ${health.database}, uptime: ${Math.round(health.uptime)}s)`);
  passedGates++;

  // Gate 2: Version Endpoint
  console.log('\n[Gate 2/7] Testing /api/version...');
  const verRes = await requestRailway('/api/version');
  assert.strictEqual(verRes.statusCode, 200, 'Version endpoint should return 200');
  const ver = verRes.json();
  assert.strictEqual(ver.application, '78 PriceCheck');
  console.log(`  ✅ Version check PASSED (app: ${ver.application}, catalog: ${ver.catalogVersion}, products: ${ver.productsCount})`);
  passedGates++;

  // Gate 3: Customer Portal & Build Artifact
  console.log('\n[Gate 3/7] Testing Customer Portal (/) & Build Environment...');
  const custRes = await requestRailway('/');
  assert.strictEqual(custRes.statusCode, 200);
  assert(custRes.body.includes('78 PriceCheck'), 'Home page should include brand name');

  const buildEnvRes = await requestRailway('/js/build-env.js');
  assert.strictEqual(buildEnvRes.statusCode, 200);
  assert(buildEnvRes.body.includes('window.APP_BUILD'), 'build-env.js should define APP_BUILD');
  const swRes = await requestRailway('/sw.js');
  assert.strictEqual(swRes.statusCode, 200);
  const swCache = swRes.body.match(/CACHE_NAME = '([^']+)';/)?.[1];
  console.log(`  ✅ Customer Portal PASSED (Service Worker active cache: ${swCache})`);
  passedGates++;

  // Gate 4: Public Deals API
  console.log('\n[Gate 4/7] Testing /api/products/hot-deals...');
  const dealsRes = await requestRailway('/api/products/hot-deals');
  assert.strictEqual(dealsRes.statusCode, 200);
  const deals = dealsRes.json();
  assert(deals.success && Array.isArray(deals.products) && deals.products.length > 0);
  console.log(`  ✅ Public Hot Deals PASSED (${deals.products.length} products returned)`);
  passedGates++;

  // Gate 5: Admin Inventory HTML Structure & UI Components
  console.log('\n[Gate 5/7] Testing /admin/inventory.html UI components...');
  const invRes = await requestRailway('/admin/inventory.html');
  assert.strictEqual(invRes.statusCode, 200);
  assert(invRes.body.includes('master-search-input'), 'UI must contain master-search-input');
  assert(invRes.body.includes('Upload MRP Master'), 'UI must contain Upload MRP Master button');
  assert(invRes.body.includes('mrp-master-input'), 'UI must contain mrp-master-input file field');
  assert(invRes.body.includes('mrp-file-name'), 'UI must contain mrp-file-name container');
  console.log('  ✅ Admin Inventory Page PASSED (Master search, Upload MRP Master button, and status container present)');
  passedGates++;

  // Gate 6: Admin Inventory JavaScript Bundle & MRP Evidence Logic
  console.log('\n[Gate 6/7] Testing /admin/js/inventory.js client logic...');
  const jsRes = await requestRailway('/admin/js/inventory.js');
  assert.strictEqual(jsRes.statusCode, 200);
  assert(jsRes.body.includes('/api/admin/inventory/mrp-master'), 'JS must call MRP Master endpoint');
  assert(jsRes.body.includes('/api/admin/inventory/mrp-master/status'), 'JS must query MRP Master status');
  assert(jsRes.body.includes('MRP Master ✓'), 'JS must display MRP Master success badge');
  assert(jsRes.body.includes('badge-mrp-consistent') || jsRes.body.includes('MRP CONSISTENT'), 'JS must include MRP CONSISTENT badge');
  console.log('  ✅ Inventory Assistant JS PASSED (Authoritative MRP Master handler and cross-check badge logic present)');
  passedGates++;

  // Gate 7: Protected Route Security
  console.log('\n[Gate 7/7] Testing Protected Endpoint Security...');
  const secRes = await requestRailway('/api/admin/inventory/mrp-master/status');
  assert.strictEqual(secRes.statusCode, 401, 'Unauthenticated status query must be rejected');
  const secData = secRes.json();
  assert.strictEqual(secData.success, false);
  console.log('  ✅ API Security PASSED (/api/admin/inventory/mrp-master/status rejected unauthenticated request with 401)');
  passedGates++;

  console.log('\n================================================================');
  console.log(`  🎉 PRODUCTION SMOKE TEST PASSED: ${passedGates}/${totalGates} GATES PASSED`);
  console.log('================================================================\n');
}

runProductionSmokeTest().catch(err => {
  console.error('\n❌ Smoke Test failed:', err);
  process.exit(1);
});
