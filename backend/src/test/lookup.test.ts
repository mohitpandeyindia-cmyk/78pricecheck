import { getDb } from '../db';
import bcrypt from 'bcryptjs';

const BASE_URL = 'http://localhost:8080/api';

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
      console.log(`  ✅ PASS: ${message}`);
      passed++;
    } else {
      console.error(`  ❌ FAIL: ${message}`);
      failed++;
    }
  }

  // 2. Execute test cases via fetch API
  console.log('\n[2/3] Executing lookup test scenarios...');

  try {
    // Scenario A: Exact barcode match
    const resA = await fetch(`${BASE_URL}/products/lookup/TEST_1002`);
    assert(resA.status === 200, 'Exact lookup returns 200 OK status');
    const dataA = await resA.json() as any;
    assert(dataA.multipleMatches === false, 'Exact lookup has multipleMatches: false');
    assert(Array.isArray(dataA.products), 'Exact lookup returns products list');
    assert(dataA.products.length === 1, 'Exact lookup returns exactly 1 item');
    assert(dataA.products[0].barcode === 'TEST_1002', 'Exact lookup returns correct product barcode');
    assert(dataA.products[0].wholesalePrice === 16.00, 'Exact lookup returns correct wholesalePrice (16.00)');
    assert(dataA.products[0].wholesaleQty === 3, 'Exact lookup returns correct wholesaleQty (3)');

    // Scenario B: Trailing-zero match
    // Querying TEST_10010 should match exactly
    const resB = await fetch(`${BASE_URL}/products/lookup/TEST_10010`);
    assert(resB.status === 200, 'Zero padded lookup returns 200 OK');
    const dataB = await resB.json() as any;
    assert(dataB.multipleMatches === false, 'Zero padded lookup has multipleMatches: false');
    assert(dataB.products.length === 1, 'Zero padded lookup returns exactly 1 item');
    assert(dataB.products[0].barcode === 'TEST_10010', 'Zero padded lookup returns correct barcode');
    assert(dataB.products[0].wholesalePrice === null, 'Zero padded lookup returns null wholesalePrice');
    assert(dataB.products[0].wholesaleQty === null, 'Zero padded lookup returns null wholesaleQty');

    // Scenario C: Both exact and trailing-zero matches returned together
    // Querying TEST_1001 matches exact TEST_1001 and trailing-zero TEST_10010
    const resC = await fetch(`${BASE_URL}/products/lookup/TEST_1001`);
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
    assert(dataC.products[0].wholesalePrice === null, 'First item wholesalePrice is null');
    assert(dataC.products[0].wholesaleQty === null, 'First item wholesaleQty is null');
    assert(dataC.products[1].barcode === 'TEST_1001', 'More expensive product is listed second');
    assert(dataC.products[1].mrp === 15.00, 'Second item MRP is $15.00');
    assert(dataC.products[1].salePrice === 15.00, 'Second item salePrice is $15.00');
    assert(dataC.products[1].wholesalePrice === 12.00, 'Second item wholesalePrice is 12.00');
    assert(dataC.products[1].wholesaleQty === 5, 'Second item wholesaleQty is 5');

    // Scenario F: No matching products (Article VII: Price Integrity)
    const resF = await fetch(`${BASE_URL}/products/lookup/TEST_9999_NON_EXISTENT`);
    assert(resF.status === 404, 'Non-existent barcode lookup returns 404 Status');
    const dataF = await resF.json() as any;
    assert(dataF.success === false, 'Non-existent response success flag is false');
    assert(dataF.message === 'Product is unavailable or not found', 'Non-existent response shows correct message');

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
