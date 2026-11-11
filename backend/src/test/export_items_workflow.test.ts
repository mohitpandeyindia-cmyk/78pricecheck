import { getDb, closeDb, DB_PATH, normalizeProductName } from '../db';
import { parseStockDetailBuffer } from '../services/stockDetailParser';
import * as XLSX from 'xlsx';
import fs from 'fs';

const BASE_URL = 'http://localhost:8080/api';

async function runExportWorkflowTests() {
  console.log('================================================================');
  console.log('   RUNNING DUAL-FILE CATALOGUE IMPORT & RECONCILIATION SUITE    ');
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

  // Helper to create dual multipart form data
  function makeDualMultipartBody(
    exportBuffer?: Buffer,
    exportFilename = 'export_items.xlsx',
    stockBuffer?: Buffer,
    stockFilename = 'stock_detail.xls'
  ) {
    const boundary = '----TestBoundary' + Math.random().toString(36).substring(2);
    const bodyParts: Buffer[] = [];

    if (exportBuffer) {
      bodyParts.push(Buffer.from(`--${boundary}\r\n`));
      bodyParts.push(Buffer.from(`Content-Disposition: form-data; name="exportItems"; filename="${exportFilename}"\r\n`));
      bodyParts.push(Buffer.from(`Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n`));
      bodyParts.push(exportBuffer);
      bodyParts.push(Buffer.from(`\r\n`));
    }

    if (stockBuffer) {
      bodyParts.push(Buffer.from(`--${boundary}\r\n`));
      bodyParts.push(Buffer.from(`Content-Disposition: form-data; name="stockDetail"; filename="${stockFilename}"\r\n`));
      bodyParts.push(Buffer.from(`Content-Type: application/vnd.ms-excel\r\n\r\n`));
      bodyParts.push(stockBuffer);
      bodyParts.push(Buffer.from(`\r\n`));
    }

    bodyParts.push(Buffer.from(`--${boundary}--\r\n`));

    return {
      contentType: `multipart/form-data; boundary=${boundary}`,
      body: Buffer.concat(bodyParts)
    };
  }

  // Helper to send requests with proxy header
  async function apiFetch(url: string, init: any = {}): Promise<any> {
    const headers = new Headers(init.headers || {});
    headers.set('x-forwarded-proto', 'https');
    return (globalThis as any).fetch(url, { ...init, headers });
  }

  try {
    // 0. Authenticate test admin user
    let token = '';
    await apiFetch(`${BASE_URL}/admin/register`, {
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

    // Helper to generate a Stock Detail Report workbook
    function createStockReportBuffer(
      items: Array<{ slNo?: any; name: string; closingQty?: any }>,
      bookType: 'biff8' | 'xlsx' = 'biff8',
      headerRow = 2
    ): Buffer {
      const data: any[][] = [];
      // Leading title rows before header
      for (let r = 0; r < headerRow; r++) {
        if (r === 0) data.push(['Generated Stock Detail Report Test']);
        else data.push([]);
      }
      data.push(['SL No.', 'Item Name', 'Opening Quantity', 'Quantity In', 'Quantity Out', 'Closing Quantity']);
      data.push([]); // blank separator row
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        data.push([
          item.slNo !== undefined ? item.slNo : (i + 1),
          item.name,
          '10.00',
          '5.00',
          '2.00',
          String(item.closingQty !== undefined ? item.closingQty : '13.00')
        ]);
      }
      // Add summary footer row
      data.push([]);
      data.push([null, 'Total', '100.00', '50.00', '20.00', '130.00']);

      const wb = XLSX.utils.book_new();
      const ws = XLSX.utils.aoa_to_sheet(data);
      XLSX.utils.book_append_sheet(wb, ws, 'Stock Detail Report');
      return XLSX.write(wb, { type: 'buffer', bookType });
    }

    // Helper to generate an Export Items workbook
    function createExportItemsBuffer(
      items: Array<{ name: string; barcode: string; mrp?: number; salePrice?: number; wholesalePrice?: any }>
    ): Buffer {
      const data: any[][] = [
        ['Item name*', 'Item code', 'Category', 'Default Mrp', 'Sale price', 'WHOLESALE PRICE']
      ];
      for (const item of items) {
        data.push([
          item.name,
          item.barcode,
          'GENERAL',
          item.mrp !== undefined ? item.mrp : 20.0,
          item.salePrice !== undefined ? item.salePrice : 18.0,
          item.wholesalePrice !== undefined ? item.wholesalePrice : ''
        ]);
      }
      const wb = XLSX.utils.book_new();
      const ws = XLSX.utils.aoa_to_sheet(data);
      XLSX.utils.book_append_sheet(wb, ws, 'Export Items');
      return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    }

    // Seed wholesale repository for test item
    await db.run(
      `INSERT OR REPLACE INTO wholesale_quantities (original_name, normalized_name, wholesale_qty, last_modified_source)
       VALUES ('PARLE-G 250G', 'PARLE-G 250G', 6, 'TEST_SEED')`
    );

    // =========================================================================
    // SCENARIO 1: Uploading both required files together
    // =========================================================================
    console.log('\n[Scenario 1/25] Uploading both required files together...');
    const expBuf1 = createExportItemsBuffer([
      { name: 'PARLE-G 250G', barcode: '8901719101010', mrp: 25.0, salePrice: 24.0, wholesalePrice: 22.0 },
      { name: 'CHIPS 50G', barcode: '8901719102020', mrp: 10.0, salePrice: 10.0 }
    ]);
    const stockBuf1 = createStockReportBuffer([
      { name: 'PARLE-G 250G', closingQty: 25 },
      { name: 'CHIPS 50G', closingQty: 10 }
    ]);
    const mp1 = makeDualMultipartBody(expBuf1, 'export1.xlsx', stockBuf1, 'stock1.xls');
    const res1 = await apiFetch(`${BASE_URL}/admin/upload-export-items`, {
      method: 'POST',
      headers: { 'Content-Type': mp1.contentType, 'Authorization': `Bearer ${token}` },
      body: mp1.body
    });
    assert(res1.status === 200, 'Dual-file upload returns HTTP 200 OK');
    const data1 = await res1.json();
    assert(data1.success === true, 'Upload response success flag is true');
    assert(!!data1.sessionId, 'Staging session ID generated');
    assert(data1.summary.activeProductCount === 2, 'Both products classified as ACTIVE');
    assert(data1.summary.inactiveProductCount === 0, '0 inactive products');

    // =========================================================================
    // SCENARIO 2: Rejecting an upload when either file is missing
    // =========================================================================
    console.log('\n[Scenario 2/25] Rejecting an upload when either file is missing...');
    // 2a. Missing Stock Detail
    const mp2a = makeDualMultipartBody(expBuf1, 'export2a.xlsx', undefined, undefined);
    const res2a = await apiFetch(`${BASE_URL}/admin/upload-export-items`, {
      method: 'POST',
      headers: { 'Content-Type': mp2a.contentType, 'Authorization': `Bearer ${token}` },
      body: mp2a.body
    });
    assert(res2a.status === 400, 'Missing Stock Detail returns HTTP 400 Bad Request');
    const err2a = await res2a.json();
    assert(err2a.message.includes('Stock Detail Report file is required'), 'Returns descriptive Stock Detail error');

    // 2b. Missing Export Items
    const mp2b = makeDualMultipartBody(undefined, undefined, stockBuf1, 'stock2b.xls');
    const res2b = await apiFetch(`${BASE_URL}/admin/upload-export-items`, {
      method: 'POST',
      headers: { 'Content-Type': mp2b.contentType, 'Authorization': `Bearer ${token}` },
      body: mp2b.body
    });
    assert(res2b.status === 400, 'Missing Export Items returns HTTP 400 Bad Request');
    const err2b = await res2b.json();
    assert(err2b.message.includes('Export Items file is required'), 'Returns descriptive Export Items error');

    // =========================================================================
    // SCENARIO 3: Parsing legacy .xls Stock Detail Report
    // =========================================================================
    console.log('\n[Scenario 3/25] Parsing legacy .xls Stock Detail Report...');
    const xlsBuf = createStockReportBuffer([
      { name: 'ITEM XLS 1', closingQty: 5 },
      { name: 'ITEM XLS 2', closingQty: 12 }
    ], 'biff8');
    const parsedXls = parseStockDetailBuffer(xlsBuf);
    assert(parsedXls.namedRowCount === 2, 'Parsed 2 rows from legacy .xls buffer');
    assert(parsedXls.uniqueNames.has('ITEM XLS 1') && parsedXls.uniqueNames.has('ITEM XLS 2'), 'Extracted both normalized item names');

    // =========================================================================
    // SCENARIO 4: Parsing .xlsx Stock Detail Report
    // =========================================================================
    console.log('\n[Scenario 4/25] Parsing .xlsx Stock Detail Report...');
    const xlsxBuf = createStockReportBuffer([
      { name: 'ITEM XLSX 1', closingQty: 8 },
      { name: 'ITEM XLSX 2', closingQty: 15 }
    ], 'xlsx');
    const parsedXlsx = parseStockDetailBuffer(xlsxBuf);
    assert(parsedXlsx.namedRowCount === 2, 'Parsed 2 rows from modern .xlsx buffer');
    assert(parsedXlsx.uniqueNames.has('ITEM XLSX 1') && parsedXlsx.uniqueNames.has('ITEM XLSX 2'), 'Extracted both normalized item names');

    // =========================================================================
    // SCENARIO 5: Detecting the Item Name header when it is not the first row
    // =========================================================================
    console.log('\n[Scenario 5/25] Detecting Item Name header when not on first row...');
    const deepHeaderBuf = createStockReportBuffer([
      { name: 'DEEP HEADER ITEM', closingQty: 20 }
    ], 'biff8', 5); // Header positioned at row 5
    const parsedDeep = parseStockDetailBuffer(deepHeaderBuf);
    assert(parsedDeep.uniqueNames.has('DEEP HEADER ITEM'), 'Successfully detected header on row 5 and parsed item');

    // =========================================================================
    // SCENARIO 6: Extracting item names while skipping blank rows and ignoring summary footer
    // =========================================================================
    console.log('\n[Scenario 6/25] Extracting item names while skipping blank rows & footer...');
    const footerBuf = createStockReportBuffer([
      { name: 'VALID PRODUCT', closingQty: 10 }
    ], 'biff8', 2);
    const parsedFooter = parseStockDetailBuffer(footerBuf);
    assert(!parsedFooter.uniqueNames.has('TOTAL'), 'Footer row "Total" was excluded from unique item names');
    assert(parsedFooter.uniqueNames.size === 1, 'Only genuine product was retained');

    // =========================================================================
    // SCENARIO 7: Matching names with case differences
    // =========================================================================
    console.log('\n[Scenario 7/25] Matching names with case differences...');
    const expBuf7 = createExportItemsBuffer([
      { name: 'taj mahal tea 250g', barcode: '8901030383838' }
    ]);
    const stockBuf7 = createStockReportBuffer([
      { name: 'TAJ MAHAL TEA 250G', closingQty: 15 }
    ]);
    const mp7 = makeDualMultipartBody(expBuf7, 'case_exp.xlsx', stockBuf7, 'case_stock.xls');
    const res7 = await apiFetch(`${BASE_URL}/admin/upload-export-items`, {
      method: 'POST',
      headers: { 'Content-Type': mp7.contentType, 'Authorization': `Bearer ${token}` },
      body: mp7.body
    });
    const data7 = await res7.json();
    assert(data7.summary.activeProductCount === 1, 'Lower-case Export Items matched upper-case Stock Detail Report');

    // =========================================================================
    // SCENARIO 8: Matching names with harmless whitespace differences
    // =========================================================================
    console.log('\n[Scenario 8/25] Matching names with harmless whitespace differences...');
    const expBuf8 = createExportItemsBuffer([
      { name: 'CADBURY   DAIRY\u00A0MILK  100G', barcode: '8901233020202' }
    ]);
    const stockBuf8 = createStockReportBuffer([
      { name: 'CADBURY DAIRY MILK 100G', closingQty: 30 }
    ]);
    const mp8 = makeDualMultipartBody(expBuf8, 'space_exp.xlsx', stockBuf8, 'space_stock.xls');
    const res8 = await apiFetch(`${BASE_URL}/admin/upload-export-items`, {
      method: 'POST',
      headers: { 'Content-Type': mp8.contentType, 'Authorization': `Bearer ${token}` },
      body: mp8.body
    });
    const data8 = await res8.json();
    assert(data8.summary.activeProductCount === 1, 'Non-breaking & repeated whitespace normalized and matched exactly');

    // =========================================================================
    // SCENARIO 9: Preserving N/NN/NNN suffix differences
    // =========================================================================
    console.log('\n[Scenario 9/25] Preserving N/NN/NNN suffix differences...');
    const expBuf9 = createExportItemsBuffer([
      { name: 'LUX ROSE 100G N', barcode: '8901030000011' },
      { name: 'LUX ROSE 100G', barcode: '8901030000022' }
    ]);
    const stockBuf9 = createStockReportBuffer([
      { name: 'LUX ROSE 100G', closingQty: 10 } // Only base name in stock report, 'N' variant absent
    ]);
    const mp9 = makeDualMultipartBody(expBuf9, 'suffix_exp.xlsx', stockBuf9, 'suffix_stock.xls');
    const res9 = await apiFetch(`${BASE_URL}/admin/upload-export-items`, {
      method: 'POST',
      headers: { 'Content-Type': mp9.contentType, 'Authorization': `Bearer ${token}` },
      body: mp9.body
    });
    const data9 = await res9.json();
    assert(data9.summary.activeProductCount === 1, 'Base name matched; N suffix variant not cross-matched');
    assert(data9.summary.inactiveProductCount === 1, 'N variant properly classified as INACTIVE');

    // =========================================================================
    // SCENARIO 10: Preserving different pack sizes and variants
    // =========================================================================
    console.log('\n[Scenario 10/25] Preserving different pack sizes and variants...');
    const expBuf10 = createExportItemsBuffer([
      { name: 'AMUL BUTTER 100G', barcode: '8901262010101' },
      { name: 'AMUL BUTTER 500G', barcode: '8901262050505' }
    ]);
    const stockBuf10 = createStockReportBuffer([
      { name: 'AMUL BUTTER 100G', closingQty: 25 }
    ]);
    const mp10 = makeDualMultipartBody(expBuf10, 'size_exp.xlsx', stockBuf10, 'size_stock.xls');
    const res10 = await apiFetch(`${BASE_URL}/admin/upload-export-items`, {
      method: 'POST',
      headers: { 'Content-Type': mp10.contentType, 'Authorization': `Bearer ${token}` },
      body: mp10.body
    });
    const data10 = await res10.json();
    assert(data10.summary.activeProductCount === 1, '100G variant is ACTIVE');
    assert(data10.summary.inactiveProductCount === 1, '500G variant is INACTIVE');

    // =========================================================================
    // SCENARIO 11: Excluding items absent from Stock Detail
    // =========================================================================
    console.log('\n[Scenario 11/25] Excluding items absent from Stock Detail...');
    const expBuf11 = createExportItemsBuffer([
      { name: 'INACTIVE ITEM 1', barcode: '9999999000001', mrp: 50, salePrice: 45, wholesalePrice: 40 }
    ]);
    const stockBuf11 = createStockReportBuffer([
      { name: 'OTHER ACTIVE ITEM', closingQty: 10 }
    ]);
    const mp11 = makeDualMultipartBody(expBuf11, 'absent_exp.xlsx', stockBuf11, 'absent_stock.xls');
    const res11 = await apiFetch(`${BASE_URL}/admin/upload-export-items`, {
      method: 'POST',
      headers: { 'Content-Type': mp11.contentType, 'Authorization': `Bearer ${token}` },
      body: mp11.body
    });
    const data11 = await res11.json();
    assert(data11.summary.activeProductCount === 0, 'Absent item excluded from active products');
    assert(data11.summary.inactiveProductCount === 1, 'Absent item listed in inactive products');
    assert(data11.inactiveProducts[0].reason === 'NOT FOUND IN STOCK DETAIL REPORT', 'Exclusion reason matches specification');

    // =========================================================================
    // SCENARIO 12: Retaining products present with Closing Quantity = 0
    // =========================================================================
    console.log('\n[Scenario 12/25] Retaining products present with Closing Quantity = 0...');
    const expBuf12 = createExportItemsBuffer([
      { name: 'ZERO STOCK ACTIVE ITEM', barcode: '8900000000012' }
    ]);
    const stockBuf12 = createStockReportBuffer([
      { name: 'ZERO STOCK ACTIVE ITEM', closingQty: 0 } // Closing balance is exactly 0
    ]);
    const mp12 = makeDualMultipartBody(expBuf12, 'zero_exp.xlsx', stockBuf12, 'zero_stock.xls');
    const res12 = await apiFetch(`${BASE_URL}/admin/upload-export-items`, {
      method: 'POST',
      headers: { 'Content-Type': mp12.contentType, 'Authorization': `Bearer ${token}` },
      body: mp12.body
    });
    const data12 = await res12.json();
    assert(data12.summary.activeProductCount === 1, 'Product with Closing Quantity = 0 remains ACTIVE');

    // =========================================================================
    // SCENARIO 13: Ignoring duplicate Stock Detail names for membership matching
    // =========================================================================
    console.log('\n[Scenario 13/25] Ignoring duplicate Stock Detail names for membership matching...');
    const expBuf13 = createExportItemsBuffer([
      { name: 'HR BOONDI 200G', barcode: '8904004400101' }
    ]);
    const stockBuf13 = createStockReportBuffer([
      { name: 'HR BOONDI 200G', closingQty: 5 },
      { name: 'HR BOONDI 200G', closingQty: 8 } // Repeated in stock detail
    ]);
    const mp13 = makeDualMultipartBody(expBuf13, 'dup_stock_exp.xlsx', stockBuf13, 'dup_stock.xls');
    const res13 = await apiFetch(`${BASE_URL}/admin/upload-export-items`, {
      method: 'POST',
      headers: { 'Content-Type': mp13.contentType, 'Authorization': `Bearer ${token}` },
      body: mp13.body
    });
    const data13 = await res13.json();
    assert(data13.summary.activeProductCount === 1, 'Repeated name matched cleanly once');
    assert(data13.summary.stockDetailUniqueNames === 1, 'Unique Stock Detail count deduplicates repeated rows');

    // =========================================================================
    // SCENARIO 14: Ensuring Stock Detail-only items are not added
    // =========================================================================
    console.log('\n[Scenario 14/25] Ensuring Stock Detail-only items are not added...');
    const expBuf14 = createExportItemsBuffer([
      { name: 'EXPORT ONLY ITEM', barcode: '8901111222233' }
    ]);
    const stockBuf14 = createStockReportBuffer([
      { name: 'EXPORT ONLY ITEM', closingQty: 10 },
      { name: 'STOCK DETAIL ONLY GHOST', closingQty: 50 } // In Stock Detail but absent from Export Items
    ]);
    const mp14 = makeDualMultipartBody(expBuf14, 'ghost_exp.xlsx', stockBuf14, 'ghost_stock.xls');
    const res14 = await apiFetch(`${BASE_URL}/admin/upload-export-items`, {
      method: 'POST',
      headers: { 'Content-Type': mp14.contentType, 'Authorization': `Bearer ${token}` },
      body: mp14.body
    });
    const data14 = await res14.json();
    assert(data14.summary.activeProductCount === 1, 'Only Export Items product retained (ghost item ignored)');

    // =========================================================================
    // SCENARIO 15: Applying blank barcode exclusion before final publication
    // =========================================================================
    console.log('\n[Scenario 15/25] Applying blank barcode exclusion before final publication...');
    const expBuf15 = createExportItemsBuffer([
      { name: 'VALID BARCODE ITEM', barcode: '8901515151515' },
      { name: 'BLANK BARCODE ITEM', barcode: '' }
    ]);
    const stockBuf15 = createStockReportBuffer([
      { name: 'VALID BARCODE ITEM', closingQty: 10 },
      { name: 'BLANK BARCODE ITEM', closingQty: 10 }
    ]);
    const mp15 = makeDualMultipartBody(expBuf15, 'blank_exp.xlsx', stockBuf15, 'blank_stock.xls');
    const res15 = await apiFetch(`${BASE_URL}/admin/upload-export-items`, {
      method: 'POST',
      headers: { 'Content-Type': mp15.contentType, 'Authorization': `Bearer ${token}` },
      body: mp15.body
    });
    const data15 = await res15.json();
    assert(data15.summary.blankBarcodesExcluded === 1, 'Excluded blank barcode row');
    assert(data15.summary.activeProductCount === 1, 'Only valid barcoded item retained');

    // =========================================================================
    // SCENARIO 16: Resolving barcode conflicts before publication
    // =========================================================================
    console.log('\n[Scenario 16/25] Resolving barcode conflicts before publication...');
    const expBuf16 = createExportItemsBuffer([
      { name: 'ROW A ITEM', barcode: '8901616161616', mrp: 50, salePrice: 45 },
      { name: 'ROW B ITEM', barcode: '8901616161616', mrp: 60, salePrice: 55 }
    ]);
    const stockBuf16 = createStockReportBuffer([
      { name: 'ROW A ITEM', closingQty: 5 },
      { name: 'ROW B ITEM', closingQty: 5 }
    ]);
    const mp16 = makeDualMultipartBody(expBuf16, 'conflict_exp.xlsx', stockBuf16, 'conflict_stock.xls');
    const res16 = await apiFetch(`${BASE_URL}/admin/upload-export-items`, {
      method: 'POST',
      headers: { 'Content-Type': mp16.contentType, 'Authorization': `Bearer ${token}` },
      body: mp16.body
    });
    const data16 = await res16.json();
    assert(data16.duplicateConflicts.length === 1, 'Conflict flagged for duplicate barcode');
    
    // Attempt publication without resolution -> blocked
    const pubBlock = await apiFetch(`${BASE_URL}/admin/publish-catalogue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ sessionId: data16.sessionId })
    });
    assert(pubBlock.status === 400, 'Publish blocked while conflict remains unresolved');

    // =========================================================================
    // SCENARIO 17: Retrieving WQ only for eligible active wholesale products
    // =========================================================================
    console.log('\n[Scenario 17/25] Retrieving WQ only for eligible active wholesale products...');
    await db.run(
      `INSERT OR REPLACE INTO wholesale_quantities (original_name, normalized_name, wholesale_qty, last_modified_source)
       VALUES ('ACTIVE WHOLESALE PROD', 'ACTIVE WHOLESALE PROD', 8, 'TEST_SEED')`
    );
    const expBuf17 = createExportItemsBuffer([
      { name: 'ACTIVE WHOLESALE PROD', barcode: '8901717171717', mrp: 100, salePrice: 90, wholesalePrice: 80 }
    ]);
    const stockBuf17 = createStockReportBuffer([
      { name: 'ACTIVE WHOLESALE PROD', closingQty: 20 }
    ]);
    const mp17 = makeDualMultipartBody(expBuf17, 'wq_exp.xlsx', stockBuf17, 'wq_stock.xls');
    const res17 = await apiFetch(`${BASE_URL}/admin/upload-export-items`, {
      method: 'POST',
      headers: { 'Content-Type': mp17.contentType, 'Authorization': `Bearer ${token}` },
      body: mp17.body
    });
    const data17 = await res17.json();
    assert(data17.wholesaleItems.length === 1, '1 active wholesale item passed to review');
    assert(data17.wholesaleItems[0].status === 'MATCHED', 'Retrieved WQ from repository');
    assert(data17.wholesaleItems[0].wholesaleQty === 8, 'Matched WQ is 8');

    // =========================================================================
    // SCENARIO 18: Not requesting WQ for inactive products
    // =========================================================================
    console.log('\n[Scenario 18/25] Not requesting WQ for inactive products...');
    const expBuf18 = createExportItemsBuffer([
      { name: 'INACTIVE WHOLESALE PROD', barcode: '8901818181818', mrp: 120, salePrice: 110, wholesalePrice: 95 }
    ]);
    const stockBuf18 = createStockReportBuffer([
      { name: 'SOME OTHER ITEM', closingQty: 5 } // Inactive wholesale prod absent from stock report
    ]);
    const mp18 = makeDualMultipartBody(expBuf18, 'inact_wp_exp.xlsx', stockBuf18, 'inact_wp_stock.xls');
    const res18 = await apiFetch(`${BASE_URL}/admin/upload-export-items`, {
      method: 'POST',
      headers: { 'Content-Type': mp18.contentType, 'Authorization': `Bearer ${token}` },
      body: mp18.body
    });
    const data18 = await res18.json();
    assert(data18.wholesaleItems.length === 0, 'Inactive product NOT presented in Wholesale Review table');

    // =========================================================================
    // SCENARIO 19: Keeping the WQ repository intact when a product becomes inactive
    // =========================================================================
    console.log('\n[Scenario 19/25] Keeping WQ repository intact when product becomes inactive...');
    await db.run(
      `INSERT OR REPLACE INTO wholesale_quantities (original_name, normalized_name, wholesale_qty, last_modified_source)
       VALUES ('PERSISTENT REPO ITEM', 'PERSISTENT REPO ITEM', 12, 'TEST_SEED')`
    );
    // Publish a session where PERSISTENT REPO ITEM is inactive
    const expBuf19 = createExportItemsBuffer([
      { name: 'CURRENTLY ACTIVE ITEM', barcode: '8901919191919', mrp: 30, salePrice: 28 },
      { name: 'PERSISTENT REPO ITEM', barcode: '8901919191920', mrp: 60, salePrice: 55, wholesalePrice: 48 }
    ]);
    const stockBuf19 = createStockReportBuffer([
      { name: 'CURRENTLY ACTIVE ITEM', closingQty: 10 } // PERSISTENT REPO ITEM absent
    ]);
    const mp19 = makeDualMultipartBody(expBuf19, 'persist_exp.xlsx', stockBuf19, 'persist_stock.xls');
    const res19 = await apiFetch(`${BASE_URL}/admin/upload-export-items`, {
      method: 'POST',
      headers: { 'Content-Type': mp19.contentType, 'Authorization': `Bearer ${token}` },
      body: mp19.body
    });
    const data19 = await res19.json();
    const pubRes19 = await apiFetch(`${BASE_URL}/admin/publish-catalogue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ sessionId: data19.sessionId })
    });
    assert(pubRes19.status === 200, 'Published active catalogue without inactive item');

    const checkRepo19 = await db.get(
      'SELECT wholesale_qty FROM wholesale_quantities WHERE normalized_name = ?',
      'PERSISTENT REPO ITEM'
    );
    assert(checkRepo19 && checkRepo19.wholesale_qty === 12, 'WQ repository preserved quantity (12) for inactive item');

    // =========================================================================
    // SCENARIO 20: Recovering its saved WQ when it becomes active again
    // =========================================================================
    console.log('\n[Scenario 20/25] Recovering saved WQ when product becomes active again...');
    const expBuf20 = createExportItemsBuffer([
      { name: 'PERSISTENT REPO ITEM', barcode: '8901919191920', mrp: 60, salePrice: 55, wholesalePrice: 48 }
    ]);
    const stockBuf20 = createStockReportBuffer([
      { name: 'PERSISTENT REPO ITEM', closingQty: 14 } // Now present and active!
    ]);
    const mp20 = makeDualMultipartBody(expBuf20, 'react_exp.xlsx', stockBuf20, 'react_stock.xls');
    const res20 = await apiFetch(`${BASE_URL}/admin/upload-export-items`, {
      method: 'POST',
      headers: { 'Content-Type': mp20.contentType, 'Authorization': `Bearer ${token}` },
      body: mp20.body
    });
    const data20 = await res20.json();
    assert(data20.wholesaleItems.length === 1, 'Item is now active and in wholesale review');
    assert(data20.wholesaleItems[0].status === 'MATCHED', 'Status recovered as MATCHED');
    assert(data20.wholesaleItems[0].wholesaleQty === 12, 'Recovered exact saved WQ (12)');

    // =========================================================================
    // SCENARIO 21: Correct final six-column compilation
    // =========================================================================
    console.log('\n[Scenario 21/25] Correct final six-column compilation...');
    const compRes = await apiFetch(`${BASE_URL}/admin/export-compiled-catalogue/${data20.sessionId}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    assert(compRes.status === 200, 'Compiled catalogue download returns HTTP 200');
    const compBlob = await compRes.arrayBuffer();
    const compWb = XLSX.read(Buffer.from(compBlob), { type: 'buffer' });
    const compWs = compWb.Sheets[compWb.SheetNames[0]];
    const compRows = XLSX.utils.sheet_to_json(compWs, { header: 1 }) as any[][];
    assert(
      JSON.stringify(compRows[0]) === JSON.stringify(['Barcode', 'Product Name', 'MRP', 'Sale Price', 'Wholesale Price', 'Wholesale Qty']),
      'Exact 6-column compilation structure verified'
    );

    // =========================================================================
    // SCENARIO 22: Upload history records both filenames and reconciliation counts
    // =========================================================================
    console.log('\n[Scenario 22/25] Upload history records both filenames & reconciliation counts...');
    // Publish session 20
    await apiFetch(`${BASE_URL}/admin/publish-catalogue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ sessionId: data20.sessionId })
    });

    const histRes = await apiFetch(`${BASE_URL}/admin/upload-history`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const history = await histRes.json();
    assert(Array.isArray(history) && history.length > 0, 'Retrieved upload history');
    const latest = history[0];
    assert(latest.exportFilename === 'react_exp.xlsx', 'Recorded export filename');
    assert(latest.stockDetailFilename === 'react_stock.xls', 'Recorded stock detail filename');
    assert(typeof latest.activeProducts === 'number', 'Recorded active products count');
    assert(typeof latest.inactiveProducts === 'number', 'Recorded inactive products count');

    // =========================================================================
    // SCENARIO 23: Aborting on invalid/empty Stock Detail without changing active catalogue
    // =========================================================================
    console.log('\n[Scenario 23/25] Aborting on invalid Stock Detail without changing active catalogue...');
    const countBefore = (await db.get('SELECT COUNT(*) as cnt FROM products')).cnt;
    const invalidStockBuf = Buffer.from('Corrupted garbage non-excel data');
    const mp23 = makeDualMultipartBody(expBuf1, 'exp23.xlsx', invalidStockBuf, 'corrupt.xls');
    const res23 = await apiFetch(`${BASE_URL}/admin/upload-export-items`, {
      method: 'POST',
      headers: { 'Content-Type': mp23.contentType, 'Authorization': `Bearer ${token}` },
      body: mp23.body
    });
    assert(res23.status === 400, 'Invalid Stock Detail returns HTTP 400');
    const countAfter = (await db.get('SELECT COUNT(*) as cnt FROM products')).cnt;
    assert(countBefore === countAfter, 'Active catalogue records preserved completely unchanged');

    // =========================================================================
    // SCENARIO 24: Atomic rollback on publication failure
    // =========================================================================
    console.log('\n[Scenario 24/25] Atomic rollback on publication failure...');
    const pubFailRes = await apiFetch(`${BASE_URL}/admin/publish-catalogue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ sessionId: 'non-existent-session-id' })
    });
    assert(pubFailRes.status === 404, 'Non-existent session rejected with HTTP 404');
    const countAfterFail = (await db.get('SELECT COUNT(*) as cnt FROM products')).cnt;
    assert(countBefore === countAfterFail, 'Products count completely preserved after failed publish call');

    // =========================================================================
    // SCENARIO 25: Regression tests for barcode lookup & scanner functionality
    // =========================================================================
    console.log('\n[Scenario 25/25] Regression tests for barcode lookup & scanner...');
    const lookupRes = await apiFetch(`${BASE_URL}/products/lookup/8901919191920`);
    assert(lookupRes.status === 200, 'Customer lookup returns HTTP 200 OK');
    const lookupData = await lookupRes.json();
    assert(lookupData.products.length === 1, 'Product found by barcode');
    const prod = lookupData.products[0];
    assert(prod.mrp === 60 && prod.salePrice === 55, 'Correct MRP and retail sale price');
    assert(!('wholesalePrice' in prod) && !('wholesaleQty' in prod), 'Wholesale fields strictly omitted from public customer response');

    // Admin lookup with Bearer token preserves wholesale fields
    const adminLookup = await apiFetch(`${BASE_URL}/products/lookup/8901919191920`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const adminData = await adminLookup.json();
    assert(adminData.products[0].wholesalePrice === 48, 'Admin authorized lookup retains wholesalePrice');
    assert(adminData.products[0].wholesaleQty === 12, 'Admin authorized lookup retains wholesaleQty');

  } catch (err: any) {
    console.error('Fatal error during test suite execution:', err);
    failed++;
  }

  console.log('\n================================================================');
  console.log(`   DUAL-FILE SUITE RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runExportWorkflowTests()
  .then(() => closeDb())
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
