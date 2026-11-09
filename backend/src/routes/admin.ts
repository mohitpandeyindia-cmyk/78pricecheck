import { Router, Request, Response } from 'express';
import { getDb, initializeDatabase, resetDatabase, normalizeProductName } from '../db';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';
import * as XLSX from 'xlsx';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { randomUUID } from 'crypto';

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

// Configure Multer memory storage with 30MB limit and .xlsx/.xls filter
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 30 * 1024 * 1024 // 30 MB limit
  },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext !== '.xlsx' && ext !== '.xls') {
      cb(new Error('Only .xlsx and .xls spreadsheet files are allowed.'));
      return;
    }
    cb(null, true);
  }
});

export interface ConflictCandidate {
  candidateId: string;
  rowNumber: number;
  barcode: string;
  name: string;
  mrp: number;
  salePrice: number;
  wholesalePrice: number | null;
}

export interface DuplicateConflictGroup {
  barcode: string;
  candidates: ConflictCandidate[];
  status: 'PENDING' | 'RESOLVED' | 'EXCLUDED';
  selectedCandidateId: string | 'EXCLUDE' | null;
}

export interface StagedProduct {
  barcode: string;
  name: string;
  normalizedName: string;
  mrp: number;
  salePrice: number;
  wholesalePrice: number | null;
  wholesaleQty: number | null;
  discountPercent: number;
  isWholesale: boolean;
  status: 'REQUIRED' | 'MATCHED' | 'AMBIGUOUS';
}

export interface StagingSession {
  sessionId: string;
  filename: string;
  uploadedBy: string;
  createdAt: number;
  totalSourceRows: number;
  blankBarcodesExcluded: number;
  duplicateBarcodesCount: number;
  duplicateConflicts: DuplicateConflictGroup[];
  conflicts: { barcode: string; name: string; error: string }[];
  allProducts: StagedProduct[];
  wholesaleItems: StagedProduct[];
}

export const stagingSessions = new Map<string, StagingSession>();

function cleanupOldSessions() {
  const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
  for (const [id, s] of stagingSessions.entries()) {
    if (s.createdAt < twoHoursAgo) {
      stagingSessions.delete(id);
    }
  }
}

export async function processExportItemsBuffer(buffer: Buffer, filename: string, username: string) {
  cleanupOldSessions();
  const db = await getDb();
  let workbook;
  try {
    workbook = XLSX.read(buffer, { type: 'buffer' });
  } catch (err: any) {
    throw new Error('Invalid Excel file format.');
  }

  const sheetName = workbook.SheetNames[0];
  const worksheet = workbook.Sheets[sheetName];
  const rows: any[][] = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '' });

  if (rows.length === 0) {
    throw new Error('Uploaded sheet is empty.');
  }

  const rawHeaders = rows[0].map((h: any) => String(h).trim());
  const lowerHeaders = rawHeaders.map((h: string) => h.toLowerCase());

  const findHeader = (exactList: string[], fallbackFn: (h: string) => boolean) => {
    const exact = lowerHeaders.findIndex((h: string) => exactList.includes(h));
    if (exact !== -1) return exact;
    return lowerHeaders.findIndex(fallbackFn);
  };

  const nameIdx = findHeader(['item name*', 'item name', 'product name'], h => h.startsWith('item name') || h.includes('product name'));
  const codeIdx = findHeader(['item code', 'barcode', 'item barcode'], h => h.includes('item code') || h.includes('barcode'));
  const mrpIdx = findHeader(['default mrp', 'mrp', 'default_mrp'], h => h.includes('mrp'));
  const saleIdx = findHeader(['sale price', 'sale', 'sales price', 'sale_price'], h => h.includes('sale') && !h.includes('wholesale'));
  const wpIdx = findHeader(['wholesale price', 'wholesale', 'wp', 'wholesale_price'], h => h.includes('wholesale') || h === 'wp');

  if (codeIdx === -1 || nameIdx === -1) {
    throw new Error('Header mismatch. Vyapar Export Items must contain "Item name" and "Item code" columns.');
  }

  let blankBarcodesExcluded = 0;
  const conflicts: { barcode: string; name: string; error: string }[] = [];
  const barcodeMap = new Map<string, { firstCand: ConflictCandidate; identicalCount: number; conflicting: ConflictCandidate[] }>();

  const totalSourceRows = rows.length - 1;

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (r.length === 0 || r.every((v: any) => v === null || v === undefined || String(v).trim() === '')) {
      continue;
    }

    const rawBarcode = r[codeIdx];
    let barcode = '';
    if (rawBarcode !== undefined && rawBarcode !== null) {
      if (typeof rawBarcode === 'number') {
        barcode = Number.isInteger(rawBarcode) ? BigInt(Math.trunc(rawBarcode)).toString() : String(rawBarcode).trim();
      } else {
        barcode = String(rawBarcode).trim();
      }
    }
    if (!barcode) {
      blankBarcodesExcluded++;
      continue;
    }

    const rawName = r[nameIdx];
    const name = rawName !== undefined && rawName !== null ? String(rawName).trim() : '';
    if (!name) {
      conflicts.push({
        barcode,
        name: '',
        error: `Row ${i + 1}: Product name is missing.`
      });
      continue;
    }

    const rawMrp = mrpIdx !== -1 ? r[mrpIdx] : 0;
    const mrp = !isNaN(Number(rawMrp)) ? Number(rawMrp) : 0;

    const rawSalePrice = saleIdx !== -1 ? r[saleIdx] : 0;
    const salePrice = !isNaN(Number(rawSalePrice)) ? Number(rawSalePrice) : 0;

    const rawWp = wpIdx !== -1 ? r[wpIdx] : null;
    const hasWp = rawWp !== undefined && rawWp !== null && String(rawWp).trim() !== '' && !isNaN(Number(rawWp)) && Number(rawWp) > 0;
    const wholesalePrice = hasWp ? Number(rawWp) : null;

    const cand: ConflictCandidate = {
      candidateId: `${barcode}_r${i + 1}`,
      rowNumber: i + 1,
      barcode,
      name,
      mrp,
      salePrice,
      wholesalePrice
    };

    if (!barcodeMap.has(barcode)) {
      barcodeMap.set(barcode, { firstCand: cand, identicalCount: 0, conflicting: [] });
    } else {
      const entry = barcodeMap.get(barcode)!;
      const first = entry.firstCand;
      const isIdentical = (first.name === name && first.mrp === mrp && first.salePrice === salePrice && first.wholesalePrice === wholesalePrice);
      if (isIdentical) {
        entry.identicalCount++;
      } else {
        entry.conflicting.push(cand);
      }
    }
  }

  let duplicateBarcodesCount = 0;
  const duplicateConflicts: DuplicateConflictGroup[] = [];
  const stagedProducts: StagedProduct[] = [];
  const wholesaleProducts: StagedProduct[] = [];

  for (const [barcode, entry] of barcodeMap.entries()) {
    if (entry.identicalCount > 0) {
      duplicateBarcodesCount += entry.identicalCount;
    }

    if (entry.conflicting.length > 0) {
      // Conflicting duplicates: administrator must choose or exclude
      duplicateBarcodesCount += entry.conflicting.length;
      duplicateConflicts.push({
        barcode,
        candidates: [entry.firstCand, ...entry.conflicting],
        status: 'PENDING',
        selectedCandidateId: null
      });
    } else {
      // Clean, non-conflicting product
      const p = entry.firstCand;
      const discountPercent = p.mrp > 0 ? Math.round(((p.mrp - p.salePrice) / p.mrp) * 100 * 10) / 10 : 0.0;
      const normalizedName = normalizeProductName(p.name);
      const hasWp = p.wholesalePrice !== null && p.wholesalePrice > 0;

      let wholesaleQty: number | null = null;
      let status: 'REQUIRED' | 'MATCHED' | 'AMBIGUOUS' = 'MATCHED';

      if (hasWp) {
        const matches = await db.all(
          'SELECT wholesale_qty FROM wholesale_quantities WHERE normalized_name = ?',
          normalizedName
        );
        if (matches && matches.length === 1 && matches[0].wholesale_qty >= 1) {
          wholesaleQty = matches[0].wholesale_qty;
          status = 'MATCHED';
        } else if (matches && matches.length > 1) {
          const uniqueQtys = [...new Set(matches.map((m: any) => m.wholesale_qty))];
          if (uniqueQtys.length === 1 && uniqueQtys[0] >= 1) {
            wholesaleQty = uniqueQtys[0];
            status = 'MATCHED';
          } else {
            wholesaleQty = null;
            status = 'AMBIGUOUS';
          }
        } else {
          wholesaleQty = null;
          status = 'REQUIRED';
        }
      }

      const product: StagedProduct = {
        barcode: p.barcode,
        name: p.name,
        normalizedName,
        mrp: p.mrp,
        salePrice: p.salePrice,
        wholesalePrice: p.wholesalePrice,
        wholesaleQty,
        discountPercent,
        isWholesale: hasWp,
        status
      };

      stagedProducts.push(product);
      if (hasWp) {
        wholesaleProducts.push(product);
      }
    }
  }

  // Sort wholesaleProducts: REQUIRED first, then AMBIGUOUS, then MATCHED
  wholesaleProducts.sort((a, b) => {
    const order: Record<string, number> = { 'REQUIRED': 1, 'AMBIGUOUS': 2, 'MATCHED': 3 };
    const diff = (order[a.status] || 99) - (order[b.status] || 99);
    if (diff !== 0) return diff;
    return a.name.localeCompare(b.name);
  });

  const matchedCount = wholesaleProducts.filter(p => p.status === 'MATCHED').length;
  const missingCount = wholesaleProducts.filter(p => p.status === 'REQUIRED').length;
  const ambiguousCount = wholesaleProducts.filter(p => p.status === 'AMBIGUOUS').length;

  const sessionId = randomUUID();
  const session: StagingSession = {
    sessionId,
    filename,
    uploadedBy: username,
    createdAt: Date.now(),
    totalSourceRows,
    blankBarcodesExcluded,
    duplicateBarcodesCount,
    duplicateConflicts,
    conflicts,
    allProducts: stagedProducts,
    wholesaleItems: wholesaleProducts
  };

  stagingSessions.set(sessionId, session);

  return {
    sessionId,
    filename,
    summary: {
      totalSourceRows,
      blankBarcodesExcluded,
      duplicateBarcodesCount,
      conflictingBarcodesCount: duplicateConflicts.length,
      totalValidProducts: stagedProducts.length,
      totalWholesaleProducts: wholesaleProducts.length,
      matchedCount,
      missingCount,
      ambiguousCount
    },
    duplicateConflicts,
    wholesaleItems: wholesaleProducts,
    conflicts
  };
}

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

// POST /api/admin/upload-export-items - Parse Vyapar Export Items workbook and prepare staging session
router.post('/admin/upload-export-items', authenticateToken, (req, res, next) => {
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
  try {
    if (!req.file) {
      res.status(400).json({ success: false, message: 'Export Items Excel file is required.' });
      return;
    }

    const username = req.admin!.username;
    const result = await processExportItemsBuffer(req.file.buffer, req.file.originalname, username);

    res.json({
      success: true,
      ...result
    });
  } catch (error: any) {
    res.status(400).json({
      success: false,
      message: error.message || 'Failed to process Export Items spreadsheet.'
    });
  }
});

// POST /api/admin/publish-catalogue - Atomically update PriceCheck catalogue and persist Wholesale Quantities
router.post('/admin/publish-catalogue', authenticateToken, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const startTime = Date.now();
  try {
    const { sessionId, wholesaleUpdates, duplicateResolutions } = req.body;
    if (!sessionId) {
      res.status(400).json({ success: false, message: 'sessionId is required for publishing catalogue.' });
      return;
    }

    const session = stagingSessions.get(sessionId);
    if (!session) {
      res.status(404).json({ success: false, message: 'Staging session expired or not found. Please upload the file again.' });
      return;
    }

    // Map wholesaleUpdates if provided: [{ normalizedName, originalName, wholesaleQty }]
    const updatesMap = new Map<string, { originalName: string; wholesaleQty: number }>();
    if (Array.isArray(wholesaleUpdates)) {
      for (const u of wholesaleUpdates) {
        const norm = u.normalizedName || normalizeProductName(u.originalName);
        const qty = Number(u.wholesaleQty);
        if (!isNaN(qty) && Number.isInteger(qty) && qty >= 1) {
          updatesMap.set(norm, { originalName: u.originalName || norm, wholesaleQty: qty });
        }
      }
    }

    const db = await getDb();

    // 1. Process duplicate barcode conflict resolutions
    const resolutionMap = new Map<string, { barcode: string; action: 'SELECT' | 'EXCLUDE'; candidateId?: string }>();
    if (Array.isArray(duplicateResolutions)) {
      for (const r of duplicateResolutions) {
        if (r && r.barcode && (r.action === 'SELECT' || r.action === 'EXCLUDE')) {
          resolutionMap.set(r.barcode, r);
        }
      }
    }

    const unresolvedConflicts: string[] = [];
    const auditDecisions: any[] = [];

    if (Array.isArray(session.duplicateConflicts) && session.duplicateConflicts.length > 0) {
      for (const conflict of session.duplicateConflicts) {
        const resInfo = resolutionMap.get(conflict.barcode);
        if (!resInfo) {
          unresolvedConflicts.push(conflict.barcode);
          continue;
        }

        if (resInfo.action === 'SELECT') {
          const chosen = conflict.candidates.find(c => c.candidateId === (resInfo as any).candidateId)
            || (typeof (resInfo as any).selectedIndex === 'number' ? conflict.candidates[(resInfo as any).selectedIndex] : undefined);
          if (!chosen) {
            unresolvedConflicts.push(conflict.barcode);
            continue;
          }

          conflict.status = 'RESOLVED';
          conflict.selectedCandidateId = chosen.candidateId;

          const discountPercent = chosen.mrp > 0 ? Math.round(((chosen.mrp - chosen.salePrice) / chosen.mrp) * 100 * 10) / 10 : 0.0;
          const normalizedName = normalizeProductName(chosen.name);
          const hasWp = chosen.wholesalePrice !== null && chosen.wholesalePrice > 0;
          let wholesaleQty: number | null = null;
          let status: 'REQUIRED' | 'MATCHED' | 'AMBIGUOUS' = 'MATCHED';

          if (hasWp) {
            if (updatesMap.has(normalizedName)) {
              wholesaleQty = updatesMap.get(normalizedName)!.wholesaleQty;
              status = 'MATCHED';
            } else {
              const matches = await db.all(
                'SELECT wholesale_qty FROM wholesale_quantities WHERE normalized_name = ?',
                normalizedName
              );
              if (matches && matches.length === 1 && matches[0].wholesale_qty >= 1) {
                wholesaleQty = matches[0].wholesale_qty;
                status = 'MATCHED';
              } else {
                wholesaleQty = null;
                status = 'REQUIRED';
              }
            }
          }

          const stagedProd: StagedProduct = {
            barcode: chosen.barcode,
            name: chosen.name,
            normalizedName,
            mrp: chosen.mrp,
            salePrice: chosen.salePrice,
            wholesalePrice: chosen.wholesalePrice,
            wholesaleQty,
            discountPercent,
            isWholesale: hasWp,
            status
          };

          // Check if not already in allProducts
          if (!session.allProducts.some(p => p.barcode === stagedProd.barcode)) {
            session.allProducts.push(stagedProd);
            if (hasWp) {
              session.wholesaleItems.push(stagedProd);
            }
          }

          auditDecisions.push({
            barcode: chosen.barcode,
            resolution: 'SELECTED',
            selectedRow: chosen.rowNumber,
            productName: chosen.name,
            mrp: chosen.mrp,
            salePrice: chosen.salePrice,
            wholesalePrice: chosen.wholesalePrice
          });
        } else if (resInfo.action === 'EXCLUDE') {
          conflict.status = 'EXCLUDED';
          conflict.selectedCandidateId = 'EXCLUDE';
          auditDecisions.push({
            barcode: conflict.barcode,
            resolution: 'EXCLUDED',
            reason: 'Administrator excluded conflicting duplicate barcode'
          });
        }
      }
    }

    if (unresolvedConflicts.length > 0) {
      res.status(400).json({
        success: false,
        error: `Cannot publish catalogue: ${unresolvedConflicts.length} conflicting duplicate barcode(s) remain unresolved: ${unresolvedConflicts.join(', ')}. Administrator must select the correct row or explicitly exclude each duplicate.`,
        message: `Cannot publish catalogue: ${unresolvedConflicts.length} conflicting duplicate barcode(s) remain unresolved: ${unresolvedConflicts.join(', ')}. Administrator must select the correct row or explicitly exclude each duplicate.`,
        unresolvedBarcodes: unresolvedConflicts.slice(0, 10)
      });
      return;
    }

    // Apply updates and validate that all wholesale products have valid quantities
    const missingItems: string[] = [];
    const ambiguousItems: string[] = [];
    let manualCount = 0;

    for (const item of session.wholesaleItems) {
      if (updatesMap.has(item.normalizedName)) {
        item.wholesaleQty = updatesMap.get(item.normalizedName)!.wholesaleQty;
        item.status = 'MATCHED';
        manualCount++;
      } else if (item.status === 'AMBIGUOUS') {
        ambiguousItems.push(item.name);
      } else if (item.wholesaleQty === null || item.wholesaleQty < 1) {
        missingItems.push(item.name);
      }
    }

    if (ambiguousItems.length > 0) {
      res.status(400).json({
        success: false,
        message: `Cannot publish catalogue: ${ambiguousItems.length} wholesale item(s) have ambiguous matches that must be reviewed and resolved before publication.`,
        ambiguousItems: ambiguousItems.slice(0, 10)
      });
      return;
    }

    if (missingItems.length > 0) {
      res.status(400).json({
        success: false,
        message: `Cannot publish catalogue: ${missingItems.length} wholesale item(s) are missing valid wholesale quantities (must be positive integer >= 1).`,
        missingItems: missingItems.slice(0, 10)
      });
      return;
    }

    // Also update allProducts with new wholesaleQty
    for (const p of session.allProducts) {
      if (p.isWholesale && updatesMap.has(p.normalizedName)) {
        p.wholesaleQty = updatesMap.get(p.normalizedName)!.wholesaleQty;
      }
    }

    let savedWqCount = 0;

    await db.run('BEGIN TRANSACTION');
    try {
      // 1. Upsert updated wholesale quantities
      if (updatesMap.size > 0) {
        for (const [norm, data] of updatesMap.entries()) {
          const checkExisting = await db.all(
            'SELECT id FROM wholesale_quantities WHERE normalized_name = ?',
            norm
          );
          if (checkExisting.length > 0) {
            await db.run(
              `UPDATE wholesale_quantities 
               SET wholesale_qty = ?, updated_at = CURRENT_TIMESTAMP, last_modified_source = 'MANUAL_REVIEW'
               WHERE normalized_name = ?`,
              data.wholesaleQty,
              norm
            );
          } else {
            await db.run(
              `INSERT INTO wholesale_quantities 
               (original_name, normalized_name, wholesale_qty, created_at, updated_at, last_modified_source)
               VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'MANUAL_REVIEW')`,
              data.originalName,
              norm,
              data.wholesaleQty
            );
          }
          savedWqCount++;
        }
      }

      // 2. Replace products table atomically
      await db.run('DELETE FROM products');
      const insertStmt = await db.prepare(
        `INSERT INTO products 
         (barcode, name, sale_price, mrp, wholesale_price, wholesale_qty, discount_percent, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
      );

      for (const p of session.allProducts) {
        await insertStmt.run(
          p.barcode,
          p.name,
          p.salePrice,
          p.mrp,
          p.wholesalePrice,
          p.wholesaleQty,
          p.discountPercent
        );
      }
      await insertStmt.finalize();

      const version = Date.now().toString();
      await db.run('INSERT OR REPLACE INTO system_settings (key, value) VALUES (?, ?)', 'setup_completed', '1');
      await db.run('INSERT OR REPLACE INTO system_settings (key, value) VALUES (?, ?)', 'last_catalog_upload', new Date().toISOString());
      await db.run('INSERT OR REPLACE INTO system_settings (key, value) VALUES (?, ?)', 'catalog_version', version);

      const processingTime = Date.now() - startTime;

      const combinedAuditDetails = [
        ...auditDecisions,
        ...(session.conflicts || [])
      ];

      // 3. Log to upload_history
      await db.run(
        `INSERT INTO upload_history 
         (filename, uploaded_by, total_rows, successful_rows, failed_rows, status, processing_time_ms, error_details,
          blank_barcodes, duplicate_barcodes, wholesale_products, wholesale_matched, wholesale_manual, wholesale_saved)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        session.filename,
        session.uploadedBy,
        session.totalSourceRows,
        session.allProducts.length,
        0,
        'Success',
        processingTime,
        combinedAuditDetails.length > 0 ? JSON.stringify(combinedAuditDetails) : null,
        session.blankBarcodesExcluded,
        session.duplicateBarcodesCount,
        session.wholesaleItems.length,
        session.wholesaleItems.length - manualCount,
        manualCount,
        savedWqCount
      );

      await db.run('COMMIT');

      // Refresh hot deals cache
      const { refreshHotDeals } = require('../services/hotDealsService');
      await refreshHotDeals(db);

      // Clean up staging session
      stagingSessions.delete(sessionId);

      res.json({
        success: true,
        message: 'Product catalogue published successfully.',
        totalProducts: session.allProducts.length,
        totalWholesaleProducts: session.wholesaleItems.length,
        wholesaleSaved: savedWqCount,
        processingTimeMs: processingTime,
        catalogVersion: version
      });
    } catch (txErr: any) {
      await db.run('ROLLBACK');
      throw txErr;
    }
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: 'Failed to publish catalogue',
      error: error.message || error
    });
  }
});

// GET /api/admin/export-compiled-catalogue/:sessionId - Download compiled 6-column catalogue Excel
router.get('/admin/export-compiled-catalogue/:sessionId', authenticateToken, (req: AuthenticatedRequest, res: Response): void => {
  try {
    const { sessionId } = req.params;
    const session = stagingSessions.get(sessionId);
    if (!session) {
      res.status(404).json({ success: false, message: 'Session not found or expired.' });
      return;
    }

    const headers = ['Barcode', 'Product Name', 'MRP', 'Sale Price', 'Wholesale Price', 'Wholesale Qty'];
    const dataRows = session.allProducts.map(p => [
      p.barcode,
      p.name,
      p.mrp,
      p.salePrice,
      p.wholesalePrice !== null ? p.wholesalePrice : '',
      p.wholesaleQty !== null ? p.wholesaleQty : ''
    ]);

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([headers, ...dataRows]);
    XLSX.utils.book_append_sheet(wb, ws, 'Products');

    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=COMPILED_CATALOGUE_${Date.now()}.xlsx`);
    res.send(buffer);
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: 'Failed to generate compiled catalogue file',
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

    // If file is a Vyapar Export Items workbook, route seamlessly through the Export Items processor
    if (headers.some(h => h.startsWith('item name') || h === 'item code')) {
      const username = req.admin!.username;
      const result = await processExportItemsBuffer(req.file.buffer, req.file.originalname, username);
      res.json({
        success: true,
        isExportItems: true,
        ...result
      });
      return;
    }

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
              status, processing_time_ms as processingTimeMs, uploaded_at as uploadedAt,
              error_details as errorDetails,
              COALESCE(blank_barcodes, 0) as blankBarcodes,
              COALESCE(duplicate_barcodes, 0) as duplicateBarcodes,
              COALESCE(wholesale_products, 0) as wholesaleProducts,
              COALESCE(wholesale_matched, 0) as wholesaleMatched,
              COALESCE(wholesale_manual, 0) as wholesaleManual,
              COALESCE(wholesale_saved, 0) as wholesaleSaved
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
  { name: 'stockDetail', maxCount: 1 },
  { name: 'purchaseReport', maxCount: 1 },
  { name: 'mrpMaster', maxCount: 1 }
]);

const uploadSingleMrpMaster = multer({
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
}).single('mrpMaster');

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
  const purchaseReportFile = files?.['purchaseReport']?.[0];

  if (!saleReportFile || !stockDetailFile) {
    if (saleReportFile?.path && fs.existsSync(saleReportFile.path)) {
      try { fs.unlinkSync(saleReportFile.path); } catch (e) { /* ignore */ }
    }
    if (stockDetailFile?.path && fs.existsSync(stockDetailFile.path)) {
      try { fs.unlinkSync(stockDetailFile.path); } catch (e) { /* ignore */ }
    }
    if (purchaseReportFile?.path && fs.existsSync(purchaseReportFile.path)) {
      try { fs.unlinkSync(purchaseReportFile.path); } catch (e) { /* ignore */ }
    }
    res.status(400).json({ error: 'Both Sale Report and Stock Detail Report files are required.' });
    return;
  }

  const saleReportPath = saleReportFile.path;
  const stockDetailPath = stockDetailFile.path;
  const purchaseReportPath = purchaseReportFile?.path || undefined;
  const mrpMasterFile = files?.['mrpMaster']?.[0];

  try {
    // If an accompanying MRP Master was uploaded, save and register it immediately
    if (mrpMasterFile?.path && fs.existsSync(mrpMasterFile.path)) {
      try {
        const mrpMasterModule = path.resolve(__dirname, '../../../inventory-analysis/mrpMaster');
        const { saveUploadedMrpMaster } = require(mrpMasterModule);
        saveUploadedMrpMaster({
          tempFilePath: mrpMasterFile.path,
          originalFilename: mrpMasterFile.originalname
        });
      } catch (mrpErr) {
        console.warn('Failed to parse accompanying mrpMaster file during analysis:', mrpErr);
      }
    }

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

    const result = runAnalysis({ saleReportPath, stockDetailPath, purchaseReportPath }, config);
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
    if (purchaseReportPath && fs.existsSync(purchaseReportPath)) {
      try { fs.unlinkSync(purchaseReportPath); } catch (e) { /* ignore */ }
    }
    if (mrpMasterFile?.path && fs.existsSync(mrpMasterFile.path)) {
      try { fs.unlinkSync(mrpMasterFile.path); } catch (e) { /* ignore */ }
    }
  }
});

// GET /api/admin/inventory/mrp-master/status - Retrieve current MRP Master status
router.get('/admin/inventory/mrp-master/status', authenticateToken, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const mrpMasterModule = path.resolve(__dirname, '../../../inventory-analysis/mrpMaster');
    const { getMrpMasterStatus } = require(mrpMasterModule);
    const status = getMrpMasterStatus();
    res.json({ success: true, ...status });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message || 'Failed to retrieve MRP Master status.' });
  }
});

// POST /api/admin/inventory/mrp-master - Upload, parse, and persist MRP Master file
router.post('/admin/inventory/mrp-master', authenticateToken, (req: Request, res: Response, next) => {
  uploadSingleMrpMaster(req, res, (err: any) => {
    if (err) {
      res.status(400).json({ success: false, error: err.message || 'File upload failed.' });
      return;
    }
    next();
  });
}, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const file = req.file;
  if (!file) {
    res.status(400).json({ success: false, error: 'No MRP Master file uploaded.' });
    return;
  }

  try {
    const mrpMasterModule = path.resolve(__dirname, '../../../inventory-analysis/mrpMaster');
    const { saveUploadedMrpMaster } = require(mrpMasterModule);
    const result = saveUploadedMrpMaster({
      tempFilePath: file.path,
      originalFilename: file.originalname
    });
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message || 'Failed to parse MRP Master file.' });
  } finally {
    if (file?.path && fs.existsSync(file.path)) {
      try { fs.unlinkSync(file.path); } catch (e) { /* ignore */ }
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
