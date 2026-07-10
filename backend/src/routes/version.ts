import { Router, Request, Response } from 'express';
import { getDb } from '../db';

const router = Router();

// GET /api/version - Returns application and system versions
router.get('/version', async (req: Request, res: Response): Promise<void> => {
  try {
    const db = await getDb();
    const lastUpload = await db.get(
      `SELECT id, uploaded_at 
       FROM upload_history 
       WHERE status = 'Success' 
       ORDER BY id DESC LIMIT 1`
    );

    let catalogVersion = 'empty';
    let lastCatalogUpload: string | null = null;

    if (lastUpload) {
      // SQLite default format: YYYY-MM-DD HH:MM:SS
      const datePart = lastUpload.uploaded_at.split(' ')[0].replace(/-/g, ''); // YYYYMMDD
      const sequence = String(lastUpload.id).padStart(3, '0');
      catalogVersion = `${datePart}-${sequence}`;
      
      // Convert SQLite UTC date to ISO string
      lastCatalogUpload = new Date(lastUpload.uploaded_at + ' UTC').toISOString();
    }

    const countRow = await db.get('SELECT COUNT(*) as count FROM products');
    const productsCount = countRow ? countRow.count : 0;

    res.json({
      application: '78 PriceCheck',
      version: '0.3.0',
      databaseVersion: '3',
      catalogVersion,
      lastCatalogUpload,
      productsCount
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: 'Failed to retrieve version info',
      error: error.message || error
    });
  }
});

// GET /api/health - Returns system health status
router.get('/health', async (req: Request, res: Response): Promise<void> => {
  try {
    const db = await getDb();
    await db.get('SELECT 1');
    
    res.json({
      status: "ok",
      database: "connected",
      version: "1.0.0"
    });
  } catch (error) {
    res.status(500).json({
      status: "error",
      database: "disconnected",
      version: "1.0.0"
    });
  }
});

export default router;
