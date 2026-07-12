import { getDb } from '../db';
import * as XLSX from 'xlsx';

const BASE_URL = 'http://localhost:8080/api';

async function runTests() {
  console.log('================================================');
  console.log('   RUNNING AUTOMATED EXCEL IMPORT TESTS        ');
  console.log('================================================');

  const db = await getDb();
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

  // Helper to construct multipart/form-data body manually
  function makeMultipartBody(fileBuffer: Buffer, filename: string) {
    const boundary = '----TestBoundary' + Math.random().toString(36).substring(2);
    const bodyParts = [
      Buffer.from(`--${boundary}\r\n`),
      Buffer.from(`Content-Disposition: form-data; name="file"; filename="${filename}"\r\n`),
      Buffer.from(`Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n`),
      fileBuffer,
      Buffer.from(`\r\n--${boundary}--\r\n`)
    ];
    return {
      contentType: `multipart/form-data; boundary=${boundary}`,
      body: Buffer.concat(bodyParts)
    };
  }

  try {
    // 1. Obtain admin token
    console.log('\n[1/5] Authenticating admin user...');
    let token = '';
    
    // Attempt to register first-time admin
    const regRes = await fetch(`${BASE_URL}/admin/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'import_admin', password: 'password123' })
    });
    
    if (regRes.status === 200) {
      const regData = await regRes.json() as any;
      console.log('  Registered new test admin account.');
    }
    
    // Login to get token
    const loginRes = await fetch(`${BASE_URL}/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'import_admin', password: 'password123' })
    });
    
    if (loginRes.status === 200) {
      const loginData = await loginRes.json() as any;
      token = loginData.token;
    } else {
      // Fallback: Login with existing user admin2 from previous tests
      const fallbackRes = await fetch(`${BASE_URL}/admin/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin2', password: 'password123' })
      });
      const loginData = await fallbackRes.json() as any;
      token = loginData.token;
    }
    
    assert(!!token, 'Obtained valid admin JWT access token');

    // 2. Test GET /api/admin/template
    console.log('\n[2/5] Verifying Excel template generation...');
    const tempRes = await fetch(`${BASE_URL}/admin/template`);
    assert(tempRes.status === 200, 'GET /admin/template returns 200 OK');
    
    const arrayBuf = await tempRes.arrayBuffer();
    const tempWorkbook = XLSX.read(Buffer.from(arrayBuf), { type: 'buffer' });
    const tempSheet = tempWorkbook.Sheets[tempWorkbook.SheetNames[0]];
    const tempRows = XLSX.utils.sheet_to_json(tempSheet, { header: 1 }) as any[][];
    
    assert(tempRows.length > 0, 'Excel template contains at least header row');
    const headers = tempRows[0];
    assert(
      headers[0] === 'Barcode' && 
      headers[1] === 'Product Name' && 
      headers[2] === 'MRP' && 
      headers[3] === 'Sale Price' &&
      headers[4] === 'Wholesale Price' &&
      headers[5] === 'Wholesale Qty',
      'Template headers match exactly: Barcode, Product Name, MRP, Sale Price, Wholesale Price, Wholesale Qty'
    );

    // 3. Test POST /api/admin/upload - Header Validation
    console.log('\n[3/5] Testing header mismatch validation...');
    const badWb = XLSX.utils.book_new();
    const badWs = XLSX.utils.aoa_to_sheet([['Barcode', 'Product Name', 'Wrong Header', 'Sale Price']]);
    XLSX.utils.book_append_sheet(badWb, badWs, 'Catalog');
    const badBuf = XLSX.write(badWb, { type: 'buffer', bookType: 'xlsx' });
    
    const multipartBad = makeMultipartBody(badBuf, 'bad_headers.xlsx');
    const badUploadRes = await fetch(`${BASE_URL}/admin/upload`, {
      method: 'POST',
      headers: {
        'Content-Type': multipartBad.contentType,
        'Authorization': `Bearer ${token}`
      },
      body: multipartBad.body
    });
    
    assert(badUploadRes.status === 400, 'Uploading incorrect headers returns 400 Bad Request');
    const badUploadData = await badUploadRes.json() as any;
    assert(badUploadData.success === false, 'Error response success flag is false');
    assert(badUploadData.message.includes('Header mismatch'), 'Error response explains header mismatch');

    // 4. Test POST /api/admin/upload - Row Validation & Atomic Failure Rollback
    console.log('\n[4/5] Testing row-level validation & rollback...');
    
    // Seed database with a known product to verify it stays untouched on failure
    await db.run('DELETE FROM products');
    await db.run(
      `INSERT INTO products (barcode, name, sale_price, mrp) 
       VALUES ('PRE_EXISTING', 'Should Survive Failure', 5.00, 5.00)`
    );

    // Build a spreadsheet with one bad row
    const invalidWb = XLSX.utils.book_new();
    const invalidWs = XLSX.utils.aoa_to_sheet([
      ['Barcode', 'Product Name', 'MRP', 'Sale Price'],
      ['TEST_A', 'Valid Product A', 10.00, 8.00],
      ['TEST_B', 'Invalid Product B (Sale > MRP)', 10.00, 12.00], // Invalid
      ['', 'Invalid Product C (No Barcode)', 5.00, 4.00] // Invalid
    ]);
    XLSX.utils.book_append_sheet(invalidWb, invalidWs, 'Catalog');
    const invalidBuf = XLSX.write(invalidWb, { type: 'buffer', bookType: 'xlsx' });
    
    const multipartInvalid = makeMultipartBody(invalidBuf, 'invalid_rows.xlsx');
    const invalidUploadRes = await fetch(`${BASE_URL}/admin/upload`, {
      method: 'POST',
      headers: {
        'Content-Type': multipartInvalid.contentType,
        'Authorization': `Bearer ${token}`
      },
      body: multipartInvalid.body
    });
    
    assert(invalidUploadRes.status === 400, 'Uploading invalid rows returns 400 Bad Request');
    const invalidUploadData = await invalidUploadRes.json() as any;
    assert(invalidUploadData.success === false, 'Success indicator is false on invalid rows');
    assert(invalidUploadData.errors.length === 2, 'Validation reports exactly two errors');
    assert(invalidUploadData.summary.status === 'Failed', 'Upload status is registered as Failed');

    // Verify existing database catalogue was untouched (atomic rollback)
    const survivors = await db.all('SELECT barcode FROM products');
    assert(survivors.length === 1 && survivors[0].barcode === 'PRE_EXISTING', 'Database catalogue left completely untouched on rejection');

    // Retrieve upload history run ID to test CSV error download
    const historyRes = await fetch(`${BASE_URL}/admin/upload-history`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    console.log('  Upload History Response Status:', historyRes.status);
    const text = await historyRes.text();
    console.log('  Upload History Response Body:', text);
    const historyData = JSON.parse(text);
    const failedRun = Array.isArray(historyData) ? historyData.find(run => run.filename === 'invalid_rows.xlsx') : null;
    assert(!!failedRun, 'Failed upload run recorded in upload_history logs');
    assert(failedRun.status === 'Failed', 'Failed run status is logged as Failed');
    assert(failedRun.failedRows === 2, 'Failed run logs correct number of failed rows');

    // Download CSV error report
    const errReportRes = await fetch(`${BASE_URL}/admin/upload-errors/${failedRun.id}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    assert(errReportRes.status === 200, 'Download errors CSV endpoint returns 200 OK');
    const errReportCsv = await errReportRes.text();
    assert(errReportCsv.includes('Row,Barcode,Product Name,Error Description'), 'CSV error report has correct header line');
    assert(errReportCsv.includes('Invalid Product B (Sale > MRP)'), 'CSV contains validation error reasons');

    // 5. Test POST /api/admin/upload - Successful Replacement
    console.log('\n[5/5] Testing successful catalogue replacement...');
    const validWb = XLSX.utils.book_new();
    const validWs = XLSX.utils.aoa_to_sheet([
      ['Barcode', 'Product Name', 'MRP', 'Sale Price'],
      ['TEST_X', 'Imported Product X', 15.00, 12.00],
      ['TEST_Y', 'Imported Product Y', 8.00, 8.00]
    ]);
    XLSX.utils.book_append_sheet(validWb, validWs, 'Catalog');
    const validBuf = XLSX.write(validWb, { type: 'buffer', bookType: 'xlsx' });
    
    const multipartValid = makeMultipartBody(validBuf, 'valid_catalog.xlsx');
    const validUploadRes = await fetch(`${BASE_URL}/admin/upload`, {
      method: 'POST',
      headers: {
        'Content-Type': multipartValid.contentType,
        'Authorization': `Bearer ${token}`
      },
      body: multipartValid.body
    });
    
    assert(validUploadRes.status === 200, 'Valid catalogue upload returns 200 OK');
    const validUploadData = await validUploadRes.json() as any;
    assert(validUploadData.success === true, 'Success indicator is true on successful upload');
    assert(validUploadData.totalRows === 2, 'Returns correct totalRows count');

    // Verify database exactly matches the uploaded sheet
    const activeProducts = await db.all('SELECT barcode, name, sale_price, mrp FROM products ORDER BY barcode ASC');
    assert(activeProducts.length === 2, 'Products table has exactly 2 records');
    assert(activeProducts[0].barcode === 'TEST_X' && activeProducts[0].name === 'Imported Product X', 'First row matches spreadsheet values');
    assert(activeProducts[1].barcode === 'TEST_Y' && activeProducts[1].name === 'Imported Product Y', 'Second row matches spreadsheet values');
    
    const preExisting = activeProducts.find(p => p.barcode === 'PRE_EXISTING');
    assert(!preExisting, 'Pre-existing products are deleted (full catalog replacement)');

    // 6. Test Case-Insensitive Header Mapping
    console.log('\n[6/6] Testing case-insensitive headers, duplicate file check, and version metadata...');
    const mixedHeaderWb = XLSX.utils.book_new();
    const mixedHeaderWs = XLSX.utils.aoa_to_sheet([
      ['barcode', 'PRODUCT NAME', 'mrp', 'Sale Price'], // mixed case
      ['TEST_CASE_1', 'Cased Product 1', 20.00, 18.00]
    ]);
    XLSX.utils.book_append_sheet(mixedHeaderWb, mixedHeaderWs, 'Catalog');
    const mixedHeaderBuf = XLSX.write(mixedHeaderWb, { type: 'buffer', bookType: 'xlsx' });
    
    const multipartMixed = makeMultipartBody(mixedHeaderBuf, 'mixed_headers.xlsx');
    const mixedUploadRes = await fetch(`${BASE_URL}/admin/upload`, {
      method: 'POST',
      headers: {
        'Content-Type': multipartMixed.contentType,
        'Authorization': `Bearer ${token}`
      },
      body: multipartMixed.body
    });
    assert(mixedUploadRes.status === 200, 'Case-insensitive header columns upload successfully (200 OK)');

    // 7. Test Duplicate Barcode inside the spreadsheet
    const dupSheetWb = XLSX.utils.book_new();
    const dupSheetWs = XLSX.utils.aoa_to_sheet([
      ['Barcode', 'Product Name', 'MRP', 'Sale Price'],
      ['TEST_DUP_1', 'Milk Box A', 100.00, 90.00],
      ['TEST_DUP_1', 'Milk Box B', 105.00, 95.00] // duplicate barcode in sheet
    ]);
    XLSX.utils.book_append_sheet(dupSheetWb, dupSheetWs, 'Catalog');
    const dupSheetBuf = XLSX.write(dupSheetWb, { type: 'buffer', bookType: 'xlsx' });
    
    const multipartDup = makeMultipartBody(dupSheetBuf, 'duplicate_row.xlsx');
    const dupUploadRes = await fetch(`${BASE_URL}/admin/upload`, {
      method: 'POST',
      headers: {
        'Content-Type': multipartDup.contentType,
        'Authorization': `Bearer ${token}`
      },
      body: multipartDup.body
    });
    assert(dupUploadRes.status === 400, 'Inconsistent spreadsheet with duplicate barcode rows is rejected (400 Bad Request)');
    const dupUploadData = await dupUploadRes.json() as any;
    assert(dupUploadData.success === false, 'Duplicate response success flag is false');
    assert(dupUploadData.errors[0].error.includes('Duplicate barcode'), 'Error message reports duplicate barcode in file');

    // 8. Test Version Endpoint `/api/version`
    const versionRes = await fetch(`${BASE_URL}/version`);
    assert(versionRes.status === 200, 'GET /version returns 200 OK');
    const versionData = await versionRes.json() as any;
    assert(versionData.application === '78 PriceCheck', 'Application name matches "78 PriceCheck"');
    assert(versionData.version === '0.3.0', 'Application version is logged as 0.3.0');
    assert(versionData.databaseVersion === '3', 'Database version is logged as 3');
    assert(versionData.catalogVersion !== 'empty', 'Catalog version is populated');
    assert(versionData.lastCatalogUpload !== null, 'Last upload timestamp is logged');

    // 9. Wholesale / Bulk Offer validation tests
    console.log('\n[9/9] Testing Wholesale / Bulk Offer validation rules...');
    
    // 9a. Test missing quantity rejection
    const invalidBulkQtyWb = XLSX.utils.book_new();
    const invalidBulkQtyWs = XLSX.utils.aoa_to_sheet([
      ['Barcode', 'Product Name', 'MRP', 'Sale Price', 'Wholesale Price', 'Wholesale Qty'],
      ['TEST_BULK_BAD_QTY', 'Wholesale Missing Qty', 100.00, 80.00, 70.00, '']
    ]);
    XLSX.utils.book_append_sheet(invalidBulkQtyWb, invalidBulkQtyWs, 'Catalog');
    const invalidBulkQtyBuf = XLSX.write(invalidBulkQtyWb, { type: 'buffer', bookType: 'xlsx' });
    const multipartBulkQty = makeMultipartBody(invalidBulkQtyBuf, 'invalid_bulk_qty.xlsx');
    const bulkQtyRes = await fetch(`${BASE_URL}/admin/upload`, {
      method: 'POST',
      headers: { 'Content-Type': multipartBulkQty.contentType, 'Authorization': `Bearer ${token}` },
      body: multipartBulkQty.body
    });
    assert(bulkQtyRes.status === 400, 'Uploading wholesale price without quantity is rejected (400 Bad Request)');
    const bulkQtyData = await bulkQtyRes.json() as any;
    assert(bulkQtyData.errors[0].error.includes('Wholesale Qty is required'), 'Reports missing quantity error message');

    // 9b. Test missing price rejection
    const invalidBulkPriceWb = XLSX.utils.book_new();
    const invalidBulkPriceWs = XLSX.utils.aoa_to_sheet([
      ['Barcode', 'Product Name', 'MRP', 'Sale Price', 'Wholesale Price', 'Wholesale Qty'],
      ['TEST_BULK_BAD_PRICE', 'Wholesale Missing Price', 100.00, 80.00, '', 5]
    ]);
    XLSX.utils.book_append_sheet(invalidBulkPriceWb, invalidBulkPriceWs, 'Catalog');
    const invalidBulkPriceBuf = XLSX.write(invalidBulkPriceWb, { type: 'buffer', bookType: 'xlsx' });
    const multipartBulkPrice = makeMultipartBody(invalidBulkPriceBuf, 'invalid_bulk_price.xlsx');
    const bulkPriceRes = await fetch(`${BASE_URL}/admin/upload`, {
      method: 'POST',
      headers: { 'Content-Type': multipartBulkPrice.contentType, 'Authorization': `Bearer ${token}` },
      body: multipartBulkPrice.body
    });
    assert(bulkPriceRes.status === 400, 'Uploading wholesale quantity without price is rejected (400 Bad Request)');
    const bulkPriceData = await bulkPriceRes.json() as any;
    assert(bulkPriceData.errors[0].error.includes('Wholesale Price is required'), 'Reports missing price error message');

    // 9c. Test Wholesale Price >= Sale Price rejection
    const bulkPriceGtSaleWb = XLSX.utils.book_new();
    const bulkPriceGtSaleWs = XLSX.utils.aoa_to_sheet([
      ['Barcode', 'Product Name', 'MRP', 'Sale Price', 'Wholesale Price', 'Wholesale Qty'],
      ['TEST_BULK_BAD_GT_SALE', 'Wholesale Price >= Sale Price', 100.00, 80.00, 85.00, 5]
    ]);
    XLSX.utils.book_append_sheet(bulkPriceGtSaleWb, bulkPriceGtSaleWs, 'Catalog');
    const bulkPriceGtSaleBuf = XLSX.write(bulkPriceGtSaleWb, { type: 'buffer', bookType: 'xlsx' });
    const multipartPriceGtSale = makeMultipartBody(bulkPriceGtSaleBuf, 'bulk_price_gt_sale.xlsx');
    const priceGtSaleRes = await fetch(`${BASE_URL}/admin/upload`, {
      method: 'POST',
      headers: { 'Content-Type': multipartPriceGtSale.contentType, 'Authorization': `Bearer ${token}` },
      body: multipartPriceGtSale.body
    });
    assert(priceGtSaleRes.status === 400, 'Uploading wholesale price >= sale price is rejected (400 Bad Request)');
    const priceGtSaleData = await priceGtSaleRes.json() as any;
    assert(priceGtSaleData.errors[0].error.includes('must be strictly less than Sale Price'), 'Reports price strictly less than sale price error');

    // 9d. Test Wholesale Qty < 2 rejection
    const bulkQtyLt2Wb = XLSX.utils.book_new();
    const bulkQtyLt2Ws = XLSX.utils.aoa_to_sheet([
      ['Barcode', 'Product Name', 'MRP', 'Sale Price', 'Wholesale Price', 'Wholesale Qty'],
      ['TEST_BULK_BAD_QTY_LT_2', 'Wholesale Qty < 2', 100.00, 80.00, 70.00, 1]
    ]);
    XLSX.utils.book_append_sheet(bulkQtyLt2Wb, bulkQtyLt2Ws, 'Catalog');
    const bulkQtyLt2Buf = XLSX.write(bulkQtyLt2Wb, { type: 'buffer', bookType: 'xlsx' });
    const multipartQtyLt2 = makeMultipartBody(bulkQtyLt2Buf, 'bulk_qty_lt_2.xlsx');
    const qtyLt2Res = await fetch(`${BASE_URL}/admin/upload`, {
      method: 'POST',
      headers: { 'Content-Type': multipartQtyLt2.contentType, 'Authorization': `Bearer ${token}` },
      body: multipartQtyLt2.body
    });
    assert(qtyLt2Res.status === 400, 'Uploading wholesale qty < 2 is rejected (400 Bad Request)');
    const qtyLt2Data = await qtyLt2Res.json() as any;
    assert(qtyLt2Data.errors[0].error.includes('Wholesale Qty must be 2 or more'), 'Reports quantity 2 or more error message');

    // 9e. Successful catalogue replacement with bulk offers
    const validBulkWb = XLSX.utils.book_new();
    const validBulkWs = XLSX.utils.aoa_to_sheet([
      ['Barcode', 'Product Name', 'MRP', 'Sale Price', 'Wholesale Price', 'Wholesale Qty'],
      ['TEST_BULK_X', 'Bulk Offer Product X', 100.00, 80.00, 70.00, 5],
      ['TEST_BULK_Y', 'Normal Product Y', 50.00, 40.00, '', '']
    ]);
    XLSX.utils.book_append_sheet(validBulkWb, validBulkWs, 'Catalog');
    const validBulkBuf = XLSX.write(validBulkWb, { type: 'buffer', bookType: 'xlsx' });
    const multipartValidBulk = makeMultipartBody(validBulkBuf, 'valid_bulk.xlsx');
    const validBulkRes = await fetch(`${BASE_URL}/admin/upload`, {
      method: 'POST',
      headers: { 'Content-Type': multipartValidBulk.contentType, 'Authorization': `Bearer ${token}` },
      body: multipartValidBulk.body
    });
    assert(validBulkRes.status === 200, 'Valid bulk catalog upload returns 200 OK');
    
    // Verify database persistence
    const dbBulkX = await db.get("SELECT barcode, name, sale_price, mrp, wholesale_price, wholesale_qty FROM products WHERE barcode = 'TEST_BULK_X'");
    assert(!!dbBulkX, 'Product with bulk offer was saved in database');
    assert(dbBulkX.wholesale_price === 70.00, 'Saved wholesale price matches input');
    assert(dbBulkX.wholesale_qty === 5, 'Saved wholesale quantity matches input');
    
    const dbBulkY = await db.get("SELECT barcode, name, sale_price, mrp, wholesale_price, wholesale_qty FROM products WHERE barcode = 'TEST_BULK_Y'");
    assert(!!dbBulkY, 'Product without bulk offer was saved in database');
    assert(dbBulkY.wholesale_price === null, 'Product without bulk offer has null wholesale price');
    assert(dbBulkY.wholesale_qty === null, 'Product without bulk offer has null wholesale quantity');

  } catch (err: any) {
    console.error('Fatal test execution error:', err);
    failed++;
  }

  // Clean up database products and upload logs
  console.log('\nCleaning up database test entries...');
  await db.run('DELETE FROM products WHERE barcode LIKE ?', 'TEST_%');
  await db.run("DELETE FROM products WHERE barcode = 'PRE_EXISTING'");
  await db.run('DELETE FROM upload_history WHERE filename LIKE ?', '%_rows.xlsx');
  await db.run("DELETE FROM upload_history WHERE filename = 'valid_catalog.xlsx'");
  await db.run("DELETE FROM upload_history WHERE filename = 'mixed_headers.xlsx'");
  await db.run("DELETE FROM upload_history WHERE filename = 'duplicate_row.xlsx'");
  await db.run("DELETE FROM upload_history WHERE filename LIKE ?", '%bulk%.xlsx');
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
