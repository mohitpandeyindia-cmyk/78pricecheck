import { Router, Request, Response } from 'express';
import { getDb, initializeDatabase, resetDatabase } from '../db';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';
import * as XLSX from 'xlsx';
import multer from 'multer';
import path from 'path';
import fs from 'fs';

const router = Router();

// GET /api/admin/setup-status - Check if system database is initialized
router.get('/admin/setup-status', async (req: Request, res: Response): Promise<void> => {
  try {
    const db = await getDb();
    
    const setupCompletedRow = await db.get(
      'SELECT value FROM system_settings WHERE key = ?',
      'setup_completed'
    );
    
    const lastSetupDateRow = await db.get(
      'SELECT value FROM system_settings WHERE key = ?',
      'last_setup_date'
    );

    const isSetup = setupCompletedRow?.value === '1';

    res.json({
      setupCompleted: isSetup,
      lastUpdated: lastSetupDateRow?.value || null,
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: 'Failed to retrieve setup status',
      error: error.message || error,
    });
  }
});

// POST /api/admin/setup - Initialize database schema and optionally seed sample products
router.get('/admin/setup', (req: Request, res: Response) => {
  res.status(405).json({
    success: false,
    message: 'Method Not Allowed. Use POST to execute setup.',
  });
});

router.post('/admin/setup', authenticateToken, async (req: Request, res: Response): Promise<void> => {
  if (process.env.NODE_ENV === 'production') {
    res.status(403).json({
      success: false,
      message: 'Forbidden. Database setup reset endpoint is disabled in production.'
    });
    return;
  }

  try {
    // Run DB schema reset and seed default products
    await resetDatabase();

    res.json({
      success: true,
      message: 'System database initialized and seeded with sample products successfully.',
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: 'Database setup initialization failed',
      error: error.message || error,
    });
  }
});

// Configure Multer memory storage with 20MB limit and .xlsx filter
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 20 * 1024 * 1024 // 20 MB limit
  },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext !== '.xlsx') {
      cb(new Error('Only .xlsx spreadsheet files are allowed.'));
      return;
    }
    cb(null, true);
  }
});

// GET /api/admin/template - Download the blank Excel product catalogue template
router.get('/admin/template', (req: Request, res: Response): void => {
  try {
    const wb = XLSX.utils.book_new();
    const headers = [['Barcode', 'Product Name', 'MRP', 'Sale Price', 'Wholesale Price', 'Wholesale Qty']];
    const ws = XLSX.utils.aoa_to_sheet(headers);
    XLSX.utils.book_append_sheet(wb, ws, 'Template');
    
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=78pricecheck_template.xlsx');
    res.send(buffer);
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: 'Failed to generate Excel template',
      error: error.message || error
    });
  }
});

// POST /api/admin/upload - Transactional product catalogue replacement
router.post('/admin/upload', authenticateToken, (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      res.status(400).json({
        success: false,
        message: err.message || 'File upload failed.'
      });
      return;
    }
    next();
  });
}, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const uploadStart = Date.now();
  try {
    if (!req.file) {
      res.status(400).json({ success: false, message: 'Excel file is required.' });
      return;
    }

    let workbook;
    try {
      workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    } catch (err: any) {
      res.status(400).json({ success: false, message: 'Invalid Excel file format.' });
      return;
    }

    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const rows: any[][] = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '' });

    if (rows.length === 0) {
      res.status(400).json({ success: false, message: 'Uploaded sheet is empty.' });
      return;
    }

    // Header validation (case-insensitive column match)
    const headers = rows[0].map(h => String(h).trim().toLowerCase());
    const expectedHeadersBase = ['barcode', 'product name', 'mrp', 'sale price'];
    const expectedHeadersFull = ['barcode', 'product name', 'mrp', 'sale price', 'wholesale price', 'wholesale qty'];

    const matchesBase = headers.length === 4 && expectedHeadersBase.every((val, index) => val === headers[index]);
    const matchesFull = headers.length === 6 && expectedHeadersFull.every((val, index) => val === headers[index]);

    if (!matchesBase && !matchesFull) {
      res.status(400).json({
        success: false,
        message: 'Header mismatch. Expected headers (case-insensitive): Barcode, Product Name, MRP, Sale Price [, Wholesale Price, Wholesale Qty]'
      });
      return;
    }

    const errors: { row: number; barcode: string; name: string; error: string }[] = [];
    const validatedProducts: { barcode: string; name: string; mrp: number; salePrice: number; wholesalePrice: number | null; wholesaleQty: number | null; discountPercent: number }[] = [];
    const seenBarcodes = new Map<string, number>(); // barcode -> row index (1-based)
    
    const validationStart = Date.now();

    // Row-by-row validation
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      // Skip trailing empty rows
      if (row.length === 0 || row.every(val => val === null || val === undefined || String(val).trim() === '')) {
        continue;
      }

      const rawBarcode = row[0];
      const rawName = row[1];
      const rawMrp = row[2];
      const rawSalePrice = row[3];
      const rawWholesalePrice = row[4];
      const rawWholesaleQty = row[5];

      const barcode = rawBarcode !== undefined && rawBarcode !== null ? String(rawBarcode).trim() : '';
      if (barcode === '') {
        errors.push({
          row: i + 1,
          barcode: '',
          name: rawName ? String(rawName).trim() : '',
          error: 'Barcode must not be empty.'
        });
        continue;
      }

      const name = rawName !== undefined && rawName !== null ? String(rawName).trim() : '';
      if (name === '') {
        errors.push({
          row: i + 1,
          barcode,
          name: '',
          error: 'Product Name must not be empty.'
        });
        continue;
      }

      // Check for duplicate barcode inside the Excel spreadsheet itself
      if (seenBarcodes.has(barcode)) {
        const previousRow = seenBarcodes.get(barcode)!;
        errors.push({
          row: i + 1,
          barcode,
          name,
          error: `Duplicate barcode "${barcode}" found in the uploaded file (previously on row ${previousRow}).`
        });
        continue;
      }
      seenBarcodes.set(barcode, i + 1);

      const mrp = Number(rawMrp);
      if (isNaN(mrp) || mrp < 0) {
        errors.push({
          row: i + 1,
          barcode,
          name,
          error: `MRP must be zero or greater. Found: "${rawMrp}"`
        });
        continue;
      }

      const salePrice = Number(rawSalePrice);
      if (isNaN(salePrice) || salePrice < 0) {
        errors.push({
          row: i + 1,
          barcode,
          name,
          error: `Sale Price must be zero or greater. Found: "${rawSalePrice}"`
        });
        continue;
      }

      if (salePrice > mrp) {
        errors.push({
          row: i + 1,
          barcode,
          name,
          error: `Sale Price (₹${salePrice}) must not exceed MRP (₹${mrp}).`
        });
        continue;
      }

      // Wholesale validations
      const hasWholesalePrice = rawWholesalePrice !== undefined && rawWholesalePrice !== null && String(rawWholesalePrice).trim() !== '';
      const hasWholesaleQty = rawWholesaleQty !== undefined && rawWholesaleQty !== null && String(rawWholesaleQty).trim() !== '';

      if (hasWholesalePrice && !hasWholesaleQty) {
        errors.push({
          row: i + 1,
          barcode,
          name,
          error: 'Wholesale Qty is required when Wholesale Price is provided.'
        });
        continue;
      }

      if (!hasWholesalePrice && hasWholesaleQty) {
        errors.push({
          row: i + 1,
          barcode,
          name,
          error: 'Wholesale Price is required when Wholesale Qty is provided.'
        });
        continue;
      }

      let wholesalePrice: number | null = null;
      let wholesaleQty: number | null = null;

      if (hasWholesalePrice && hasWholesaleQty) {
        wholesalePrice = Number(rawWholesalePrice);
        if (isNaN(wholesalePrice) || wholesalePrice <= 0) {
          errors.push({
            row: i + 1,
            barcode,
            name,
            error: `Wholesale Price must be greater than zero. Found: "${rawWholesalePrice}"`
          });
          continue;
        }

        if (wholesalePrice >= salePrice) {
          errors.push({
            row: i + 1,
            barcode,
            name,
            error: `Wholesale Price (₹${wholesalePrice}) must be strictly less than Sale Price (₹${salePrice}).`
          });
          continue;
        }

        if (wholesalePrice > mrp) {
          errors.push({
            row: i + 1,
            barcode,
            name,
            error: `Wholesale Price (₹${wholesalePrice}) must be less than or equal to MRP (₹${mrp}).`
          });
          continue;
        }

        wholesaleQty = Number(rawWholesaleQty);
        if (isNaN(wholesaleQty) || !Number.isInteger(wholesaleQty)) {
          errors.push({
            row: i + 1,
            barcode,
            name,
            error: `Wholesale Qty must be an integer. Found: "${rawWholesaleQty}"`
          });
          continue;
        }

        if (wholesaleQty < 2) {
          errors.push({
            row: i + 1,
            barcode,
            name,
            error: `Wholesale Qty must be 2 or more. Found: "${rawWholesaleQty}"`
          });
          continue;
        }
      }

      const discountPercent = mrp > 0 ? Math.round(((mrp - salePrice) / mrp) * 100 * 10) / 10 : 0.0;
      validatedProducts.push({ barcode, name, mrp, salePrice, wholesalePrice, wholesaleQty, discountPercent });
    }

    const validationTime = Date.now() - validationStart;
    const filename = req.file.originalname;
    const uploadedBy = req.admin!.username;
    const totalRows = rows.length - 1; // excluding header
    const db = await getDb();

    // Reject entire upload if any row validation fails
    if (errors.length > 0) {
      const uploadTime = Date.now() - uploadStart;
      const totalTime = Date.now() - uploadStart;
      
      console.log(`[Upload Performance - FAILED] Rows: ${totalRows}, Upload Time: ${uploadTime}ms, Validation Time: ${validationTime}ms, Import Time: 0ms, Total Time: ${totalTime}ms`);

      await db.run(
        `INSERT INTO upload_history 
         (filename, uploaded_by, total_rows, successful_rows, failed_rows, status, processing_time_ms, error_details) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        filename,
        uploadedBy,
        totalRows,
        0,
        errors.length,
        'Failed',
        totalTime,
        JSON.stringify(errors)
      );

      res.status(400).json({
        success: false,
        summary: {
          totalRows,
          successfulRows: 0,
          failedRows: errors.length,
          processingTimeMs: totalTime,
          status: 'Failed'
        },
        errors
      });
      return;
    }

    // Success flow - transactionally delete and replace catalog
    const importStart = Date.now();
    await db.run('BEGIN TRANSACTION');
    try {
      await db.run('DELETE FROM products');

      const insertStmt = await db.prepare(
        `INSERT INTO products (barcode, name, sale_price, mrp, wholesale_price, wholesale_qty, discount_percent, updated_at) 
         VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
      );

      for (const p of validatedProducts) {
        await insertStmt.run(p.barcode, p.name, p.salePrice, p.mrp, p.wholesalePrice, p.wholesaleQty, p.discountPercent);
      }

      await insertStmt.finalize();
      await db.run('COMMIT');

      // Refresh the precomputed hot deals cache table after successful transaction commit
      const { refreshHotDeals } = require('../services/hotDealsService');
      await refreshHotDeals(db);
    } catch (txError: any) {
      await db.run('ROLLBACK');
      throw txError;
    }
    const importTime = Date.now() - importStart;
    const uploadTime = Date.now() - uploadStart;
    const totalTime = Date.now() - uploadStart;

    console.log(`[Upload Performance - SUCCESS] Rows: ${totalRows}, Upload Time: ${uploadTime}ms, Validation Time: ${validationTime}ms, Import Time: ${importTime}ms, Total Time: ${totalTime}ms`);

    // Save successful run to upload history
    await db.run(
      `INSERT INTO upload_history 
       (filename, uploaded_by, total_rows, successful_rows, failed_rows, status, processing_time_ms, error_details) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      filename,
      uploadedBy,
      totalRows,
      totalRows,
      0,
      'Success',
      totalTime,
      null
    );

    res.json({
      success: true,
      totalRows,
      successfulRows: totalRows,
      failedRows: 0,
      processingTimeMs: totalTime
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: 'Catalogue upload import execution failed',
      error: error.message || error
    });
  }
});

// GET /api/admin/upload-history - Retrieve upload execution logs
router.get('/admin/upload-history', authenticateToken, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const db = await getDb();
    const history = await db.all(
      `SELECT id, filename, uploaded_by as uploadedBy, total_rows as totalRows, 
              successful_rows as successfulRows, failed_rows as failedRows, 
              status, processing_time_ms as processingTimeMs, uploaded_at as uploadedAt 
       FROM upload_history 
       ORDER BY uploaded_at DESC`
    );
    res.json(history);
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: 'Failed to retrieve upload history logs',
      error: error.message || error
    });
  }
});

// GET /api/admin/upload-errors/:id - Download CSV format validation errors
router.get('/admin/upload-errors/:id', authenticateToken, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const db = await getDb();
    const run = await db.get(
      'SELECT filename, error_details FROM upload_history WHERE id = ?',
      req.params.id
    );

    if (!run) {
      res.status(404).json({ success: false, message: 'Upload history log not found.' });
      return;
    }

    if (!run.error_details) {
      res.status(400).json({ success: false, message: 'This upload succeeded and has no error details.' });
      return;
    }

    const errors = JSON.parse(run.error_details);

    let csv = 'Row,Barcode,Product Name,Error Description\n';
    for (const err of errors) {
      const escapedName = `"${String(err.name).replace(/"/g, '""')}"`;
      const escapedErr = `"${String(err.error).replace(/"/g, '""')}"`;
      csv += `${err.row},${err.barcode},${escapedName},${escapedErr}\n`;
    }

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=upload_errors_${req.params.id}.csv`);
    res.send(csv);
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: 'Failed to generate error report CSV',
      error: error.message || error
    });
  }
});

// GET /api/admin/analytics - Retrieve scan analytics dashboard metrics
router.get('/admin/analytics', authenticateToken, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { getAdminAnalytics } = require('../services/analyticsService');
    const daysLimit = req.query.days === '30' ? 30 : 7;
    const analytics = await getAdminAnalytics(daysLimit);
    res.json(analytics);
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: 'Failed to retrieve scan analytics',
      error: error.message || error
    });
  }
});

// GET /api/admin/analytics/devices - Retrieve persistent device analytics
router.get('/admin/analytics/devices', authenticateToken, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { getDeviceAnalytics } = require('../services/analyticsService');
    const period = typeof req.query.period === 'string' ? req.query.period : 'today';
    const analytics = await getDeviceAnalytics(period);
    res.json(analytics);
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: 'Failed to retrieve device analytics',
      error: error.message || error
    });
  }
});

// Configure Multer disk storage for inventory analysis uploads (.xls and .xlsx files)
const inventoryUploadDir = path.resolve(__dirname, '../../../uploads');
if (!fs.existsSync(inventoryUploadDir)) {
  fs.mkdirSync(inventoryUploadDir, { recursive: true });
}

const inventoryStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, inventoryUploadDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.xls';
    cb(null, `inv-${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
  }
});

const uploadInventoryFiles = multer({
  storage: inventoryStorage,
  limits: {
    fileSize: 50 * 1024 * 1024 // 50MB limit
  },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext !== '.xls' && ext !== '.xlsx') {
      cb(new Error(`Invalid file type "${file.originalname}". Only .xls and .xlsx spreadsheet files are allowed.`));
      return;
    }
    cb(null, true);
  }
}).fields([
  { name: 'saleReport', maxCount: 1 },
  { name: 'stockDetail', maxCount: 1 }
]);

// POST /api/admin/inventory/analyze - Run inventory reorder analysis
router.post('/admin/inventory/analyze', authenticateToken, (req: Request, res: Response, next) => {
  uploadInventoryFiles(req, res, (err: any) => {
    if (err) {
      res.status(400).json({ error: err.message || 'File upload failed.' });
      return;
    }
    next();
  });
}, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const files = req.files as { [fieldname: string]: Express.Multer.File[] } | undefined;
  const saleReportFile = files?.['saleReport']?.[0];
  const stockDetailFile = files?.['stockDetail']?.[0];

  if (!saleReportFile || !stockDetailFile) {
    if (saleReportFile?.path && fs.existsSync(saleReportFile.path)) {
      try { fs.unlinkSync(saleReportFile.path); } catch (e) { /* ignore */ }
    }
    if (stockDetailFile?.path && fs.existsSync(stockDetailFile.path)) {
      try { fs.unlinkSync(stockDetailFile.path); } catch (e) { /* ignore */ }
    }
    res.status(400).json({ error: 'Both Sale Report and Stock Detail Report files are required.' });
    return;
  }

  const saleReportPath = saleReportFile.path;
  const stockDetailPath = stockDetailFile.path;

  try {
    const config: any = {};
    if (req.body.leadTimeDays !== undefined && req.body.leadTimeDays !== '') {
      const val = Number(req.body.leadTimeDays);
      if (!isNaN(val) && val > 0) config.leadTimeDays = val;
    }
    if (req.body.reviewFrequencyDays !== undefined && req.body.reviewFrequencyDays !== '') {
      const val = Number(req.body.reviewFrequencyDays);
      if (!isNaN(val) && val > 0) config.reviewFrequencyDays = val;
    }
    if (req.body.orderCoverageDays !== undefined && req.body.orderCoverageDays !== '') {
      const val = Number(req.body.orderCoverageDays);
      if (!isNaN(val) && val > 0) config.orderCoverageDays = val;
    } else if (req.body.planningHorizonDays !== undefined && req.body.planningHorizonDays !== '') {
      const val = Number(req.body.planningHorizonDays);
      if (!isNaN(val) && val > 0) config.orderCoverageDays = val;
    }
    if (req.body.serviceLevel !== undefined && req.body.serviceLevel !== '') {
      const val = Number(req.body.serviceLevel);
      if (!isNaN(val)) config.serviceLevel = val;
    }
    if (req.body.watchThresholdFactor !== undefined && req.body.watchThresholdFactor !== '') {
      const val = Number(req.body.watchThresholdFactor);
      if (!isNaN(val) && val >= 1.0) config.watchThresholdFactor = val;
    }
    if (req.body.useTrendAdjustedDemand !== undefined) {
      config.useTrendAdjustedDemand = req.body.useTrendAdjustedDemand === 'true' || req.body.useTrendAdjustedDemand === true;
    }

    // Pass master catalog MRP lookup map from SQLite products table
    try {
      const db = await getDb();
      const catalogProducts = await db.all('SELECT name, mrp FROM products WHERE mrp IS NOT NULL AND mrp > 0');
      const masterCatalogMap = new Map<string, number>();
      for (const p of catalogProducts) {
        if (p.name) masterCatalogMap.set(p.name.trim().toUpperCase(), Number(p.mrp));
      }
      config.masterCatalogMap = masterCatalogMap;
    } catch (e) {
      // Non-blocking fallback if products table query fails
    }

    const inventoryAnalysisPath = path.resolve(__dirname, '../../../inventory-analysis');
    const { runAnalysis } = require(inventoryAnalysisPath);

    const result = runAnalysis({ saleReportPath, stockDetailPath }, config);
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'Inventory analysis failed.' });
  } finally {
    // Clean up uploaded temp files
    if (saleReportPath && fs.existsSync(saleReportPath)) {
      try { fs.unlinkSync(saleReportPath); } catch (e) { /* ignore */ }
    }
    if (stockDetailPath && fs.existsSync(stockDetailPath)) {
      try { fs.unlinkSync(stockDetailPath); } catch (e) { /* ignore */ }
    }
  }
});

// GET /api/admin/inventory/mappings - Retrieve persistent name resolution ledger decisions
router.get('/admin/inventory/mappings', authenticateToken, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const inventoryAnalysisPath = path.resolve(__dirname, '../../../inventory-analysis/nameResolver');
    const { CatalogLedger } = require(inventoryAnalysisPath);
    const ledger = new CatalogLedger();
    res.json({
      success: true,
      merges: ledger.getAllMerges(),
      separates: ledger.getAllSeparates()
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message || 'Failed to retrieve mappings.' });
  }
});

// POST /api/admin/inventory/mappings/decision - Save human approval (MERGE or KEEP_SEPARATE)
router.post('/admin/inventory/mappings/decision', authenticateToken, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { action, rawName, canonicalName, itemA, itemB } = req.body;
    const inventoryAnalysisPath = path.resolve(__dirname, '../../../inventory-analysis/nameResolver');
    const { CatalogLedger } = require(inventoryAnalysisPath);
    const ledger = new CatalogLedger();

    if (action === 'MERGE') {
      if (!rawName || !canonicalName) {
        res.status(400).json({ success: false, error: 'rawName and canonicalName are required for MERGE action.' });
        return;
      }
      ledger.recordMerge(rawName, canonicalName, 'MANUAL');
      res.json({ success: true, message: `Merged "${rawName}" into "${canonicalName}".` });
    } else if (action === 'KEEP_SEPARATE') {
      if (!itemA || !itemB) {
        res.status(400).json({ success: false, error: 'itemA and itemB are required for KEEP_SEPARATE action.' });
        return;
      }
      ledger.recordKeepSeparate(itemA, itemB);
      res.json({ success: true, message: `Recorded KEEP_SEPARATE decision for "${itemA}" and "${itemB}".` });
    } else {
      res.status(400).json({ success: false, error: 'Invalid action. Must be MERGE or KEEP_SEPARATE.' });
    }
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message || 'Failed to record decision.' });
  }
});

// DELETE /api/admin/inventory/mappings/decision - Remove a decision from ledger
router.delete('/admin/inventory/mappings/decision', authenticateToken, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { rawName, itemA, itemB } = req.body;
    const inventoryAnalysisPath = path.resolve(__dirname, '../../../inventory-analysis/nameResolver');
    const { CatalogLedger } = require(inventoryAnalysisPath);
    const ledger = new CatalogLedger();

    if (itemA && itemB) {
      ledger.removeDecision(itemA, itemB);
      res.json({ success: true, message: `Removed KEEP_SEPARATE decision for "${itemA}" and "${itemB}".` });
    } else if (rawName) {
      ledger.removeDecision(rawName);
      res.json({ success: true, message: `Removed MERGE decision for "${rawName}".` });
    } else {
      res.status(400).json({ success: false, error: 'rawName or itemA/itemB required.' });
    }
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message || 'Failed to remove decision.' });
  }
});

export default router;
