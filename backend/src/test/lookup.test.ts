import 'dotenv/config';
import { getDb } from '../db';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import http from 'http';

const PORT = process.env.PORT || 8080;
const BASE_URL = `http://127.0.0.1:${PORT}/api`;
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';

function httpFetch(urlStr: string, customHeaders: Record<string, string> = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const req = http.request({
      hostname: u.hostname,
      port: u.port || 8080,
      path: u.pathname + u.search,
      method: 'GET',
      headers: {
        'x-forwarded-proto': 'https',
        ...customHeaders
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          json: async () => JSON.parse(data)
        });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function runTests() {
  console.log('================================================');
  console.log('   RUNNING AUTOMATED BARCODE LOOKUP TESTS       ');
  console.log('================================================');

  const db = await getDb();

  // 1. Prepare clean test state in database
  console.log('\n[1/3] Preparing test database entries...');
  await db.run('DELETE FROM products WHERE barcode LIKE ?', 'TEST_%');
  
  // Insert test products:
  // TEST_1001: Exact lookup target ($15.00) with wholesale pricing
  // TEST_10010: Trailing-zero lookup target ($10.00 - cheaper, should sort first) without wholesale
  // TEST_1002: Exact match only ($20.00) with wholesale pricing
  await db.run(
    `INSERT INTO products (barcode, name, sale_price, mrp, wholesale_price, wholesale_qty) 
     VALUES ('TEST_1001', 'Test Product Exact', 15.00, 15.00, 12.00, 5)`
  );
  await db.run(
    `INSERT INTO products (barcode, name, sale_price, mrp, wholesale_price, wholesale_qty) 
     VALUES ('TEST_10010', 'Test Product Zero Padded', 10.00, 10.00, NULL, NULL)`
  );
  await db.run(
    `INSERT INTO products (barcode, name, sale_price, mrp, wholesale_price, wholesale_qty) 
     VALUES ('TEST_1002', 'Test Product Single', 20.00, 20.00, 16.00, 3)`
  );

  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, message: string) {
    if (condition) {
      console.log(`  \u2705 PASS: ${message}`);
      passed++;
    } else {
      console.error(`  \u274c FAIL: ${message}`);
      failed++;
    }
  }

  // 2. Execute test cases via fetch API
  console.log('\n[2/3] Executing lookup test scenarios...');

  try {
    // Generate admin JWT token for authorized admin tests
    const adminToken = jwt.sign({ id: 999, username: 'test_admin' }, JWT_SECRET);

    // Scenario A: Exact barcode match - Customer (Unauthorized)
    const resA = await httpFetch(`${BASE_URL}/products/lookup/TEST_1002`);
    assert(resA.status === 200, 'Exact lookup returns 200 OK status');
    const dataA = await resA.json() as any;
    assert(dataA.multipleMatches === false, 'Exact lookup has multipleMatches: false');
    assert(Array.isArray(dataA.products), 'Exact lookup returns products list');
    assert(dataA.products.length === 1, 'Exact lookup returns exactly 1 item');
    assert(dataA.products[0].barcode === 'TEST_1002', 'Exact lookup returns correct product barcode');
    assert(dataA.products[0].wholesalePrice === undefined, 'Customer lookup does NOT disclose wholesalePrice (omitted)');
    assert(dataA.products[0].wholesaleQty === undefined, 'Customer lookup does NOT disclose wholesaleQty (omitted)');

    // Scenario A-Admin: Exact barcode match - Authorized Admin
    const resAAdmin = await httpFetch(`${BASE_URL}/products/lookup/TEST_1002`, {
      'Authorization': `Bearer ${adminToken}`
    });
    assert(resAAdmin.status === 200, 'Admin exact lookup returns 200 OK');
    const dataAAdmin = await resAAdmin.json() as any;
    assert(dataAAdmin.products[0].wholesalePrice === 16.00, 'Admin lookup returns correct wholesalePrice (16.00)');
    assert(dataAAdmin.products[0].wholesaleQty === 3, 'Admin lookup returns correct wholesaleQty (3)');

    // Scenario B: Trailing-zero match
    // Querying TEST_10010 should match exactly
    const resB = await httpFetch(`${BASE_URL}/products/lookup/TEST_10010`);
    assert(resB.status === 200, 'Zero padded lookup returns 200 OK');
    const dataB = await resB.json() as any;
    assert(dataB.multipleMatches === false, 'Zero padded lookup has multipleMatches: false');
    assert(dataB.products.length === 1, 'Zero padded lookup returns exactly 1 item');
    assert(dataB.products[0].barcode === 'TEST_10010', 'Zero padded lookup returns correct barcode');
    assert(dataB.products[0].wholesalePrice === undefined, 'Customer lookup zero-padded wholesalePrice is undefined');
    assert(dataB.products[0].wholesaleQty === undefined, 'Customer lookup zero-padded wholesaleQty is undefined');

    // Scenario C: Both exact and trailing-zero matches returned together (Customer)
    // Querying TEST_1001 matches exact TEST_1001 and trailing-zero TEST_10010
    const resC = await httpFetch(`${BASE_URL}/products/lookup/TEST_1001`);
    assert(resC.status === 200, 'Query matches both barcodes');
    const dataC = await resC.json() as any;
    assert(dataC.multipleMatches === true, 'Combined lookup has multipleMatches: true');
    assert(dataC.products.length === 2, 'Query returns both matching items');

    // Scenario D: Duplicate removal
    // Our query selects exactly barcode = ? or barcode = ?0.
    // If they evaluate to the same thing, deduplication handles it.
    // Map check:
    const barcodes = dataC.products.map((p: any) => p.barcode);
    const uniqueBarcodes = Array.from(new Set(barcodes));
    assert(barcodes.length === uniqueBarcodes.length, 'Results contain zero duplicate items');

    // Scenario E: Results sorted by MRP in ascending order
    // TEST_10010 is $10.00, TEST_1001 is $15.00. TEST_10010 must be index 0.
    assert(dataC.products[0].barcode === 'TEST_10010', 'Cheaper product is listed first in response');
    assert(dataC.products[0].mrp === 10.00, 'First item MRP is $10.00');
    assert(dataC.products[0].salePrice === 10.00, 'First item salePrice is $10.00');
    assert(dataC.products[0].wholesalePrice === undefined, 'Customer lookup item 0 wholesalePrice omitted');
    assert(dataC.products[0].wholesaleQty === undefined, 'Customer lookup item 0 wholesaleQty omitted');
    assert(dataC.products[1].barcode === 'TEST_1001', 'More expensive product is listed second');
    assert(dataC.products[1].mrp === 15.00, 'Second item MRP is $15.00');
    assert(dataC.products[1].salePrice === 15.00, 'Second item salePrice is $15.00');
    assert(dataC.products[1].wholesalePrice === undefined, 'Customer lookup item 1 wholesalePrice omitted');
    assert(dataC.products[1].wholesaleQty === undefined, 'Customer lookup item 1 wholesaleQty omitted');

    // Scenario E-Admin: Both exact and trailing-zero matches returned for Authorized Admin
    const resCAdmin = await httpFetch(`${BASE_URL}/products/lookup/TEST_1001`, {
      'Authorization': `Bearer ${adminToken}`
    });
    assert(resCAdmin.status === 200, 'Admin query matches both barcodes');
    const dataCAdmin = await resCAdmin.json() as any;
    assert(dataCAdmin.products[0].wholesalePrice === null, 'Admin item 0 has null wholesalePrice');
    assert(dataCAdmin.products[0].wholesaleQty === null, 'Admin item 0 has null wholesaleQty');
    assert(dataCAdmin.products[1].wholesalePrice === 12.00, 'Admin item 1 has correct wholesalePrice (12.00)');
    assert(dataCAdmin.products[1].wholesaleQty === 5, 'Admin item 1 has correct wholesaleQty (5)');

    // Scenario F: No matching products (Article VII: Price Integrity)
    const resF = await httpFetch(`${BASE_URL}/products/lookup/TEST_9999_NON_EXISTENT`);
    assert(resF.status === 404, 'Non-existent barcode lookup returns 404 Status');
    const dataF = await resF.json() as any;
    assert(dataF.success === false, 'Non-existent response success flag is false');
    assert(dataF.message === 'Product is unavailable or not found', 'Non-existent response shows correct message');

    // Scenario G: Customer Product Search endpoint does NOT disclose wholesale info
    const resG = await httpFetch(`${BASE_URL}/products/search?q=TEST`);
    assert(resG.status === 200, 'Search returns 200 OK');
    const dataG = await resG.json() as any;
    const results = Array.isArray(dataG) ? dataG : dataG.products;
    assert(Array.isArray(results) && results.length > 0, 'Search returns product results');
    const anyDisclosed = results.some((p: any) => p.wholesalePrice !== undefined || p.wholesaleQty !== undefined);
    assert(!anyDisclosed, 'Customer search endpoint strictly omits wholesalePrice and wholesaleQty');

  } catch (err: any) {
    console.error('Fatal test runtime error:', err);
    failed++;
  }

  // 3. Clean up database
  console.log('\n[3/3] Cleaning up test database entries...');
  await db.run('DELETE FROM products WHERE barcode LIKE ?', 'TEST_%');
  await db.close();

  console.log('\n================================================');
  console.log(`   TEST EXECUTION COMPLETED: ${passed} PASSED, ${failed} FAILED`);
  console.log('================================================');

  if (failed > 0) {
    setTimeout(() => process.exit(1), 500);
  } else {
    setTimeout(() => process.exit(0), 500);
  }
}

runTests().catch(console.error);
