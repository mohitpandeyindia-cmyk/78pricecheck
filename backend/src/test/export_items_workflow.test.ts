import { getDb, closeDb, DB_PATH } from '../db';
import * as XLSX from 'xlsx';

const BASE_URL = 'http://localhost:8080/api';

async function runExportWorkflowTests() {
  console.log('================================================================');
  console.log('   RUNNING EXPORT ITEMS WORKFLOW & ACCEPTANCE TEST SUITE        ');
  console.log('================================================================\n');

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

  // Helper to create multipart form data
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
    // Helper to send requests with proxy header
    async function apiFetch(url: string, init: any = {}): Promise<any> {
      const headers = new Headers(init.headers || {});
      headers.set('x-forwarded-proto', 'https');
      return (globalThis as any).fetch(url, { ...init, headers });
    }

    // 0. Authenticate test admin user
    let token = '';
    const regRes = await apiFetch(`${BASE_URL}/admin/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'export_admin', password: 'password123' })
    });
    const loginRes = await apiFetch(`${BASE_URL}/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'export_admin', password: 'password123' })
    });
    if (loginRes.status === 200) {
      const loginData = await loginRes.json() as any;
      token = loginData.token;
    } else {
      const fbRes = await apiFetch(`${BASE_URL}/admin/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin2', password: 'password123' })
      });
      const fbData = await fbRes.json() as any;
      token = fbData.token;
    }
    assert(!!token, 'Obtained admin authorization token');

    // TEST 1: Export field extraction and column mapping
    console.log('\n[Test 1/17] Export field extraction and column mapping...');
    // Seed wholesale_quantities with a known item
    await db.run(
      `INSERT OR REPLACE INTO wholesale_quantities (original_name, normalized_name, wholesale_qty, last_modified_source)
       VALUES ('PARLE-G 250G', 'PARLE-G 250G', 5, 'TEST_SEED')`
    );

    const wb1 = XLSX.utils.book_new();
    const ws1 = XLSX.utils.aoa_to_sheet([
      ['Item name*', 'Item code', 'Category', 'HSN', 'WHOLESALE PRICE', 'Default Mrp', 'Sale price', 'Purchase price'],
      ['PARLE-G 250G', '8901719101010', 'BISCUITS', '1905', 22.50, 25.00, 24.00, 20.00],
      ['CHIPS 50G', '8901719102020', 'SNACKS', '1905', '', 10.00, 10.00, 8.00]
    ]);
    XLSX.utils.book_append_sheet(wb1, ws1, 'Export Items');
    const buf1 = XLSX.write(wb1, { type: 'buffer', bookType: 'xlsx' });

    const mp1 = makeMultipartBody(buf1, 'test_export_items.xlsx');
    const res1 = await apiFetch(`${BASE_URL}/admin/upload-export-items`, {
      method: 'POST',
      headers: { 'Content-Type': mp1.contentType, 'Authorization': `Bearer ${token}` },
      body: mp1.body
    });
    assert(res1.status === 200, 'Upload export items returns 200 OK');
    const data1 = await res1.json() as any;
    assert(data1.success === true, 'Upload response success flag is true');
    assert(data1.wholesaleItems.length === 1, 'Extracted exactly 1 wholesale item from 2 rows');
    const parle = data1.wholesaleItems[0];
    assert(parle.name === 'PARLE-G 250G', 'Item name extracted correctly');
    assert(parle.barcode === '8901719101010', 'Item code mapped to barcode');
    assert(parle.mrp === 25.00, 'Default Mrp mapped to MRP');
    assert(parle.salePrice === 24.00, 'Sale price mapped to salePrice (NOT confused with wholesale price)');
    assert(parle.wholesalePrice === 22.50, 'WHOLESALE PRICE mapped to wholesalePrice');
    assert(parle.wholesaleQty === 5, 'Retrieved wholesaleQty from repository');

    // TEST 2: Blank barcode removal
    console.log('\n[Test 2/17] Blank barcode removal...');
    const wb2 = XLSX.utils.book_new();
    const ws2 = XLSX.utils.aoa_to_sheet([
      ['Item name*', 'Item code', 'Default Mrp', 'Sale price', 'WHOLESALE PRICE'],
      ['VALID 1', '1111111111111', 10, 10, ''],
      ['BLANK CODE 1', '', 20, 20, ''],
      ['WHITESPACE CODE 2', '   ', 30, 30, ''],
      ['VALID 2', '2222222222222', 40, 40, '']
    ]);
    XLSX.utils.book_append_sheet(wb2, ws2, 'Export Items');
    const buf2 = XLSX.write(wb2, { type: 'buffer', bookType: 'xlsx' });
    const mp2 = makeMultipartBody(buf2, 'blank_barcodes.xlsx');
    const res2 = await apiFetch(`${BASE_URL}/admin/upload-export-items`, {
      method: 'POST',
      headers: { 'Content-Type': mp2.contentType, 'Authorization': `Bearer ${token}` },
      body: mp2.body
    });
    const data2 = await res2.json() as any;
    assert(data2.summary.blankBarcodesExcluded === 2, 'Excluded exactly 2 rows with blank/whitespace barcodes');
    assert(data2.summary.totalValidProducts === 2, 'Exactly 2 valid products retained');

    // TEST 3: Duplicate barcode detection & safe conflict resolution
    console.log('\n[Test 3/18] Duplicate barcode detection & safe conflict resolution...');
    const wb3 = XLSX.utils.book_new();
    const ws3 = XLSX.utils.aoa_to_sheet([
      ['Item name*', 'Item code', 'Default Mrp', 'Sale price', 'WHOLESALE PRICE'],
      ['ORIGINAL ITEM', '3333333333333', 50, 45, ''],
      ['ORIGINAL ITEM', '3333333333333', 50, 45, ''], // Exact identical duplicate -> auto consolidated
      ['CONFLICTING ITEM', '3333333333333', 60, 55, ''] // Conflicting duplicate -> requires admin resolution
    ]);
    XLSX.utils.book_append_sheet(wb3, ws3, 'Export Items');
    const buf3 = XLSX.write(wb3, { type: 'buffer', bookType: 'xlsx' });
    const mp3 = makeMultipartBody(buf3, 'duplicates.xlsx');
    const res3 = await apiFetch(`${BASE_URL}/admin/upload-export-items`, {
      method: 'POST',
      headers: { 'Content-Type': mp3.contentType, 'Authorization': `Bearer ${token}` },
      body: mp3.body
    });
    const data3 = await res3.json() as any;
    assert(data3.summary.duplicateBarcodesCount === 2, 'Detected 2 duplicate barcode rows');
    assert(Array.isArray(data3.duplicateConflicts) && data3.duplicateConflicts.length === 1, 'Flagged exactly 1 conflicting duplicate barcode group');
    assert(data3.duplicateConflicts[0].barcode === '3333333333333', 'Conflict barcode is 3333333333333');
    assert(data3.duplicateConflicts[0].status === 'PENDING', 'Conflict group status is PENDING');
    assert(data3.duplicateConflicts[0].candidates.length === 2, 'Conflict has 2 distinct candidates (identical duplicate consolidated)');

    // Verify publication is BLOCKED while duplicate conflict is unresolved
    const blockedPubRes = await apiFetch(`${BASE_URL}/admin/publish-catalogue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({
        sessionId: data3.sessionId,
        wholesaleUpdates: []
      })
    });
    assert(blockedPubRes.status === 400, 'Publishing blocked with 400 when duplicate conflicts are unresolved');
    const blockedPubData = await blockedPubRes.json() as any;
    const errText = blockedPubData.error || blockedPubData.message || '';
    assert(errText.includes('conflicting duplicate barcode'), 'Error explains unresolved duplicate conflicts');

    // Resolve conflict by selecting candidate 0 ('ORIGINAL ITEM')
    const resolvePubRes = await apiFetch(`${BASE_URL}/admin/publish-catalogue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({
        sessionId: data3.sessionId,
        wholesaleUpdates: [],
        duplicateResolutions: [
          { barcode: '3333333333333', action: 'SELECT', selectedIndex: 0 }
        ]
      })
    });
    assert(resolvePubRes.status === 200, 'Publishing succeeds when duplicate conflict is resolved');
    const resolvedPubData = await resolvePubRes.json() as any;
    assert(resolvedPubData.success === true, 'Catalogue published with resolved duplicate');

    // Verify the resolved product is published
    const checkProduct = await db.get('SELECT * FROM products WHERE barcode = ?', '3333333333333');
    assert(checkProduct && checkProduct.name === 'ORIGINAL ITEM' && checkProduct.sale_price === 45, 'Selected candidate product was published correctly');

    // Clean up test product
    await db.run('DELETE FROM products WHERE barcode = ?', '3333333333333');

    // TEST 4: Preservation of barcode strings and leading zeroes
    console.log('\n[Test 4/17] Preservation of barcode strings and leading zeroes...');
    const wb4 = XLSX.utils.book_new();
    const ws4 = XLSX.utils.aoa_to_sheet([
      ['Item name*', 'Item code', 'Default Mrp', 'Sale price', 'WHOLESALE PRICE'],
      ['LEADING ZERO ITEM', '0089012345678', 100, 90, 80]
    ]);
    XLSX.utils.book_append_sheet(wb4, ws4, 'Export Items');
    const buf4 = XLSX.write(wb4, { type: 'buffer', bookType: 'xlsx' });
    const mp4 = makeMultipartBody(buf4, 'leading_zeros.xlsx');
    const res4 = await apiFetch(`${BASE_URL}/admin/upload-export-items`, {
      method: 'POST',
      headers: { 'Content-Type': mp4.contentType, 'Authorization': `Bearer ${token}` },
      body: mp4.body
    });
    const data4 = await res4.json() as any;
    assert(data4.wholesaleItems[0].barcode === '0089012345678', 'Leading zeroes strictly preserved as string');

    // TEST 5: Wholesale product identification through Wholesale Price field
    console.log('\n[Test 5/17] Wholesale product identification...');
    const wb5 = XLSX.utils.book_new();
    const ws5 = XLSX.utils.aoa_to_sheet([
      ['Item name*', 'Item code', 'Default Mrp', 'Sale price', 'WHOLESALE PRICE'],
      ['RETAIL ONLY ITEM', '4444444444444', 50, 48, ''],
      ['ZERO WP ITEM', '5555555555555', 50, 48, 0],
      ['WHOLESALE ITEM', '6666666666666', 50, 48, 42]
    ]);
    XLSX.utils.book_append_sheet(wb5, ws5, 'Export Items');
    const buf5 = XLSX.write(wb5, { type: 'buffer', bookType: 'xlsx' });
    const mp5 = makeMultipartBody(buf5, 'wholesale_ident.xlsx');
    const res5 = await apiFetch(`${BASE_URL}/admin/upload-export-items`, {
      method: 'POST',
      headers: { 'Content-Type': mp5.contentType, 'Authorization': `Bearer ${token}` },
      body: mp5.body
    });
    const data5 = await res5.json() as any;
    assert(data5.summary.totalValidProducts === 3, 'All 3 rows recognized as valid products');
    assert(data5.summary.totalWholesaleProducts === 1, 'Only row with Wholesale Price > 0 identified as wholesale');
    assert(data5.wholesaleItems[0].barcode === '6666666666666', 'Correct wholesale item identified');

    // TEST 6: Exact normalized product-name WQ retrieval
    console.log('\n[Test 6/17] Exact normalized product-name WQ retrieval...');
    await db.run(
      `INSERT OR REPLACE INTO wholesale_quantities (original_name, normalized_name, wholesale_qty, last_modified_source)
       VALUES ('Amul Butter 500g', 'AMUL BUTTER 500G', 3, 'TEST_SEED')`
    );
    const wb6 = XLSX.utils.book_new();
    const ws6 = XLSX.utils.aoa_to_sheet([
      ['Item name*', 'Item code', 'Default Mrp', 'Sale price', 'WHOLESALE PRICE'],
      ['  amul   butter   500g  ', '7777777777777', 275, 270, 260] // Needs trimming and space normalization
    ]);
    XLSX.utils.book_append_sheet(wb6, ws6, 'Export Items');
    const buf6 = XLSX.write(wb6, { type: 'buffer', bookType: 'xlsx' });
    const mp6 = makeMultipartBody(buf6, 'normalized_match.xlsx');
    const res6 = await apiFetch(`${BASE_URL}/admin/upload-export-items`, {
      method: 'POST',
      headers: { 'Content-Type': mp6.contentType, 'Authorization': `Bearer ${token}` },
      body: mp6.body
    });
    const data6 = await res6.json() as any;
    assert(data6.wholesaleItems[0].status === 'MATCHED', 'Normalized match status is MATCHED');
    assert(data6.wholesaleItems[0].wholesaleQty === 3, 'Quantity 3 retrieved despite spacing and casing differences');

    // TEST 7: Correct separation of different pack sizes and variants
    console.log('\n[Test 7/17] Separation of different pack sizes and variants...');
    await db.run(
      `INSERT OR REPLACE INTO wholesale_quantities (original_name, normalized_name, wholesale_qty, last_modified_source)
       VALUES ('GOOD DAY 100 GM', 'GOOD DAY 100 GM', 2, 'TEST_SEED'),
              ('GOOD DAY 200 GM', 'GOOD DAY 200 GM', 4, 'TEST_SEED')`
    );
    const wb7 = XLSX.utils.book_new();
    const ws7 = XLSX.utils.aoa_to_sheet([
      ['Item name*', 'Item code', 'Default Mrp', 'Sale price', 'WHOLESALE PRICE'],
      ['GOOD DAY 100 GM', '8888888888881', 20, 18, 16],
      ['GOOD DAY 200 GM', '8888888888882', 40, 36, 32]
    ]);
    XLSX.utils.book_append_sheet(wb7, ws7, 'Export Items');
    const buf7 = XLSX.write(wb7, { type: 'buffer', bookType: 'xlsx' });
    const mp7 = makeMultipartBody(buf7, 'pack_sizes.xlsx');
    const res7 = await apiFetch(`${BASE_URL}/admin/upload-export-items`, {
      method: 'POST',
      headers: { 'Content-Type': mp7.contentType, 'Authorization': `Bearer ${token}` },
      body: mp7.body
    });
    const data7 = await res7.json() as any;
    const g100 = data7.wholesaleItems.find((w: any) => w.name === 'GOOD DAY 100 GM');
    const g200 = data7.wholesaleItems.find((w: any) => w.name === 'GOOD DAY 200 GM');
    assert(g100 && g100.wholesaleQty === 2, 'GOOD DAY 100 GM retrieved distinct quantity (2)');
    assert(g200 && g200.wholesaleQty === 4, 'GOOD DAY 200 GM retrieved distinct quantity (4)');

    // TEST 8: Ambiguous name match handling
    console.log('\n[Test 8/17] Ambiguous name match handling...');
    // Introduce ambiguous entry by temporarily modifying a record or simulating multiple conflicting quantities
    await db.run(
      `INSERT INTO wholesale_quantities (original_name, normalized_name, wholesale_qty, last_modified_source)
       VALUES ('AMBIGUOUS PRODUCT 1', 'AMBIGUOUS PRODUCT', 2, 'TEST_SEED'),
              ('AMBIGUOUS PRODUCT 2', 'AMBIGUOUS PRODUCT', 6, 'TEST_SEED')`
    );
    const wb8 = XLSX.utils.book_new();
    const ws8 = XLSX.utils.aoa_to_sheet([
      ['Item name*', 'Item code', 'Default Mrp', 'Sale price', 'WHOLESALE PRICE'],
      ['AMBIGUOUS PRODUCT', '9999999999999', 100, 95, 85]
    ]);
    XLSX.utils.book_append_sheet(wb8, ws8, 'Export Items');
    const buf8 = XLSX.write(wb8, { type: 'buffer', bookType: 'xlsx' });
    const mp8 = makeMultipartBody(buf8, 'ambiguous_match.xlsx');
    const res8 = await apiFetch(`${BASE_URL}/admin/upload-export-items`, {
      method: 'POST',
      headers: { 'Content-Type': mp8.contentType, 'Authorization': `Bearer ${token}` },
      body: mp8.body
    });
    const data8 = await res8.json() as any;
    assert(data8.wholesaleItems[0].status === 'AMBIGUOUS', 'Conflicting repository entries flagged as AMBIGUOUS');
    assert(data8.summary.ambiguousCount === 1, 'Ambiguous count reported in summary');

    // Clean up ambiguous test records
    await db.run(`DELETE FROM wholesale_quantities WHERE normalized_name = 'AMBIGUOUS PRODUCT'`);

    // TEST 9: Displaying missing WQ products above matched products
    console.log('\n[Test 9/17] Displaying missing WQ products above matched products...');
    await db.run("DELETE FROM wholesale_quantities WHERE normalized_name LIKE 'NEW UNKNOWN ITEM%' OR normalized_name LIKE 'MATCHED ITEM%'");
    const wb9 = XLSX.utils.book_new();
    const ws9 = XLSX.utils.aoa_to_sheet([
      ['Item name*', 'Item code', 'Default Mrp', 'Sale price', 'WHOLESALE PRICE'],
      ['MATCHED ITEM A', '9000000000001', 50, 45, 40], // Will match below
      ['NEW UNKNOWN ITEM B', '9000000000002', 50, 45, 40], // Missing WQ
      ['MATCHED ITEM C', '9000000000003', 50, 45, 40] // Will match below
    ]);
    await db.run(
      `INSERT OR REPLACE INTO wholesale_quantities (original_name, normalized_name, wholesale_qty, last_modified_source)
       VALUES ('MATCHED ITEM A', 'MATCHED ITEM A', 2, 'TEST_SEED'),
              ('MATCHED ITEM C', 'MATCHED ITEM C', 3, 'TEST_SEED')`
    );
    XLSX.utils.book_append_sheet(wb9, ws9, 'Export Items');
    const buf9 = XLSX.write(wb9, { type: 'buffer', bookType: 'xlsx' });
    const mp9 = makeMultipartBody(buf9, 'sorting_test.xlsx');
    const res9 = await apiFetch(`${BASE_URL}/admin/upload-export-items`, {
      method: 'POST',
      headers: { 'Content-Type': mp9.contentType, 'Authorization': `Bearer ${token}` },
      body: mp9.body
    });
    const data9 = await res9.json() as any;
    assert(data9.wholesaleItems[0].name === 'NEW UNKNOWN ITEM B', 'Missing WQ item sorted to the very top (Index 0)');
    assert(data9.wholesaleItems[0].status === 'REQUIRED', 'Missing WQ item has status REQUIRED');
    assert(data9.wholesaleItems[1].status === 'MATCHED', 'Subsequent items are MATCHED');

    // TEST 10 & 11: Entering new WQ values & editing existing WQ values
    console.log('\n[Test 10 & 11/19] Entering new WQ and editing existing WQ...');
    const sessionId = data9.sessionId;
    const pubRes = await apiFetch(`${BASE_URL}/admin/publish-catalogue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({
        sessionId,
        wholesaleUpdates: [
          { originalName: 'NEW UNKNOWN ITEM B', normalizedName: 'NEW UNKNOWN ITEM B', wholesaleQty: 6 }, // New entered
          { originalName: 'MATCHED ITEM A', normalizedName: 'MATCHED ITEM A', wholesaleQty: 10 } // Edited from 2 to 10
        ]
      })
    });
    assert(pubRes.status === 200, 'Publishing catalogue with resolved WQs returns 200 OK');
    const pubData = await pubRes.json() as any;
    assert(pubData.success === true, 'Catalogue published successfully');
    assert(pubData.totalProducts === 3, 'All 3 products published');
    assert(pubData.wholesaleSaved === 2, 'Exactly 2 wholesale quantities saved/updated in repository');

    // TEST 10B: Wholesale Quantity Validation (positive whole number >= 1)
    console.log('\n[Test 10B/19] Wholesale Quantity Validation (accept >= 1, reject 0, negative, floats)...');
    // Upload a test item needing WQ
    const wb10b = XLSX.utils.book_new();
    const ws10b = XLSX.utils.aoa_to_sheet([
      ['Item name*', 'Item code', 'Default Mrp', 'Sale price', 'WHOLESALE PRICE'],
      ['MIN WQ ITEM', '9000000000099', 50, 45, 40]
    ]);
    XLSX.utils.book_append_sheet(wb10b, ws10b, 'Export Items');
    const buf10b = XLSX.write(wb10b, { type: 'buffer', bookType: 'xlsx' });
    const mp10b = makeMultipartBody(buf10b, 'min_wq_test.xlsx');
    const res10b = await apiFetch(`${BASE_URL}/admin/upload-export-items`, {
      method: 'POST',
      headers: { 'Content-Type': mp10b.contentType, 'Authorization': `Bearer ${token}` },
      body: mp10b.body
    });
    const data10b = await res10b.json() as any;

    // Test rejection of WQ = 0
    const zeroRes = await apiFetch(`${BASE_URL}/admin/publish-catalogue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({
        sessionId: data10b.sessionId,
        wholesaleUpdates: [{ originalName: 'MIN WQ ITEM', normalizedName: 'MIN WQ ITEM', wholesaleQty: 0 }]
      })
    });
    assert(zeroRes.status === 400, 'Zero quantity (0) rejected with 400 Bad Request');

    // Test rejection of negative WQ (-1)
    const negRes = await apiFetch(`${BASE_URL}/admin/publish-catalogue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({
        sessionId: data10b.sessionId,
        wholesaleUpdates: [{ originalName: 'MIN WQ ITEM', normalizedName: 'MIN WQ ITEM', wholesaleQty: -1 }]
      })
    });
    assert(negRes.status === 400, 'Negative quantity (-1) rejected with 400 Bad Request');

    // Test rejection of float WQ (1.5)
    const floatRes = await apiFetch(`${BASE_URL}/admin/publish-catalogue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({
        sessionId: data10b.sessionId,
        wholesaleUpdates: [{ originalName: 'MIN WQ ITEM', normalizedName: 'MIN WQ ITEM', wholesaleQty: 1.5 }]
      })
    });
    assert(floatRes.status === 400, 'Non-integer quantity (1.5) rejected with 400 Bad Request');

    // Test acceptance of minimum positive integer quantity (WQ = 1)
    const oneRes = await apiFetch(`${BASE_URL}/admin/publish-catalogue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({
        sessionId: data10b.sessionId,
        wholesaleUpdates: [{ originalName: 'MIN WQ ITEM', normalizedName: 'MIN WQ ITEM', wholesaleQty: 1 }]
      })
    });
    assert(oneRes.status === 200, 'Minimum quantity 1 accepted successfully');
    const oneProduct = await db.get('SELECT * FROM products WHERE barcode = ?', '9000000000099');
    assert(oneProduct && oneProduct.wholesale_qty === 1, 'Product published with wholesale_qty = 1');
    await db.run('DELETE FROM products WHERE barcode = ?', '9000000000099');
    await db.run('DELETE FROM wholesale_quantities WHERE normalized_name = ?', 'MIN WQ ITEM');

    // TEST 12: Verifying saved WQ values are retrieved on subsequent upload
    console.log('\n[Test 12/17] Verifying saved WQs retrieved on subsequent upload...');
    const res12 = await apiFetch(`${BASE_URL}/admin/upload-export-items`, {
      method: 'POST',
      headers: { 'Content-Type': mp9.contentType, 'Authorization': `Bearer ${token}` },
      body: mp9.body
    });
    const data12 = await res12.json() as any;
    const newB = data12.wholesaleItems.find((w: any) => w.name === 'NEW UNKNOWN ITEM B');
    const editA = data12.wholesaleItems.find((w: any) => w.name === 'MATCHED ITEM A');
    assert(newB && newB.status === 'MATCHED' && newB.wholesaleQty === 6, 'Newly saved quantity (6) automatically retrieved on next upload');
    assert(editA && editA.status === 'MATCHED' && editA.wholesaleQty === 10, 'Edited quantity (10) automatically retrieved on next upload');

    // TEST 13: Correct final six-column compilation preview
    console.log('\n[Test 13/17] Correct final six-column compilation preview download...');
    const previewRes = await apiFetch(`${BASE_URL}/admin/export-compiled-catalogue/${data12.sessionId}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    assert(previewRes.status === 200, 'Download compiled catalogue returns 200 OK');
    const previewBuf = Buffer.from(await previewRes.arrayBuffer());
    const previewWb = XLSX.read(previewBuf, { type: 'buffer' });
    const previewWs = previewWb.Sheets[previewWb.SheetNames[0]];
    const previewRows = XLSX.utils.sheet_to_json(previewWs, { header: 1 }) as any[][];
    assert(
      previewRows[0][0] === 'Barcode' &&
      previewRows[0][1] === 'Product Name' &&
      previewRows[0][2] === 'MRP' &&
      previewRows[0][3] === 'Sale Price' &&
      previewRows[0][4] === 'Wholesale Price' &&
      previewRows[0][5] === 'Wholesale Qty',
      'Preview columns match exact 6-column specification'
    );

    // TEST 14: Atomic catalogue update and rollback on failure
    console.log('\n[Test 14/17] Atomic catalogue update and rollback on failure...');
    // Attempt to publish a session with missing required WQ
    const wb14 = XLSX.utils.book_new();
    const ws14 = XLSX.utils.aoa_to_sheet([
      ['Item name*', 'Item code', 'Default Mrp', 'Sale price', 'WHOLESALE PRICE'],
      ['UNRESOLVED ITEM', '9999999999001', 50, 45, 40]
    ]);
    XLSX.utils.book_append_sheet(wb14, ws14, 'Export Items');
    const buf14 = XLSX.write(wb14, { type: 'buffer', bookType: 'xlsx' });
    const mp14 = makeMultipartBody(buf14, 'rollback_test.xlsx');
    const res14 = await apiFetch(`${BASE_URL}/admin/upload-export-items`, {
      method: 'POST',
      headers: { 'Content-Type': mp14.contentType, 'Authorization': `Bearer ${token}` },
      body: mp14.body
    });
    const data14 = await res14.json() as any;
    const initialCount = (await db.get('SELECT COUNT(*) as cnt FROM products')).cnt;

    const failPubRes = await apiFetch(`${BASE_URL}/admin/publish-catalogue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({
        sessionId: data14.sessionId,
        wholesaleUpdates: [] // Empty updates, so UNRESOLVED ITEM remains unresolved
      })
    });
    assert(failPubRes.status === 400, 'Publishing with unresolved items rejected with 400 Bad Request');
    const afterCount = (await db.get('SELECT COUNT(*) as cnt FROM products')).cnt;
    assert(afterCount === initialCount, 'Database products catalogue completely untouched (Atomic Rollback)');

    // TEST 15: Upload history displayed with all 11 required metrics
    console.log('\n[Test 15/17] Upload history inline data contains all required audit metrics...');
    const histRes = await apiFetch(`${BASE_URL}/admin/upload-history`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    assert(histRes.status === 200, 'GET /admin/upload-history returns 200 OK');
    const histData = await histRes.json() as any[];
    assert(histData.length > 0, 'History contains records');
    const latest = histData[0];
    assert(latest.uploadedAt !== undefined, 'Upload date and time present');
    assert(latest.filename !== undefined, 'Original filename present');
    assert(latest.status !== undefined, 'Import status present');
    assert(latest.totalRows !== undefined, 'Total source rows present');
    assert(latest.successfulRows !== undefined, 'Valid product rows / products imported present');
    assert(latest.blankBarcodes !== undefined, 'Rows excluded because of blank barcodes present');
    assert(latest.duplicateBarcodes !== undefined, 'Duplicate barcode count present');
    assert(latest.wholesaleProducts !== undefined, 'Total wholesale products present');
    assert(latest.wholesaleMatched !== undefined, 'Wholesale products matched present');
    assert(latest.wholesaleManual !== undefined, 'Wholesale quantities manual input present');
    assert(latest.processingTimeMs !== undefined, 'Processing duration present');

    // TEST 16: Navigation check & /admin/history redirect
    console.log('\n[Test 16/17] Confirming separate Upload History navigation redirect...');
    const redirectRes = await apiFetch('http://localhost:8080/admin/history', { redirect: 'manual' });
    assert(redirectRes.status === 301, 'GET /admin/history returns 301 Redirect to /admin/upload');
    assert(redirectRes.headers.get('location') === '/admin/upload', 'Redirect points directly to /admin/upload');

    // TEST 17: Wholesale Information Access Control
    console.log('\n[Test 17/19] Wholesale Information Access Control (Customer vs Admin)...');
    // Ensure product exists for lookup
    await db.run(
      `INSERT OR REPLACE INTO products (barcode, name, sale_price, mrp, wholesale_price, wholesale_qty)
       VALUES ('9000000000002', 'NEW UNKNOWN ITEM B', 45.00, 50.00, 40.00, 6)`
    );

    // Public customer lookup (unauthenticated): Wholesale info strictly omitted
    const customerLookupRes = await apiFetch(`${BASE_URL}/products/lookup/9000000000002`);
    assert(customerLookupRes.status === 200, 'Customer lookup returns 200 OK');
    const customerData = await customerLookupRes.json() as any;
    assert(customerData.products[0].name === 'NEW UNKNOWN ITEM B', 'Product name returned');
    assert(customerData.products[0].salePrice === 45, 'Sale price returned');
    assert(customerData.products[0].mrp === 50, 'MRP returned');
    assert(customerData.products[0].wholesalePrice === undefined, 'Customer lookup strictly omits wholesalePrice');
    assert(customerData.products[0].wholesaleQty === undefined, 'Customer lookup strictly omits wholesaleQty');

    // Customer search endpoint: Wholesale info strictly omitted
    const customerSearchRes = await apiFetch(`${BASE_URL}/products/search?q=UNKNOWN`);
    assert(customerSearchRes.status === 200, 'Customer search returns 200 OK');
    const searchData = await customerSearchRes.json() as any;
    const searchItems = Array.isArray(searchData) ? searchData : searchData.products;
    assert(searchItems.length > 0, 'Search returns products');
    assert(searchItems[0].wholesalePrice === undefined, 'Search results strictly omit wholesalePrice');
    assert(searchItems[0].wholesaleQty === undefined, 'Search results strictly omit wholesaleQty');

    // Admin lookup (authenticated): Wholesale info preserved
    const adminLookupRes = await apiFetch(`${BASE_URL}/products/lookup/9000000000002`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    assert(adminLookupRes.status === 200, 'Admin lookup returns 200 OK');
    const adminData = await adminLookupRes.json() as any;
    assert(adminData.products[0].wholesalePrice === 40, 'Admin lookup returns authorized wholesalePrice');
    assert(adminData.products[0].wholesaleQty === 6, 'Admin lookup returns authorized wholesaleQty');

    // TEST 18: Development Database Reconnection & Persistence Across Connection Cycle
    console.log('\n[Test 18/19] Development Database Reconnection & Persistence (Local Dev Environment)...');
    console.log(`  ℹ️ Verified development SQLite database path: ${DB_PATH}`);
    console.log('  ℹ️ Note: This verifies development engine reconnection and schema integrity; production persistence is verified separately.');
    assert(typeof DB_PATH === 'string' && DB_PATH.length > 0, 'DB_PATH is defined and non-empty');
    
    // Test persistent wholesale quantity survival across DB connection close & re-open
    await closeDb(); // Close current connection and reset instance
    const reopenedDb = await getDb(); // Re-open connection
    const persistentWq = await reopenedDb.get(
      'SELECT wholesale_qty FROM wholesale_quantities WHERE normalized_name = ?',
      'NEW UNKNOWN ITEM B'
    );
    assert(persistentWq && persistentWq.wholesale_qty === 6, 'Development wholesale quantity survived reconnection cycle with value 6');
    const persistentProd = await reopenedDb.get(
      'SELECT name FROM products WHERE barcode = ?',
      '9000000000002'
    );
    assert(persistentProd && persistentProd.name === 'NEW UNKNOWN ITEM B', 'Development product catalogue survived reconnection cycle');
    await closeDb();

    console.log('\n================================================================');
    console.log(`   TEST EXECUTION COMPLETED: ${passed} PASSED, ${failed} FAILED`);
    console.log('================================================================\n');

    if (failed > 0) {
      process.exit(1);
    }
  } catch (err) {
    console.error('Fatal error during test execution:', err);
    process.exit(1);
  }
}

runExportWorkflowTests();
